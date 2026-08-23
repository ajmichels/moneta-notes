import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { cleanupTempDir } from '../../vitest.helpers.js';
import {
    vectorToBuffer, bufferToVector, cosineSimilarity, cosineDistance,
    getChunkVectors, getAllChunkVectors, getNoteVector,
    noteIdForTitle, titleForNoteId, resolveNoteId, resolveScopeNoteIds, compareVectors,
    nearestNeighbors, clusterVectors,
} from './vectors.js';

const EMB = { embeddingModel: 'test-model', embeddingVersion: 'v1' };

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

describe('compareVectors: level=chunk', () => {
    it('compares two chunks directly by id', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkA = insertChunk(db, noteId, { chunkIndex: 0, seed: 0.1 });
        const chunkB = insertChunk(db, noteId, { chunkIndex: 1, seed: 0.1 });

        const result = compareVectors(db, chunkA, chunkB, { level: 'chunk' });

        expect(result).toEqual({ similarity: expect.any(Number) });
        expect(result.similarity).toBeCloseTo(1, 5);
        db.close();
    });

    it('throws for an unknown chunk id', () => {
        const db = makeTempDb();
        expect(() => compareVectors(db, 999, 998, { level: 'chunk' })).toThrow(/no chunk found/);
        db.close();
    });
});

describe('compareVectors: level=note', () => {
    it('aggregate=centroid compares each note\'s single collapsed vector', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.1 });

        const result = compareVectors(db, 'A', 'B', { level: 'note', aggregate: 'centroid', ...EMB });

        expect(result).toEqual({ similarity: expect.any(Number) });
        expect(result.similarity).toBeCloseTo(1, 5);
        db.close();
    });

    it('resolves note titles the same way read does (unique basename fallback)', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'Deep/A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.9 });

        expect(() => compareVectors(db, 'A', 'B', { level: 'note', ...EMB })).not.toThrow();
        db.close();
    });

    it('aggregate=best-chunk reports the closest chunk pair with its line span', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { chunkIndex: 0, seed: 0.1, lineStart: 1, lineEnd: 5 });
        insertChunk(db, noteA, { chunkIndex: 1, seed: 0.9, lineStart: 6, lineEnd: 10 });
        insertChunk(db, noteB, { seed: 0.1, lineStart: 20, lineEnd: 25 });

        const result = compareVectors(db, 'A', 'B', { level: 'note', aggregate: 'best-chunk', ...EMB });

        expect(result.chunk_a).toEqual({ line_start: 1, line_end: 5 });
        expect(result.chunk_b).toEqual({ line_start: 20, line_end: 25 });
        expect(result.similarity).toBeCloseTo(1, 5);
        db.close();
    });

    it('aggregate=all-pairs returns a full chunk x chunk similarity matrix', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { chunkIndex: 0, seed: 0.1 });
        insertChunk(db, noteA, { chunkIndex: 1, seed: 0.2 });
        insertChunk(db, noteB, { seed: 0.3 });

        const result = compareVectors(db, 'A', 'B', { level: 'note', aggregate: 'all-pairs', ...EMB });

        expect(result.chunks_a).toHaveLength(2);
        expect(result.chunks_b).toHaveLength(1);
        expect(result.matrix).toHaveLength(2);
        expect(result.matrix[0]).toHaveLength(1);
        db.close();
    });

    it('throws when a compared note has no chunks', () => {
        const db = makeTempDb();
        insertNote(db, 'A.md');
        insertNote(db, 'B.md');
        expect(() => compareVectors(db, 'A', 'B', { level: 'note', ...EMB })).toThrow(/no chunks/);
        db.close();
    });

    it('throws for an unknown aggregate', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.2 });
        expect(() => compareVectors(db, 'A', 'B', { level: 'note', aggregate: 'nope', ...EMB }))
            .toThrow(/unknown aggregate/);
        db.close();
    });
});

describe('nearestNeighbors', () => {
    it('ranks notes by similarity to the query note\'s centroid, excluding itself', () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        const close = insertNote(db, 'Close.md');
        const far = insertNote(db, 'Far.md');
        insertChunk(db, query, { seed: 0.5 });
        insertChunk(db, close, { seed: 0.5 });
        insertChunk(db, far, { seed: 0.99 });

        const results = nearestNeighbors(db, 'Query', { ...EMB });

        expect(results.map((r) => r.note_title)).toEqual([ 'Close', 'Far' ]);
        expect(results[0].rank).toBe(1);
        expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
        db.close();
    });

    it('respects --k', () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        insertChunk(db, query, { seed: 0.5 });
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, `N${i}.md`);
            insertChunk(db, noteId, { seed: 0.1 * i });
        }

        const results = nearestNeighbors(db, 'Query', { k: 2, ...EMB });

        expect(results).toHaveLength(2);
        db.close();
    });

    it('--against chunk returns chunk-level neighbors with line spans, excluding the whole query note', () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        const other = insertNote(db, 'Other.md');
        insertChunk(db, query, { chunkIndex: 0, seed: 0.5 });
        insertChunk(db, query, { chunkIndex: 1, seed: 0.5 });
        insertChunk(db, other, { seed: 0.5, lineStart: 10, lineEnd: 15 });

        const results = nearestNeighbors(db, 'Query', { level: 'note', against: 'chunk', ...EMB });

        expect(results).toHaveLength(1);
        expect(results[0].note_title).toBe('Other');
        expect(results[0].chunk_line_start).toBe(10);
        expect(results[0].chunk_line_end).toBe(15);
        db.close();
    });

    it('--level chunk queries with a raw chunk id and excludes only that exact chunk', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkA = insertChunk(db, noteId, { chunkIndex: 0, seed: 0.5 });
        insertChunk(db, noteId, { chunkIndex: 1, seed: 0.5, lineStart: 6, lineEnd: 10 });

        const results = nearestNeighbors(db, String(chunkA), { level: 'chunk', against: 'chunk', ...EMB });

        expect(results).toHaveLength(1);
        expect(results[0].chunk_line_start).toBe(6);
        db.close();
    });

    it('--level chunk against note excludes the chunk\'s own parent note', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkA = insertChunk(db, noteId, { seed: 0.5 });
        const otherNote = insertNote(db, 'B.md');
        insertChunk(db, otherNote, { seed: 0.5 });

        const results = nearestNeighbors(db, String(chunkA), { level: 'chunk', against: 'note', ...EMB });

        expect(results.map((r) => r.note_title)).toEqual([ 'B' ]);
        db.close();
    });

    it('aggregate=best-chunk scores by the max similarity across the query note\'s chunks', () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        insertChunk(db, query, { chunkIndex: 0, seed: 0.1 });
        insertChunk(db, query, { chunkIndex: 1, seed: 0.9 });
        const target = insertNote(db, 'Target.md');
        insertChunk(db, target, { seed: 0.9 });

        const results = nearestNeighbors(db, 'Query', { aggregate: 'best-chunk', ...EMB });

        expect(results[0].note_title).toBe('Target');
        expect(results[0].similarity).toBeCloseTo(1, 5);
        db.close();
    });

    it('throws for an unresolvable query title', () => {
        const db = makeTempDb();
        expect(() => nearestNeighbors(db, 'Nope', { ...EMB })).toThrow(/no note found/);
        db.close();
    });
});

// Two seeds (0.1, 0.9) whose vectors sit at cosine distance ~0.25 from each other — two notes
// sharing a seed get bit-identical vectors (distance 0), so any of the three algorithms below
// should cleanly separate "same seed" from "different seed" regardless of init/linkage details.
function seedTwoGroups(db, insertVector) {
    const groupA = [ insertNote(db, 'A1.md'), insertNote(db, 'A2.md') ];
    const groupB = [ insertNote(db, 'B1.md'), insertNote(db, 'B2.md') ];
    for (const noteId of groupA) {
        insertVector(db, noteId, { seed: 0.1 });
    }
    for (const noteId of groupB) {
        insertVector(db, noteId, { seed: 0.9 });
    }
    return { groupA, groupB };
}

function clusterIdsByTitle(membership) {
    return Object.fromEntries(membership.map((m) => [ m.note_title, m.cluster_id ]));
}

function expectTwoCleanClusters(membership) {
    const byTitle = clusterIdsByTitle(membership);
    expect(byTitle.A1).toBe(byTitle.A2);
    expect(byTitle.B1).toBe(byTitle.B2);
    expect(byTitle.A1).not.toBe(byTitle.B1);
}

describe('clusterVectors: kmeans', () => {
    it('separates two well-separated groups into two clusters', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);

        const { membership, clusters } = clusterVectors(db, { level: 'note', algo: 'kmeans', k: 2, ...EMB });

        expectTwoCleanClusters(membership);
        expect(clusters).toHaveLength(2);
        expect(clusters[0].example_titles.length).toBeGreaterThan(0);
        db.close();
    });

    it('throws when --k exceeds the number of points in scope', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => clusterVectors(db, { level: 'note', algo: 'kmeans', k: 99, ...EMB }))
            .toThrow(/exceeds the number of points/);
        db.close();
    });

    it('throws when --k is missing', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => clusterVectors(db, { level: 'note', algo: 'kmeans', ...EMB }))
            .toThrow(/--k is required/);
        db.close();
    });
});

describe('clusterVectors: hierarchical', () => {
    it('--k cuts the dendrogram to a fixed cluster count', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const { membership } = clusterVectors(db, { level: 'note', algo: 'hierarchical', k: 2, ...EMB });
        expectTwoCleanClusters(membership);
        db.close();
    });

    it('--cut-height cuts by distance instead of a fixed count', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const { membership } = clusterVectors(
            db, { level: 'note', algo: 'hierarchical', cutHeight: 0.1, ...EMB },
        );
        expectTwoCleanClusters(membership);
        db.close();
    });

    it('throws when both --k and --cut-height are given', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => clusterVectors(
            db, { level: 'note', algo: 'hierarchical', k: 2, cutHeight: 0.1, ...EMB },
        )).toThrow(/exactly one of --k or --cut-height/);
        db.close();
    });

    it('throws when neither --k nor --cut-height is given', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => clusterVectors(db, { level: 'note', algo: 'hierarchical', ...EMB }))
            .toThrow(/exactly one of --k or --cut-height/);
        db.close();
    });
});

describe('clusterVectors: dbscan', () => {
    it('separates dense groups and requires both --epsilon and --min-points', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const { membership } = clusterVectors(
            db, { level: 'note', algo: 'dbscan', epsilon: 0.1, minPoints: 2, ...EMB },
        );
        expectTwoCleanClusters(membership);
        db.close();
    });

    it('throws when --epsilon or --min-points is missing', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => clusterVectors(db, { level: 'note', algo: 'dbscan', epsilon: 0.1, ...EMB }))
            .toThrow(/requires both --epsilon and --min-points/);
        db.close();
    });
});

describe('clusterVectors: scoping and errors', () => {
    it('--tag restricts the scope to notes carrying that tag', () => {
        const db = makeTempDb();
        const { groupA } = seedTwoGroups(db, insertChunk);
        db.prepare('INSERT INTO tags (name) VALUES (?)').run('scoped');
        const { id } = db.prepare('SELECT id FROM tags WHERE name = ?').get('scoped');
        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(groupA[0], id);

        const { membership } = clusterVectors(
            db, { level: 'note', algo: 'kmeans', k: 1, tag: 'scoped', ...EMB },
        );

        expect(membership).toHaveLength(1);
        expect(membership[0].note_title).toBe('A1');
        db.close();
    });

    it('--level chunk clusters raw chunk vectors and reports chunk_id + note_title', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const { membership } = clusterVectors(db, { level: 'chunk', algo: 'kmeans', k: 2, ...EMB });
        expect(membership[0]).toEqual({
            cluster_id: expect.any(Number), chunk_id: expect.any(Number), note_title: expect.any(String),
        });
        db.close();
    });

    it('throws for an unknown --algo', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => clusterVectors(db, { level: 'note', algo: 'nope', ...EMB })).toThrow(/unknown --algo/);
        db.close();
    });

    it('throws when there are no vectors in scope', () => {
        const db = makeTempDb();
        expect(() => clusterVectors(db, { level: 'note', algo: 'kmeans', k: 1, ...EMB }))
            .toThrow(/no vectors in scope/);
        db.close();
    });
});
