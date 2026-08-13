import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { getLogger, runWithLogger } from '../logger.js';
import { enqueuePath, dequeueNextPath, processPath, deleteNoteByPath } from './daemon.js';

const tempDirs = [];

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
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
    return body.length === 0 ? [] : [ { chunkIndex: 0, charStart: 0, charEnd: body.length, tokenCount: 1 } ];
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

describe('enqueuePath / dequeueNextPath', () => {
    it('dedupes a re-enqueued path, preserving its original enqueued_at', () => {
        const db = makeTestDb();

        enqueuePath(db, 'A.md', 1000);
        enqueuePath(db, 'A.md', 2000);

        const row = db.prepare('SELECT * FROM index_queue WHERE path = ?').get('A.md');
        expect(row.enqueued_at).toBe(1000);
    });

    it('dequeues the earliest-eligible path by next_attempt_at then enqueued_at', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Second.md', 2000);
        enqueuePath(db, 'First.md', 1000);

        expect(dequeueNextPath(db, 3000)).toBe('First.md');
    });

    it('skips a path whose next_attempt_at is still in the future', () => {
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)',
        ).run('Future.md', 1000, 999999);
        enqueuePath(db, 'Ready.md', 1000);

        expect(dequeueNextPath(db, 2000)).toBe('Ready.md');
    });

    it('returns null when nothing is eligible', () => {
        const db = makeTestDb();
        expect(dequeueNextPath(db, 1000)).toBeNull();
    });
});

describe('processPath: skip-unchanged', () => {
    it('returns unchanged without reading the file when mtime matches the stored value', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'irrelevant-hash', 1, 1000, 1000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
    });
});

describe('processPath: content changed', () => {
    it('updates mtime only when the hash is unchanged despite a newer mtime (e.g. touch)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'stable body', 1000);
        const raw = 'stable body';
        const { hashContent } = await import('../core/notes.js');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', hashContent(raw), 1, 500, 500);
        utimesSync(join(vaultRoot, 'A.md'), 2000, 2000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
        const row = db.prepare('SELECT mtime FROM notes WHERE path = ?').get('A.md');
        expect(row.mtime).toBe(2000);
    });

    it('reindexes a brand-new note: notes row, chunks, chunk_vectors, notes_fts, tags', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'New Note.md', '---\ntags:\n  - project\n---\nhello world', 1000);

        const result = await processPath(vaultRoot, db, 'New Note.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });

        const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('New Note.md');
        expect(note.mtime).toBe(1000);

        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const vectorRow = db.prepare('SELECT rowid FROM chunk_vectors WHERE rowid = ?').get(chunkRows[0].id);
        expect(vectorRow).toBeDefined();

        const ftsHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").get();
        expect(ftsHit.rowid).toBe(note.id);

        const tagRow = db.prepare(`
            SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ?
        `).get(note.id);
        expect(tagRow.name).toBe('project');
    });

    it('replaces stale chunks/fts/tags rather than appending on a content change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Changing.md', 'original body', 1000);
        await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        writeNote(vaultRoot, 'Changing.md', 'replaced body entirely', 2000);
        const result = await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Changing.md');
        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const staleHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'original'").get();
        expect(staleHit).toBeUndefined();
        const freshHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'replaced'").get();
        expect(freshHit.rowid).toBe(note.id);
    });

    it('logs an info line via the context logger with the note title and chunk count', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-log-'));
        const logger = getLogger('indexer', logDir);
        writeNote(vaultRoot, 'Logged.md', 'body text here', 1000);

        const result = await runWithLogger(logger, () => processPath(vaultRoot, db, 'Logged.md', baseDeps()));

        expect(result).toEqual({ status: 'reindexed' });
        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
            expect(line).toContain('INFO  [indexer] reindexed note');
            expect(line).toContain('note_title="Logged"');
            expect(line).toContain('chunk_count=1');
        });
        rmSync(logDir, { recursive: true, force: true });
    });
});

describe('processPath: idempotent reprocessing', () => {
    it('produces no duplicate chunks/vectors/fts rows when run twice with no file change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Stable.md', 'a stable note body', 1000);

        const first = await processPath(vaultRoot, db, 'Stable.md', baseDeps());
        expect(first.status).toBe('reindexed');

        // Force a re-check by bumping mtime without changing content — the daemon's real trigger for
        // this path (an editor rewriting identical bytes) but exercised directly here since this test
        // is about processPath's idempotency, not the debounce/fswatch layer that would normally cause it.
        utimesSync(join(vaultRoot, 'Stable.md'), 2000, 2000);
        const second = await processPath(vaultRoot, db, 'Stable.md', baseDeps());
        expect(second.status).toBe('unchanged');

        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Stable.md');
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE note_id = ?').get(note.id).count;
        expect(chunkCount).toBe(1);

        const vectorCount = db.prepare('SELECT COUNT(*) AS count FROM chunk_vectors').get().count;
        expect(vectorCount).toBe(1);

        const ftsCount = db.prepare("SELECT COUNT(*) AS count FROM notes_fts WHERE notes_fts MATCH 'stable'").get().count;
        expect(ftsCount).toBe(1);
    });

    it('produces no duplicate rows when the content genuinely changes twice in a row to the same text', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Repeat.md', 'first version', 1000);
        await processPath(vaultRoot, db, 'Repeat.md', baseDeps());

        writeNote(vaultRoot, 'Repeat.md', 'second version', 2000);
        await processPath(vaultRoot, db, 'Repeat.md', baseDeps());

        writeNote(vaultRoot, 'Repeat.md', 'second version', 3000); // rewritten with identical bytes
        const result = await processPath(vaultRoot, db, 'Repeat.md', baseDeps());

        expect(result.status).toBe('unchanged');
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Repeat.md');
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE note_id = ?').get(note.id).count;
        expect(chunkCount).toBe(1);
    });
});

describe('processPath: missing file', () => {
    it('cleans up an existing notes row and returns deleted when the file is gone', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Gone.md', 'will be deleted', 1000);
        await processPath(vaultRoot, db, 'Gone.md', baseDeps());
        rmSync(join(vaultRoot, 'Gone.md'));

        const result = await processPath(vaultRoot, db, 'Gone.md', baseDeps());

        expect(result).toEqual({ status: 'deleted' });
        expect(db.prepare('SELECT id FROM notes WHERE path = ?').get('Gone.md')).toBeUndefined();
    });

    it('returns deleted (no-op) for a stale queue entry with no matching notes row at all', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();

        const result = await processPath(vaultRoot, db, 'NeverExisted.md', baseDeps());

        expect(result).toEqual({ status: 'deleted' });
    });
});

describe('deleteNoteByPath', () => {
    it('removes chunks, chunk_vectors, notes_fts, and note_tags for the note', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Full.md', '#project note body', 1000);
        await processPath(vaultRoot, db, 'Full.md', baseDeps());
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Full.md');

        deleteNoteByPath(db, 'Full.md');

        expect(db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id)).toBeUndefined();
        expect(db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id)).toHaveLength(0);
        expect(db.prepare('SELECT * FROM chunk_vectors').all()).toHaveLength(0);
        expect(db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'project'").get()).toBeUndefined();
        expect(db.prepare('SELECT * FROM note_tags WHERE note_id = ?').all(note.id)).toHaveLength(0);
    });

    it('is a safe no-op for a path with no matching notes row', () => {
        const db = makeTestDb();
        expect(() => deleteNoteByPath(db, 'NoSuchNote.md')).not.toThrow();
    });
});
