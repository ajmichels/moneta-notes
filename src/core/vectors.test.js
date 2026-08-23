import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { cleanupTempDir } from '../../vitest.helpers.js';
import {
    vectorToBuffer, bufferToVector, cosineSimilarity, cosineDistance,
    getChunkVectors, getAllChunkVectors, getNoteVector,
    noteIdForTitle, titleForNoteId, resolveNoteId, resolveScopeNoteIds,
} from './vectors.js';

const tempDirs = [];

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

function makeTempDb() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-vectors-test-'));
    tempDirs.push(dir);
    return openDb(join(dir, 'index.db')).db;
}

function insertNote(db, path, { lineCount = 10, mtime = 1000 } = {}) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'hash', lineCount, mtime, mtime);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

// chunk_vectors is a fixed float[1024] vec0 column (S001) — every vector inserted here must match
// that width. Deterministic per-seed direction (not a constant-fill vector, which would collapse
// every seed to the same direction) — see search.test.js's makeVector for the same rationale.
function makeVector(seed, dims = 1024) {
    const vector = new Float32Array(dims);
    let state = Math.floor(seed * 1e6) + 1;
    for (let i = 0; i < dims; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        vector[i] = (state % 1000) / 1000;
    }
    return vector;
}

function insertChunk(db, noteId, {
    chunkIndex = 0, seed, embeddingModel = 'test-model', embeddingVersion = 'v1',
    lineStart = 1, lineEnd = 1,
} = {}) {
    db.prepare(`
        INSERT INTO chunks
            (note_id, chunk_index, char_start, char_end, line_start, line_end, token_count,
             embedding_model, embedding_version)
        VALUES (?, ?, 0, 100, ?, ?, 50, ?, ?)
    `).run(noteId, chunkIndex, lineStart, lineEnd, embeddingModel, embeddingVersion);
    const chunkId = db.prepare(
        'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
    ).get(noteId, chunkIndex).id;
    db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
        chunkId, vectorToBuffer(makeVector(seed)),
    );
    return chunkId;
}

describe('vectorToBuffer / bufferToVector', () => {
    it('round-trips a Float32Array through a Buffer', () => {
        const original = makeVector(0.42);
        const restored = bufferToVector(vectorToBuffer(original));
        expect(Array.from(restored)).toEqual(Array.from(original));
    });
});

describe('cosineSimilarity / cosineDistance', () => {
    it('is 1 for identical vectors and sums to 1 with distance', () => {
        const v = makeVector(0.1);
        expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
        expect(cosineDistance(v, v)).toBeCloseTo(0, 5);
    });

    it('is scale-invariant (direction only)', () => {
        const v = makeVector(0.3);
        const scaled = Float32Array.from(v, (x) => x * 3);
        expect(cosineSimilarity(v, scaled)).toBeCloseTo(1, 5);
    });

    it('differentiates two distinct directions', () => {
        const similarity = cosineSimilarity(makeVector(0.1), makeVector(0.9));
        expect(similarity).toBeLessThan(1);
        expect(similarity + cosineDistance(makeVector(0.1), makeVector(0.9))).toBeCloseTo(1, 5);
    });
});

describe('getChunkVectors', () => {
    it('returns a Map keyed by chunk id, decoded back to Float32Array', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkId = insertChunk(db, noteId, { seed: 0.5 });

        const vectors = getChunkVectors(db, [ chunkId ]);

        expect(vectors.size).toBe(1);
        expect(Array.from(vectors.get(chunkId))).toEqual(Array.from(makeVector(0.5)));
        db.close();
    });

    it('returns an empty Map for an empty id list', () => {
        const db = makeTempDb();
        expect(getChunkVectors(db, []).size).toBe(0);
        db.close();
    });
});

describe('getAllChunkVectors', () => {
    it('excludes chunks from a stale embedding model/version', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        insertChunk(db, noteId, { seed: 0.1, embeddingModel: 'old-model' });
        insertChunk(db, noteId, { chunkIndex: 1, seed: 0.2, embeddingModel: 'test-model' });

        const rows = getAllChunkVectors(db, { embeddingModel: 'test-model', embeddingVersion: 'v1' });

        expect(rows).toHaveLength(1);
        db.close();
    });

    it('scopes to the given note ids when provided', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.2 });

        const rows = getAllChunkVectors(db, {
            noteIds: [ noteA ], embeddingModel: 'test-model', embeddingVersion: 'v1',
        });

        expect(rows.map((r) => r.noteId)).toEqual([ noteA ]);
        db.close();
    });
});

describe('getAllNoteVectors / getNoteVector', () => {
    it('collapses a note\'s chunks to a single unit-normalized centroid', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        insertChunk(db, noteId, { chunkIndex: 0, seed: 0.1 });
        insertChunk(db, noteId, { chunkIndex: 1, seed: 0.2 });

        const vector = getNoteVector(db, noteId, { embeddingModel: 'test-model', embeddingVersion: 'v1' });

        let normSq = 0;
        for (const x of vector) {
            normSq += x * x;
        }
        expect(normSq).toBeCloseTo(1, 5);
        db.close();
    });

    it('returns null for a note with no chunks', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'Empty.md');
        const vector = getNoteVector(db, noteId, { embeddingModel: 'test-model', embeddingVersion: 'v1' });
        expect(vector).toBeNull();
        db.close();
    });
});

describe('title/id resolution', () => {
    it('noteIdForTitle / titleForNoteId round-trip', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'Projects/Moneta.md');
        expect(noteIdForTitle(db, 'Projects/Moneta')).toBe(noteId);
        expect(titleForNoteId(db, noteId)).toBe('Projects/Moneta');
        db.close();
    });

    it('resolveNoteId falls back to a unique basename match', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'Deep/Nested/Barbara Garn.md');
        expect(resolveNoteId(db, 'Barbara Garn')).toBe(noteId);
        db.close();
    });

    it('resolveNoteId throws for an unresolvable title', () => {
        const db = makeTempDb();
        expect(() => resolveNoteId(db, 'Nope')).toThrow(/no note found/);
        db.close();
    });
});

describe('resolveScopeNoteIds', () => {
    it('returns null (no scope) when neither --tag nor --folder is given', () => {
        const db = makeTempDb();
        expect(resolveScopeNoteIds(db, {})).toBeNull();
        db.close();
    });

    it('throws when both --tag and --folder are given', () => {
        const db = makeTempDb();
        expect(() => resolveScopeNoteIds(db, { tag: 'a', folder: 'b' })).toThrow(/mutually exclusive/);
        db.close();
    });

    it('resolves --tag to the note ids carrying that tag (including hierarchical children)', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const otherId = insertNote(db, 'B.md');
        db.prepare('INSERT INTO tags (name) VALUES (?)').run('project/moneta');
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get('project/moneta').id;
        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);

        expect(resolveScopeNoteIds(db, { tag: 'project' })).toEqual([ noteId ]);
        expect(otherId).toBeGreaterThan(0);
        db.close();
    });

    it('resolves --folder to note ids under that path prefix', () => {
        const db = makeTempDb();
        const inFolder = insertNote(db, 'Weekly Notes/2026-W32.md');
        insertNote(db, 'Daily Notes/2026-08-04.md');

        expect(resolveScopeNoteIds(db, { folder: 'Weekly Notes' })).toEqual([ inFolder ]);
        db.close();
    });

    it('escapes LIKE wildcards in a --folder value', () => {
        const db = makeTempDb();
        insertNote(db, 'Weekly Notes/2026-W32.md');
        expect(resolveScopeNoteIds(db, { folder: 'Weekly_Notes' })).toEqual([]);
        db.close();
    });
});
