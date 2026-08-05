import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';

describe('openDb', () => {
    it('loads the sqlite-vec extension', () => {
        const { db } = openDb(':memory:');
        const row = db.prepare('SELECT vec_version() AS version').get();
        expect(typeof row.version).toBe('string');
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
