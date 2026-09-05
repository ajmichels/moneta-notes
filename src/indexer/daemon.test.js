import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { openDb, getMeta } from '../core/db.js';
import { getLogger, runWithLogger } from '../logger.js';
import {
    enqueuePath, dequeueNextPath, processPath, deleteNoteByPath, recordFailure, drainQueueOnce,
    watermarkCatchup, existenceCheck, createDebouncer, assertFswatchAvailable, spawnFswatch, runReindex,
    createIpcServer, defaultSocketPath, startDaemon, createSerialGate, isDotPath, EXTRACTION_VERSION,
} from './daemon.js';
import { appSupportDir } from '../platform/index.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

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
        db.prepare(`
            INSERT INTO notes (path, content_hash, line_count, mtime, updated_at, extraction_version)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('A.md', 'irrelevant-hash', 1, 1000, 1000, EXTRACTION_VERSION);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
    });

    it('reindexes an mtime-unchanged note when its chunks are stale (embedding_model/version mismatch)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        await processPath(vaultRoot, db, 'A.md', baseDeps());

        const bumpedDeps = { ...baseDeps(), embeddingVersion: 'v2' };
        const result = await processPath(vaultRoot, db, 'A.md', bumpedDeps);

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('A.md');
        const chunkRow = db.prepare('SELECT embedding_version FROM chunks WHERE note_id = ?').get(note.id);
        expect(chunkRow.embedding_version).toBe('v2');
    });

    it('reindexes a hash-unchanged note when its chunks are stale (embedding_model/version mismatch)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        await processPath(vaultRoot, db, 'A.md', baseDeps());
        // Newer mtime with byte-identical content reaches the content_hash skip point (not the
        // earlier mtime one) — this is the "editor rewrote identical bytes" path.
        writeNote(vaultRoot, 'A.md', 'body text', 2000);

        const bumpedDeps = { ...baseDeps(), embeddingVersion: 'v2' };
        const result = await processPath(vaultRoot, db, 'A.md', bumpedDeps);

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('A.md');
        const chunkRow = db.prepare('SELECT embedding_version FROM chunks WHERE note_id = ?').get(note.id);
        expect(chunkRow.embedding_version).toBe('v2');
    });

    it('reindexes an mtime-unchanged note when its extraction_version is stale', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        await processPath(vaultRoot, db, 'A.md', baseDeps());
        db.prepare('UPDATE notes SET extraction_version = 0 WHERE path = ?').run('A.md');

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT extraction_version FROM notes WHERE path = ?').get('A.md');
        expect(note.extraction_version).toBe(EXTRACTION_VERSION);
    });

    it('reindexes a hash-unchanged note when its extraction_version is stale', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        await processPath(vaultRoot, db, 'A.md', baseDeps());
        db.prepare('UPDATE notes SET extraction_version = 0 WHERE path = ?').run('A.md');
        // Newer mtime with byte-identical content reaches the content_hash skip point (not the
        // earlier mtime one) — this is the "editor rewrote identical bytes" path.
        writeNote(vaultRoot, 'A.md', 'body text', 2000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT extraction_version FROM notes WHERE path = ?').get('A.md');
        expect(note.extraction_version).toBe(EXTRACTION_VERSION);
    });
});

describe('processPath: content changed', () => {
    it('updates mtime only when the hash is unchanged despite a newer mtime (e.g. touch)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'stable body', 1000);
        const raw = 'stable body';
        const { hashContent } = await import('../core/notes.js');
        db.prepare(`
            INSERT INTO notes (path, content_hash, line_count, mtime, updated_at, extraction_version)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('A.md', hashContent(raw), 1, 500, 500, EXTRACTION_VERSION);
        utimesSync(join(vaultRoot, 'A.md'), 2000, 2000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
        const row = db.prepare('SELECT mtime FROM notes WHERE path = ?').get('A.md');
        expect(row.mtime).toBe(2000);
    });

    it('reindexes a brand-new note: notes row, chunks, chunk_vectors, notes_fts, tags, links', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(
            vaultRoot, 'New Note.md',
            '---\ntags:\n  - project\nstatus: active\n---\nhello world, see [[Other Note]]', 1000,
        );

        const result = await processPath(vaultRoot, db, 'New Note.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });

        const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('New Note.md');
        expect(note.mtime).toBe(1000);
        expect(note.extraction_version).toBe(EXTRACTION_VERSION);
        expect(JSON.parse(note.metadata_json)).toEqual({ status: 'active' });

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

        const linkRow = db.prepare('SELECT target_title FROM note_links WHERE source_note_id = ?')
            .get(note.id);
        expect(linkRow.target_title).toBe('Other Note');
    });

    it("persists each chunk's line_start/line_end alongside its char offsets", async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Lines.md', 'first line\nsecond line\nthird line', 1000);

        const chunkTextWithLines = (body) => [
            { chunkIndex: 0, charStart: 0, charEnd: 10, lineStart: 1, lineEnd: 1, tokenCount: 2 },
            {
                chunkIndex: 1, charStart: 11, charEnd: body.length,
                lineStart: 2, lineEnd: 3, tokenCount: 4,
            },
        ];

        await processPath(vaultRoot, db, 'Lines.md', { ...baseDeps(), chunkText: chunkTextWithLines });

        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Lines.md');
        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ? ORDER BY chunk_index').all(note.id);
        expect(chunkRows.map((r) => [ r.line_start, r.line_end ])).toEqual([ [ 1, 1 ], [ 2, 3 ] ]);
    });

    it('replaces stale chunks/fts/tags/links rather than appending on a content change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Changing.md', 'original body, links to [[Old Target]]', 1000);
        await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        writeNote(vaultRoot, 'Changing.md', 'replaced body entirely, links to [[New Target]]', 2000);
        const result = await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Changing.md');
        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const staleHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'original'").get();
        expect(staleHit).toBeUndefined();
        const freshHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'replaced'").get();
        expect(freshHit.rowid).toBe(note.id);

        const links = db.prepare('SELECT target_title FROM note_links WHERE source_note_id = ?')
            .all(note.id).map(r => r.target_title);
        expect(links).toEqual([ 'New Target' ]);
    });

    it('overwrites metadata_json in place on a content change, rather than merging', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Changing.md', '---\nstatus: draft\n---\nbody', 1000);
        await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        writeNote(vaultRoot, 'Changing.md', '---\npriority: 3\n---\nbody', 2000);
        await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        const note = db.prepare('SELECT metadata_json FROM notes WHERE path = ?').get('Changing.md');
        expect(JSON.parse(note.metadata_json)).toEqual({ priority: 3 });
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
        await cleanupTempDir(logDir);
    });
});

describe('processPath: idempotent reprocessing', () => {
    it('produces no duplicate chunks/vectors/fts rows when run twice with no file change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Stable.md', 'a stable note body', 1000);

        const first = await processPath(vaultRoot, db, 'Stable.md', baseDeps());
        expect(first.status).toBe('reindexed');

        // Force a re-check by bumping mtime without changing content — the daemon's real trigger
        // (an editor rewriting identical bytes) but exercised directly here since this test is
        // about processPath's idempotency, not the debounce/fswatch layer that triggers it.
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

describe('processPath: dot paths', () => {
    it('purges an already-indexed dot-path note without touching the filesystem', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        mkdirSync(join(vaultRoot, '.obsidian'));
        writeNote(vaultRoot, '.obsidian/workspace.md', 'workspace', 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('.obsidian/workspace.md', 'hash', 1, 1000, 1000);

        const result = await processPath(vaultRoot, db, '.obsidian/workspace.md', baseDeps());

        expect(result).toEqual({ status: 'deleted' });
        expect(db.prepare('SELECT id FROM notes WHERE path = ?').get('.obsidian/workspace.md')).toBeUndefined();
    });

    it('is a no-op for a dot path with no matching notes row', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();

        const result = await processPath(vaultRoot, db, '.git/COMMIT_EDITMSG.md', baseDeps());

        expect(result).toEqual({ status: 'deleted' });
    });
});

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

describe('recordFailure', () => {
    it('schedules the first retry 30s out and increments attempts to 1', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Flaky.md', 1000);

        const result = recordFailure(db, 'Flaky.md', 1000);

        expect(result).toEqual({ permanentlyFailed: false, attempts: 1 });
        const row = db.prepare('SELECT * FROM index_queue WHERE path = ?').get('Flaky.md');
        expect(row.attempts).toBe(1);
        expect(row.next_attempt_at).toBe(1000 + 30000);
    });

    it('follows the full 30s/2m/10m schedule across three consecutive failures', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Flaky.md', 0);

        recordFailure(db, 'Flaky.md', 0);
        const second = recordFailure(db, 'Flaky.md', 0);
        expect(second.attempts).toBe(2);
        let row = db.prepare('SELECT next_attempt_at FROM index_queue WHERE path = ?').get('Flaky.md');
        expect(row.next_attempt_at).toBe(120000);

        const third = recordFailure(db, 'Flaky.md', 0);
        expect(third.attempts).toBe(3);
        row = db.prepare('SELECT next_attempt_at FROM index_queue WHERE path = ?').get('Flaky.md');
        expect(row.next_attempt_at).toBe(600000);
    });

    it('removes the row and reports permanentlyFailed after the 4th attempt', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Flaky.md', 0);

        recordFailure(db, 'Flaky.md', 0);
        recordFailure(db, 'Flaky.md', 0);
        recordFailure(db, 'Flaky.md', 0);
        const fourth = recordFailure(db, 'Flaky.md', 0);

        expect(fourth).toEqual({ permanentlyFailed: true, attempts: 4 });
        expect(db.prepare('SELECT * FROM index_queue WHERE path = ?').get('Flaky.md')).toBeUndefined();
    });

    it('is a safe no-op for a path with no matching queue row', () => {
        const db = makeTestDb();
        expect(recordFailure(db, 'NotQueued.md', 0)).toEqual({ permanentlyFailed: false, attempts: 0 });
    });
});

describe('drainQueueOnce', () => {
    it('processes every eligible path once, removing successes from the queue', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'note a', 1000);
        writeNote(vaultRoot, 'B.md', 'note b', 1000);
        enqueuePath(db, 'A.md', 0);
        enqueuePath(db, 'B.md', 0);

        const summary = await drainQueueOnce(vaultRoot, db, { ...baseDeps(), now: 0 });

        expect(summary).toEqual({ reindexed: 2, skipped: 0, failed: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM index_queue').get().count).toBe(0);
    });

    it('logs a warn per attempt and an error line via the context logger on permanent failure', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-log-'));
        const logger = getLogger('indexer', logDir);
        writeNote(vaultRoot, 'Broken.md', 'body', 1000);
        enqueuePath(db, 'Broken.md', 0);
        const brokenDeps = {
            ...baseDeps(),
            embed: async () => { throw new Error('embedding failed'); },
            now: 0,
        };

        // Exhaust all 4 attempts across 4 drain passes (each pass processes eligible rows once;
        // backoff means a failed row isn't eligible again until its next_attempt_at, so this test
        // forces next_attempt_at back to 0 between passes to reach exhaustion deterministically).
        await runWithLogger(logger, async () => {
            for (let i = 0; i < 4; i += 1) {
                db.prepare('UPDATE index_queue SET next_attempt_at = 0').run();
                await drainQueueOnce(vaultRoot, db, brokenDeps);
            }
        });

        expect(db.prepare('SELECT * FROM index_queue WHERE path = ?').get('Broken.md')).toBeUndefined();
        await vi.waitFor(() => {
            const lines = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim().split('\n');
            const warnLines = lines.filter((line) => line.includes('WARN  [indexer] reindex attempt failed'));
            const errorLines = lines.filter((line) => line.includes('ERROR [indexer] reindex permanently failed'));
            expect(warnLines.length).toBe(3);
            // Each warn line is a fire-and-forget appendFile (S008), so the 3 lines aren't
            // guaranteed to land in call order — find the attempt=1 one, don't assume warnLines[0].
            const firstAttemptLine = warnLines.find((line) => line.includes('attempt=1'));
            expect(firstAttemptLine).toContain('note_title="Broken"');
            expect(firstAttemptLine).toContain('error_message="embedding failed"');
            expect(errorLines).toHaveLength(1);
            expect(errorLines[0]).toContain('note_title="Broken"');
            expect(errorLines[0]).toContain('attempts=4');
            expect(errorLines[0]).toContain('error_message="embedding failed"');
        });
        await cleanupTempDir(logDir);
    });

    it('returns zero counts when the queue is empty', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();

        const summary = await drainQueueOnce(vaultRoot, db, baseDeps());

        expect(summary).toEqual({ reindexed: 0, skipped: 0, failed: 0 });
    });
});

describe('watermarkCatchup', () => {
    it('enqueues every .md file when notes is empty (0 watermark = full first-run index)', () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'a', 1000);
        mkdirSync(join(vaultRoot, 'Weekly Notes'));
        writeNote(vaultRoot, 'Weekly Notes/2026-W32.md', 'w', 1000);
        const db = makeTestDb();

        const count = watermarkCatchup(db, vaultRoot, 2000);

        expect(count).toBe(2);
        const queued = db.prepare('SELECT path FROM index_queue ORDER BY path').all().map((r) => r.path);
        expect(queued).toEqual([ 'A.md', 'Weekly Notes/2026-W32.md' ]);
    });

    it('only enqueues files newer than the current MAX(notes.updated_at) watermark', () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Old.md', 'old', 500);
        writeNote(vaultRoot, 'New.md', 'new', 1500);
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Old.md', 'hash', 1, 500, 1000);

        const count = watermarkCatchup(db, vaultRoot, 2000);

        expect(count).toBe(1);
        expect(db.prepare('SELECT path FROM index_queue').get().path).toBe('New.md');
    });

    it('ignores non-.md files', () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'attachment.png'), 'binary');
        const db = makeTestDb();

        expect(watermarkCatchup(db, vaultRoot, 2000)).toBe(0);
    });

    it('ignores dotfiles and never descends into dot-directories', () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, '.hidden.md', 'hidden', 1000);
        mkdirSync(join(vaultRoot, '.obsidian'));
        writeNote(vaultRoot, '.obsidian/workspace.md', 'workspace', 1000);
        mkdirSync(join(vaultRoot, '.git'));
        writeNote(vaultRoot, '.git/COMMIT_EDITMSG.md', 'commit', 1000);
        writeNote(vaultRoot, 'Visible.md', 'visible', 1000);
        const db = makeTestDb();

        const count = watermarkCatchup(db, vaultRoot, 2000);

        expect(count).toBe(1);
        expect(db.prepare('SELECT path FROM index_queue').get().path).toBe('Visible.md');
    });
});

describe('isDotPath', () => {
    it('flags a dotfile at the vault root', () => {
        expect(isDotPath('.DS_Store')).toBe(true);
    });

    it('flags a path nested under a dot-directory', () => {
        expect(isDotPath('.obsidian/workspace.json')).toBe(true);
    });

    it('flags a deeply nested dot-directory regardless of position', () => {
        expect(isDotPath('Weekly Notes/.trash/2026-W32.md')).toBe(true);
    });

    it('does not flag an ordinary vault-relative path', () => {
        expect(isDotPath('Weekly Notes/2026-W32.md')).toBe(false);
    });
});

describe('existenceCheck', () => {
    it('deletes notes rows whose file no longer exists on disk', () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Gone.md', 'hash', 1, 1000, 1000);
        writeNote(vaultRoot, 'Still Here.md', 'body', 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Still Here.md', 'hash', 1, 1000, 1000);

        const count = existenceCheck(db, vaultRoot);

        expect(count).toBe(1);
        expect(db.prepare('SELECT path FROM notes').get().path).toBe('Still Here.md');
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

describe('assertFswatchAvailable', () => {
    it('does not throw when fswatch is resolvable on PATH', () => {
        expect(() => assertFswatchAvailable()).not.toThrow();
    });

    it('throws an actionable error when fswatch is not on PATH', () => {
        expect(() => assertFswatchAvailable({ PATH: '' })).toThrow(/fswatch not found/);
    });
});

describe('spawnFswatch (real binary)', () => {
    it('reports a path when a file changes under the watched directory', async () => {
        const vaultRoot = makeTempVault();

        const seenPaths = await new Promise((resolve, reject) => {
            const found = [];
            // Both timers below fire (or are cancelled) as a pair — without clearing the loser, an
            // early resolve (the fswatch event usually arrives well before 300ms) leaves the
            // writeNote timer pending, firing after afterEach() has already removed the vault.
            const timers = [];
            function settle(result) {
                for (const timer of timers) clearTimeout(timer);
                resolve(result);
            }
            const child = spawnFswatch(vaultRoot, (path) => {
                found.push(path);
                child.kill();
                settle(found);
            });
            child.on('error', reject);
            timers.push(setTimeout(() => writeNote(vaultRoot, 'Triggered.md', 'content', undefined), 300));
            timers.push(setTimeout(() => { child.kill(); settle(found); }, 5000));
        });

        expect(seenPaths.length).toBeGreaterThan(0);
    }, 10000);
});

describe('runReindex', () => {
    it('enqueues and reindexes every .md file in the vault when noteTitle is omitted', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'note a', 1000);
        writeNote(vaultRoot, 'B.md', 'note b', 1000);
        const db = makeTestDb();
        const messages = [];

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 0 }, {}, (msg) => messages.push(msg));

        const summaryMsg = messages.find((m) => m.summary);
        expect(summaryMsg.summary).toEqual({ reindexed: 2, skipped: 0, failed: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count).toBe(2);
    });

    it('scopes to a single path when noteTitle is given', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Only.md', 'note', 1000);
        writeNote(vaultRoot, 'Ignored.md', 'note', 1000);
        const db = makeTestDb();
        const messages = [];

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 0 }, { noteTitle: 'Only' }, (msg) => messages.push(msg));

        expect(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count).toBe(1);
        expect(db.prepare('SELECT path FROM notes').get().path).toBe('Only.md');
    });

    it('streams a message per attempt and retries in place until success or exhaustion', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Flaky.md', 'note', 1000);
        const db = makeTestDb();
        let attemptCount = 0;
        const flakyDeps = {
            ...baseDeps(),
            embed: async (text) => {
                attemptCount += 1;
                if (attemptCount < 4) {
                    throw new Error('transient failure');
                }
                return fakeEmbed(text);
            },
            now: 0,
        };
        const messages = [];

        await runReindex(vaultRoot, db, flakyDeps, { noteTitle: 'Flaky' }, (msg) => messages.push(msg));

        const finalOutcome = messages.find((m) => m.path === 'Flaky.md' && m.outcome === 'reindexed');
        expect(finalOutcome).toBeDefined();
        expect(messages.filter((m) => m.outcome === 'attempt_failed')).toHaveLength(3);
    });

    it('reports failed in the summary once retries are exhausted', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'AlwaysBroken.md', 'note', 1000);
        const db = makeTestDb();
        const brokenDeps = {
            ...baseDeps(),
            embed: async () => { throw new Error('always fails'); },
            now: 0,
        };
        const messages = [];

        await runReindex(vaultRoot, db, brokenDeps, { noteTitle: 'AlwaysBroken' }, (msg) => messages.push(msg));

        const summaryMsg = messages.find((m) => m.summary);
        expect(summaryMsg.summary).toEqual({ reindexed: 0, skipped: 0, failed: 1 });
    });
});

describe('runReindex: records last_full_reindex_at on a full-vault run', () => {
    it('writes meta.last_full_reindex_at after a full-vault reindex completes', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'note a', 1000);
        const db = makeTestDb();

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 5000 }, {}, () => {});

        expect(getMeta(db, 'last_full_reindex_at')).toBe('5000');
    });

    it('does not touch last_full_reindex_at for a single-title reindex', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Only.md', 'note', 1000);
        const db = makeTestDb();

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 5000 }, { noteTitle: 'Only' }, () => {});

        expect(getMeta(db, 'last_full_reindex_at')).toBeNull();
    });
});

describe('defaultSocketPath', () => {
    it('points at daemon.sock under the platform module\'s app-support directory (S009)', () => {
        expect(defaultSocketPath()).toBe(join(appSupportDir(), 'daemon.sock'));
    });
});

describe('createIpcServer', () => {
    it('streams per-path outcomes and a final summary for a reindex request', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Socketed.md', 'note body', 1000);
        const db = makeTestDb();
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        const server = createIpcServer(socketPath, vaultRoot, db, { ...baseDeps(), now: 0 }, createSerialGate());

        const messages = await new Promise((resolve, reject) => {
            const received = [];
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'reindex' })}\n`);
            });
            let buffer = '';
            client.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    received.push(JSON.parse(buffer.slice(0, newlineIndex)));
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf('\n');
                }
            });
            client.on('end', () => resolve(received));
            client.on('error', reject);
        });

        server.close();
        expect(messages.some((m) => m.path === 'Socketed.md')).toBe(true);
        expect(messages.find((m) => m.summary).summary).toEqual({ reindexed: 1, skipped: 0, failed: 0 });
    });

    it('answers an embed request with a { vector } message, then closes the connection', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');
        const deps = {
            ...baseDeps(),
            embedQuery: async (text) => Float32Array.from([ text.length, 0.5 ]),
        };

        const server = createIpcServer(socketPath, vaultRoot, db, deps, createSerialGate());

        const message = await new Promise((resolve, reject) => {
            let buffer = '';
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'embed', text: 'hello' })}\n`);
            });
            client.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            client.on('end', () => resolve(JSON.parse(buffer)));
            client.on('error', reject);
        });

        server.close();
        expect(message).toEqual({ vector: [ 5, 0.5 ] });
    });

    it('answers an embed request with { error } when deps.embedQuery rejects', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');
        const deps = {
            ...baseDeps(),
            embedQuery: async () => { throw new Error('pipeline unavailable'); },
        };

        const server = createIpcServer(socketPath, vaultRoot, db, deps, createSerialGate());

        const message = await new Promise((resolve, reject) => {
            let buffer = '';
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'embed', text: 'hello' })}\n`);
            });
            client.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            client.on('end', () => resolve(JSON.parse(buffer)));
            client.on('error', reject);
        });

        server.close();
        expect(message).toEqual({ error: 'pipeline unavailable' });
    });
});

describe('startDaemon', () => {
    it('indexes the pre-existing vault on startup and serves a reindex request over IPC', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Preexisting.md', 'already on disk', 1000);
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }), // fswatch itself is covered by Task 16's real-binary test
            chunkText: fakeChunkText,
            embed: fakeEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: null, // this test drives one drain pass manually instead of on a timer
        });

        expect(daemon.db.prepare('SELECT path FROM notes').get().path).toBe('Preexisting.md');

        const messages = await new Promise((resolve, reject) => {
            const received = [];
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'reindex' })}\n`);
            });
            let buffer = '';
            client.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    received.push(JSON.parse(buffer.slice(0, newlineIndex)));
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf('\n');
                }
            });
            client.on('end', () => resolve(received));
            client.on('error', reject);
        });

        expect(messages.find((m) => m.summary)).toBeDefined();

        await daemon.stop();
    });

    it('logs "daemon started" via the context logger before opening the DB', async () => {
        const vaultRoot = makeTempVault();
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-log-'));
        const logger = getLogger('indexer', logDir);

        const daemon = await runWithLogger(logger, () => startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }),
            chunkText: fakeChunkText,
            embed: fakeEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: null,
        }));

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
            expect(line).toContain('INFO  [indexer] daemon started');
        });

        await daemon.stop();
        await cleanupTempDir(logDir);
    });

    it('does not start an overlapping drain pass while one is still embedding', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Slow.md', 'content', 1000);
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        let embedCalls = 0;
        let releaseEmbed;
        const gate = new Promise((resolve) => { releaseEmbed = resolve; });
        const slowEmbed = async (text) => {
            embedCalls += 1;
            await gate;
            return fakeEmbed(text);
        };

        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }),
            chunkText: fakeChunkText,
            embed: slowEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            // Fires far more often than the gated embed call above resolves, so a working
            // drain loop must skip these ticks rather than starting a second concurrent pass.
            drainIntervalMs: 5,
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(embedCalls).toBe(1);

        releaseEmbed();
        await vi.waitFor(() => {
            expect(daemon.db.prepare('SELECT COUNT(*) c FROM index_queue').get().c).toBe(0);
        });
        expect(embedCalls).toBe(1);

        await daemon.stop();
    });

    it('serializes an IPC-triggered reindex against an in-flight background drain pass', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Slow.md', 'content', 1000);
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        let embedCalls = 0;
        let releaseEmbed;
        const embedGate = new Promise((resolve) => { releaseEmbed = resolve; });
        const slowEmbed = async (text) => {
            embedCalls += 1;
            await embedGate;
            return fakeEmbed(text);
        };

        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }),
            chunkText: fakeChunkText,
            embed: slowEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: 5,
        });

        // Let the background drain loop pick up the pre-existing note and block on its first embed.
        await vi.waitFor(() => expect(embedCalls).toBe(1));

        // Fire an IPC reindex for the same note while the drain pass is still mid-embed. If the two
        // weren't serialized, this would start a second, concurrent processPath call on the same
        // path.
        const received = [];
        const requestDone = new Promise((resolve, reject) => {
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'reindex', noteTitle: 'Slow' })}\n`);
            });
            let buffer = '';
            client.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    received.push(JSON.parse(buffer.slice(0, newlineIndex)));
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf('\n');
                }
            });
            client.on('end', resolve);
            client.on('error', reject);
        });

        // Give the IPC request time to arrive — a broken (unserialized) implementation would start
        // its own embed call here, immediately bumping embedCalls to 2.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(embedCalls).toBe(1);

        releaseEmbed();
        await requestDone;

        // The note's mtime never changed, so once the gate frees up, the queued reindex sees an
        // already-current row and skips re-embedding instead of doing redundant work.
        expect(embedCalls).toBe(1);
        expect(received.find((m) => m.summary)).toBeDefined();

        await daemon.stop();
    });

    it('answers an embed IPC request while a reindex is still mid-embed, unlike reindex-vs-reindex '
        + 'above — embed does not go through the same serial gate', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Slow.md', 'content', 1000);
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        let embedCalls = 0;
        let releaseEmbed;
        const embedGate = new Promise((resolve) => { releaseEmbed = resolve; });
        const slowEmbed = async (text) => {
            embedCalls += 1;
            await embedGate;
            return fakeEmbed(text);
        };

        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }),
            chunkText: fakeChunkText,
            embed: slowEmbed,
            embedQuery: async (text) => Float32Array.from([ text.length, 0.5 ]),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: 5,
        });

        // Background drain is now blocked mid-embed on the pre-existing note (slowEmbed never
        // resolves until releaseEmbed() below).
        await vi.waitFor(() => expect(embedCalls).toBe(1));

        const embedResponse = await new Promise((resolve, reject) => {
            let buffer = '';
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'embed', text: 'query text' })}\n`);
            });
            client.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            client.on('end', () => resolve(JSON.parse(buffer)));
            client.on('error', reject);
        });

        expect(embedResponse.vector).toBeDefined();

        releaseEmbed();
        await daemon.stop();
    });

    it('passes options.debounceMs through to createWatcher (config.toml-backed, S009)', async () => {
        const vaultRoot = makeTempVault();
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        let receivedDebounceMs;
        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: (root, db, { debounceMs } = {}) => {
                receivedDebounceMs = debounceMs;
                return { stop() {} };
            },
            chunkText: fakeChunkText,
            embed: fakeEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: null,
            debounceMs: 4242,
        });

        expect(receivedDebounceMs).toBe(4242);
        await daemon.stop();
    });

    it('passes options.backoffSchedule through to failed-attempt retry scheduling (S009)', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'AlwaysFails.md', 'content', 1000);
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        const failingEmbed = async () => { throw new Error('embed failed'); };

        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }),
            chunkText: fakeChunkText,
            embed: failingEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: null,
            backoffSchedule: [ 5000 ],
        });

        await vi.waitFor(() => {
            const row = daemon.db.prepare('SELECT enqueued_at, next_attempt_at FROM index_queue WHERE path = ?')
                .get('AlwaysFails.md');
            // enqueued_at/next_attempt_at are two separate real Date.now() calls, so the delta is
            // backoffSchedule[0] plus actual processing time, not exactly backoffSchedule[0] — a
            // tolerance window still tells "honored" (~5000ms) apart from the 30s default.
            const delta = row.next_attempt_at - row.enqueued_at;
            expect(delta).toBeGreaterThanOrEqual(5000);
            expect(delta).toBeLessThan(7000);
        });

        await daemon.stop();
    });
});
