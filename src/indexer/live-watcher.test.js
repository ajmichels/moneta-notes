import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    mkdtempSync, writeFileSync, utimesSync, mkdirSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { processPath } from './daemon.js';
import { deleteNoteByPath, deleteNotesByPathPrefix, createDebouncer, createFsWatcher } from './live-watcher.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-live-watcher-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

function writeNote(vaultRoot, relativePath, content, mtimeSec) {
    const filePath = join(vaultRoot, relativePath);
    writeFileSync(filePath, content, 'utf8');
    if (mtimeSec !== undefined) {
        utimesSync(filePath, mtimeSec, mtimeSec);
    }
    return filePath;
}

function fakeChunkText(body) {
    return body.length === 0 ? [] : [ {
        chunkIndex: 0, charStart: 0, charEnd: body.length,
        lineStart: 1, lineEnd: body.split('\n').length, tokenCount: 1,
    } ];
}

async function fakeEmbed() {
    return new Float32Array(1024).fill(0.1);
}

function baseDeps() {
    return {
        chunkText: fakeChunkText,
        embed: fakeEmbed,
        embeddingModel: 'test-model',
        embeddingVersion: 'v1',
    };
}

describe('deleteNoteByPath', () => {
    it('removes chunks, chunk_vectors, notes_fts, note_tags, and note_links for the note', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Full.md', '#project note body, see [[Other]]', 1000);
        await processPath(vaultRoot, db, 'Full.md', baseDeps());
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Full.md');

        deleteNoteByPath(db, 'Full.md');

        expect(db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id)).toBeUndefined();
        expect(db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id)).toHaveLength(0);
        expect(db.prepare('SELECT * FROM chunk_vectors').all()).toHaveLength(0);
        expect(db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'project'").get()).toBeUndefined();
        expect(db.prepare('SELECT * FROM note_tags WHERE note_id = ?').all(note.id)).toHaveLength(0);
        expect(db.prepare('SELECT * FROM note_links WHERE source_note_id = ?').all(note.id)).toHaveLength(0);
    });

    it('removes an orphaned tags row when deleting the last note that carried it (fixes #1)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Solo.md', '#onlyhere note body', 1000);
        await processPath(vaultRoot, db, 'Solo.md', baseDeps());

        deleteNoteByPath(db, 'Solo.md');

        const tagNames = db.prepare('SELECT name FROM tags').all().map((r) => r.name);
        expect(tagNames).toEqual([]);
    });

    it('leaves a still-referenced tag alone when deleting one of several notes carrying it', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'One.md', '#shared note body', 1000);
        writeNote(vaultRoot, 'Two.md', '#shared other body', 1000);
        await processPath(vaultRoot, db, 'One.md', baseDeps());
        await processPath(vaultRoot, db, 'Two.md', baseDeps());

        deleteNoteByPath(db, 'One.md');

        const tagNames = db.prepare('SELECT name FROM tags').all().map((r) => r.name);
        expect(tagNames).toEqual([ 'shared' ]);
    });

    it('is a safe no-op for a path with no matching notes row', () => {
        const db = makeTestDb();
        expect(() => deleteNoteByPath(db, 'NoSuchNote.md')).not.toThrow();
    });
});

describe('deleteNotesByPathPrefix', () => {
    function insertNote(db, path) {
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run(path, 'hash', 1, 1000, 1000);
    }

    it('deletes every note at or nested under the given alias prefix', () => {
        const db = makeTestDb();
        insertNote(db, 'Memory/Note.md');
        insertNote(db, 'Memory/sub/Deep.md');
        insertNote(db, 'Memory');
        insertNote(db, 'Other.md');

        const count = deleteNotesByPathPrefix(db, 'Memory');

        expect(count).toBe(3);
        expect(db.prepare('SELECT path FROM notes').all().map((r) => r.path)).toEqual([ 'Other.md' ]);
    });

    it('does not match a differently-named path that merely shares the prefix string', () => {
        const db = makeTestDb();
        insertNote(db, 'MemoryOverflow.md');

        const count = deleteNotesByPathPrefix(db, 'Memory');

        expect(count).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n).toBe(1);
    });

    it('is a safe no-op when nothing matches', () => {
        const db = makeTestDb();
        expect(deleteNotesByPathPrefix(db, 'Memory')).toBe(0);
    });
});

describe('createDebouncer', () => {
    it('fires onSettle once after debounceMs of quiet for a path', () => {
        let scheduled = null;
        const settled = [];
        const debouncer = createDebouncer((path) => settled.push(path), {
            debounceMs: 15000,
            scheduleFn: (fn, ms) => { scheduled = { fn, ms }; return 'timer'; },
            cancelFn: () => {},
        });

        debouncer.notify('A.md');

        expect(scheduled.ms).toBe(15000);
        expect(settled).toEqual([]);
        scheduled.fn();
        expect(settled).toEqual([ 'A.md' ]);
    });

    it('resets the timer on repeated notify() calls for the same path, cancelling the previous one', () => {
        const cancelled = [];
        let timerCount = 0;
        const debouncer = createDebouncer(() => {}, {
            scheduleFn: () => { timerCount += 1; return `timer-${timerCount}`; },
            cancelFn: (id) => cancelled.push(id),
        });

        debouncer.notify('A.md');
        debouncer.notify('A.md');
        debouncer.notify('A.md');

        expect(cancelled).toEqual([ 'timer-1', 'timer-2' ]);
    });

    it('tracks independent timers per path', () => {
        const scheduledFns = {};
        const settled = [];
        const debouncer = createDebouncer((path) => settled.push(path), {
            scheduleFn: (fn) => { scheduledFns[fn.name || Math.random()] = fn; return fn; },
            cancelFn: () => {},
        });

        debouncer.notify('A.md');
        debouncer.notify('B.md');

        for (const fn of Object.values(scheduledFns)) {
            fn();
        }
        expect(settled.sort()).toEqual([ 'A.md', 'B.md' ]);
    });

    it('cancelAll() cancels every pending timer', () => {
        const cancelled = [];
        const debouncer = createDebouncer(() => {}, {
            scheduleFn: () => 'timer',
            cancelFn: (id) => cancelled.push(id),
        });

        debouncer.notify('A.md');
        debouncer.notify('B.md');
        debouncer.cancelAll();

        expect(cancelled).toEqual([ 'timer', 'timer' ]);
    });
});

describe('createFsWatcher (real binary): symlinked directories', () => {
    async function waitForQueuedPath(db, path) {
        await vi.waitFor(() => {
            expect(db.prepare('SELECT path FROM index_queue WHERE path = ?').get(path)).toBeDefined();
        }, { timeout: 5000, interval: 50 });
    }

    it('registers a pre-existing symlinked directory and live-watches its contents', async () => {
        const vaultRoot = makeTempVault();
        const externalDir = makeTempVault();
        mkdirSync(join(externalDir, 'sub'));
        symlinkSync(externalDir, join(vaultRoot, 'Memory'));
        const db = makeTestDb();

        const watcher = createFsWatcher(vaultRoot, db, { debounceMs: 300 });
        try {
            // Lets the per-symlink fswatch child actually start before we write — same reasoning
            // as fswatch-watcher.test.js's own settle delay for the main-watcher case.
            await new Promise((resolve) => setTimeout(resolve, 500));
            writeNote(externalDir, 'sub/New.md', 'content', undefined);
            await waitForQueuedPath(db, 'Memory/sub/New.md');
        } finally {
            watcher.stop();
        }
    }, 10000);

    it('discovers a symlinked directory created after the watcher has already started', async () => {
        const vaultRoot = makeTempVault();
        const externalDir = makeTempVault();
        writeNote(externalDir, 'Existing.md', 'content', 1000);
        const db = makeTestDb();

        const watcher = createFsWatcher(vaultRoot, db, { debounceMs: 300 });
        try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            symlinkSync(externalDir, join(vaultRoot, 'Memory'));
            await waitForQueuedPath(db, 'Memory/Existing.md');
        } finally {
            watcher.stop();
        }
    }, 10000);

    it('purges indexed notes when a registered symlink is removed live', async () => {
        const vaultRoot = makeTempVault();
        const externalDir = makeTempVault();
        writeNote(externalDir, 'Note.md', 'content', 1000);
        symlinkSync(externalDir, join(vaultRoot, 'Memory'));
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Memory/Note.md', 'hash', 1, 1000, 1000);

        const watcher = createFsWatcher(vaultRoot, db, { debounceMs: 300 });
        try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            unlinkSync(join(vaultRoot, 'Memory'));
            await vi.waitFor(() => {
                expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n).toBe(0);
            }, { timeout: 5000, interval: 50 });
        } finally {
            watcher.stop();
        }
    }, 10000);
});
