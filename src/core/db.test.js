import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getMeta, setMeta, SCHEMA_VERSION } from './db.js';
import { getLogger, runWithLogger } from '../logger.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const EXPECTED_TABLES = [
    'notes',
    'notes_fts',
    'chunks',
    'chunk_vectors',
    'tags',
    'note_tags',
    'note_links',
    'index_queue',
    'meta',
];

const tempDirs = [];

function makeTempDbPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-db-test-'));
    tempDirs.push(dir);
    return join(dir, 'index.db');
}

function makeTempLogDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-db-test-log-'));
    tempDirs.push(dir);
    return dir;
}

function findLogLine(logFile, level) {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    return lines.find((line) => line.includes(level));
}

afterEach(() => {
    while (tempDirs.length > 0) {
        cleanupTempDir(tempDirs.pop());
    }
});

describe('openDb', () => {
    it('loads the sqlite-vec extension', () => {
        const { db } = openDb(':memory:');
        const row = db.prepare('SELECT vec_version() AS version').get();
        expect(typeof row.version).toBe('string');
        db.close();
    });

    it('enables WAL journal mode for a file-backed database', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        const row = db.prepare('PRAGMA journal_mode').get();
        expect(row.journal_mode).toBe('wal');
        db.close();
    });
});

describe('schema: notes table', () => {
    it('creates the notes table with the expected columns', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Weekly Notes/2026-W32.md', 'abc123', 42, 1000, 1000);

        const row = db.prepare('SELECT * FROM notes WHERE path = ?').get('Weekly Notes/2026-W32.md');
        expect(row.content_hash).toBe('abc123');
        expect(row.line_count).toBe(42);
        db.close();
    });

    it('rejects a duplicate path', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Dup.md', 'a', 1, 1, 1);

        expect(() => {
            db.prepare(
                'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
            ).run('Dup.md', 'b', 2, 2, 2);
        }).toThrow();
        db.close();
    });
});

describe('schema: chunks table', () => {
    it('cascades chunk deletion when the parent note is deleted', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare(`
            INSERT INTO chunks
                (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 100, 50, ?, ?)
        `).run(noteId, 'Qwen3-Embedding-0.6B', 'v1');

        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);

        const remaining = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE note_id = ?').get(noteId);
        expect(remaining.count).toBe(0);
        db.close();
    });

    it('rejects a duplicate (note_id, chunk_index) pair', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare(`
            INSERT INTO chunks
                (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 100, 50, ?, ?)
        `).run(noteId, 'Qwen3-Embedding-0.6B', 'v1');

        expect(() => {
            db.prepare(`
                INSERT INTO chunks
                    (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
                VALUES (?, 0, 100, 200, 50, ?, ?)
            `).run(noteId, 'Qwen3-Embedding-0.6B', 'v1');
        }).toThrow();
        db.close();
    });
});

describe('schema: chunk_vectors table', () => {
    it('stores a 1024-dim vector and supports a KNN query', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare(`
            INSERT INTO chunks
                (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 100, 50, ?, ?)
        `).run(noteId, 'Qwen3-Embedding-0.6B', 'v1');
        const chunkId = db.prepare('SELECT id FROM chunks WHERE note_id = ?').get(noteId).id;

        const vector = new Float32Array(1024).fill(0.1);
        db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
            chunkId,
            Buffer.from(vector.buffer),
        );

        const queryVector = new Float32Array(1024).fill(0.1);
        const hit = db.prepare(`
            SELECT rowid FROM chunk_vectors
            WHERE embedding MATCH ? AND k = 1
            ORDER BY distance
        `).get(Buffer.from(queryVector.buffer));

        expect(hit.rowid).toBe(chunkId);
        db.close();
    });
});

describe('schema: tags table', () => {
    it('preserves first-seen casing via COLLATE NOCASE uniqueness', () => {
        const { db } = openDb(':memory:');
        db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run('Project');
        db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run('project');

        const rows = db.prepare('SELECT name FROM tags').all();
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Project');
        db.close();
    });
});

describe('schema: note_tags table', () => {
    it('cascades when the note is deleted', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare('INSERT INTO tags (name) VALUES (?)').run('project');
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get('project').id;

        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);

        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
        const afterNoteDelete = db.prepare('SELECT COUNT(*) AS count FROM note_tags').get();
        expect(afterNoteDelete.count).toBe(0);

        db.close();
    });

    it('cascades when the tag is deleted', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare('INSERT INTO tags (name) VALUES (?)').run('project');
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get('project').id;

        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);

        db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
        const afterTagDelete = db.prepare('SELECT COUNT(*) AS count FROM note_tags').get();
        expect(afterTagDelete.count).toBe(0);

        db.close();
    });
});

describe('schema: note_links table', () => {
    it('cascades when the source note is deleted', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(noteId, 'Other Note');

        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
        const afterNoteDelete = db.prepare('SELECT COUNT(*) AS count FROM note_links').get();
        expect(afterNoteDelete.count).toBe(0);

        db.close();
    });

    it('rejects a duplicate (source_note_id, target_title) pair', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(noteId, 'Other Note');

        expect(() => {
            db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
                .run(noteId, 'Other Note');
        }).toThrow();

        db.close();
    });

    it('allows target_title with no matching note (unresolved link)', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(noteId, 'Nonexistent Note');

        const row = db.prepare('SELECT target_title FROM note_links WHERE source_note_id = ?')
            .get(noteId);
        expect(row.target_title).toBe('Nonexistent Note');

        db.close();
    });
});

describe('schema: notes_fts table', () => {
    it('supports a contentless MATCH query', () => {
        const { db } = openDb(':memory:');
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (1, ?, ?)').run(
            'Test Title',
            'hello world body',
        );

        const hit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").get();
        expect(hit.rowid).toBe(1);
        db.close();
    });

    it('supports DELETE by rowid and removes the row from MATCH results', () => {
        const { db } = openDb(':memory:');
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (1, ?, ?)').run(
            'Test Title',
            'hello world body',
        );

        expect(() => {
            db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(1);
        }).not.toThrow();

        const hit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").get();
        expect(hit).toBeUndefined();
        db.close();
    });

    it('does not leave stale tokens matching after delete-and-reinsert at the same rowid', () => {
        const { db } = openDb(':memory:');
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (1, ?, ?)').run(
            'Old Title',
            'oldtoken body text',
        );
        db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(1);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (1, ?, ?)').run(
            'New Title',
            'newtoken body text',
        );

        const staleHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'oldtoken'").get();
        expect(staleHit).toBeUndefined();

        const freshHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'newtoken'").get();
        expect(freshHit.rowid).toBe(1);
        db.close();
    });
});

describe('schema: index_queue table', () => {
    it('deduplicates re-enqueued paths via the path primary key', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING',
        ).run('Test.md', 1000, 1000);
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING',
        ).run('Test.md', 2000, 2000);

        const rows = db.prepare('SELECT * FROM index_queue').all();
        expect(rows).toHaveLength(1);
        expect(rows[0].enqueued_at).toBe(1000);
        expect(rows[0].attempts).toBe(0);
        db.close();
    });
});

describe('getMeta / setMeta', () => {
    it('gets back a value that was set', () => {
        const { db } = openDb(':memory:');
        setMeta(db, 'foo', 'bar');
        expect(getMeta(db, 'foo')).toBe('bar');
        db.close();
    });

    it('returns null for a nonexistent key', () => {
        const { db } = openDb(':memory:');
        expect(getMeta(db, 'does_not_exist')).toBe(null);
        db.close();
    });

    it('overwrites rather than duplicates on a second set of the same key', () => {
        const { db } = openDb(':memory:');
        setMeta(db, 'foo', 'first');
        setMeta(db, 'foo', 'second');

        expect(getMeta(db, 'foo')).toBe('second');
        const rows = db.prepare('SELECT * FROM meta WHERE key = ?').all('foo');
        expect(rows).toHaveLength(1);
        db.close();
    });

    it('round-trips a numeric value as a string, without a trailing .0', () => {
        const { db } = openDb(':memory:');
        setMeta(db, 'x', 1000);
        expect(getMeta(db, 'x')).toBe('1000');
        db.close();
    });

    it('rejects null or undefined values instead of storing the literal string', () => {
        const { db } = openDb(':memory:');
        expect(() => setMeta(db, 'x', null)).toThrow();
        expect(() => setMeta(db, 'x', undefined)).toThrow();
        db.close();
    });
});

describe('schema versioning', () => {
    it('sets schema_version and reports reindexRequired on a fresh database', () => {
        const { db, reindexRequired } = openDb(':memory:');
        expect(reindexRequired).toBe(true);

        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        expect(row.value).toBe(String(SCHEMA_VERSION));
        db.close();
    });

    it('creates exactly the expected top-level tables on a fresh database', () => {
        const { db } = openDb(':memory:');
        const rows = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all();
        const names = rows.map((row) => row.name);

        for (const expected of EXPECTED_TABLES) {
            expect(names).toContain(expected);
        }
        db.close();
    });

    it('does not rebuild or lose data on a reopen at the same version', () => {
        const dbPath = makeTempDbPath();

        const first = openDb(dbPath);
        first.db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        first.db.close();

        const second = openDb(dbPath);
        expect(second.reindexRequired).toBe(false);

        const row = second.db.prepare('SELECT * FROM notes WHERE path = ?').get('Test.md');
        expect(row.content_hash).toBe('abc123');
        second.db.close();
    });
});

describe('schema versioning: logging', () => {
    it('logs at info when creating a fresh schema', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        const dbPath = makeTempDbPath();

        const { db } = runWithLogger(logger, () => openDb(dbPath));
        db.close();

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
            expect(line).toContain('INFO  [indexer] schema created');
            expect(line).toContain(`schema_version=${SCHEMA_VERSION}`);
        });
    });

    it('logs at warn when rebuilding due to a schema version mismatch', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        const dbPath = makeTempDbPath();

        const first = openDb(dbPath);
        first.db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
        first.db.close();

        const { db } = runWithLogger(logger, () => openDb(dbPath));
        db.close();

        await vi.waitFor(() => {
            const warnLine = findLogLine(join(logDir, 'indexer.log'), 'WARN');
            expect(warnLine).toContain('[indexer] schema version mismatch, rebuilding');
            expect(warnLine).toContain('from_version=0');
            expect(warnLine).toContain(`to_version=${SCHEMA_VERSION}`);
        });
    });

    it('does not log when reopening at the current schema version', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        const dbPath = makeTempDbPath();

        openDb(dbPath).db.close();

        const { db } = runWithLogger(logger, () => openDb(dbPath));
        db.close();

        // Give any unexpected fire-and-forget write a chance to land before asserting its absence.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(() => readFileSync(join(logDir, 'indexer.log'), 'utf8')).toThrow();
    });

    it('does not throw when opened with no logger context (unit-test-style direct call)', () => {
        const dbPath = makeTempDbPath();
        expect(() => openDb(dbPath).db.close()).not.toThrow();
    });
});

describe('schema rebuild on version mismatch', () => {
    it('rebuilds all tables and wipes data when schema_version is stale', () => {
        const dbPath = makeTempDbPath();

        const first = openDb(dbPath);
        first.db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        first.db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
        first.db.close();

        const second = openDb(dbPath);
        expect(second.reindexRequired).toBe(true);

        const noteCount = second.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
        expect(noteCount).toBe(0);

        const version = second.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        expect(version.value).toBe(String(SCHEMA_VERSION));

        const rows = second.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all();
        const names = rows.map((row) => row.name);
        for (const expected of EXPECTED_TABLES) {
            expect(names).toContain(expected);
        }

        second.db.close();
    });
});
