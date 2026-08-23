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
    nearestNeighbors, clusterVectors, reduceVectors, tagFit, tagRedundancy, findOutliers, calibrate,
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

function linkNotes(db, sourceNoteId, targetTitle) {
    db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)').run(sourceNoteId, targetTitle);
}

function tagNote(db, noteId, tagName) {
    db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(tagName);
    const { id: tagId } = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);
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

describe('reduceVectors: pca', () => {
    it('projects each point to --dims coordinates', () => {
        const db = makeTempDb();
        const { groupA, groupB } = seedTwoGroups(db, insertChunk);

        const { points, metadata } = reduceVectors(db, { level: 'note', algo: 'pca', dims: 2, ...EMB });

        expect(points).toHaveLength(groupA.length + groupB.length);
        for (const p of points) {
            expect(typeof p.x).toBe('number');
            expect(typeof p.y).toBe('number');
            expect(p.z).toBeNull();
            expect(p.label).toBeNull();
        }
        expect(metadata.cluster_source).toBeNull();
        db.close();
    });

    it('--dims 3 includes a numeric z', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const { points } = reduceVectors(db, { level: 'note', algo: 'pca', dims: 3, ...EMB });
        expect(typeof points[0].z).toBe('number');
        db.close();
    });

    it('--level chunk includes chunk_line_start/chunk_line_end', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const { points } = reduceVectors(db, { level: 'chunk', algo: 'pca', dims: 2, ...EMB });
        expect(points[0]).toHaveProperty('chunk_line_start');
        expect(points[0]).toHaveProperty('chunk_line_end');
        db.close();
    });

    it('--color-by tag labels each point with its first tag alphabetically', () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertNote(db, 'B.md');
        db.prepare('INSERT INTO tags (name) VALUES (?)').run('zeta');
        db.prepare('INSERT INTO tags (name) VALUES (?)').run('alpha');
        const zeta = db.prepare('SELECT id FROM tags WHERE name = ?').get('zeta').id;
        const alpha = db.prepare('SELECT id FROM tags WHERE name = ?').get('alpha').id;
        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteA, zeta);
        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteA, alpha);
        const noteB = insertNote(db, 'C.md');
        insertChunk(db, noteB, { seed: 0.9 });

        const { points } = reduceVectors(db, { level: 'note', algo: 'pca', colorBy: 'tag', ...EMB });

        const a = points.find((p) => p.title === 'A');
        expect(a.label).toBe('alpha');
        db.close();
    });

    it('--color-by cluster runs an internal kmeans and reports cluster_source: internal', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);

        const { points, metadata } = reduceVectors(
            db, { level: 'note', algo: 'pca', colorBy: 'cluster', ...EMB },
        );

        expect(metadata.cluster_source).toBe('internal');
        const byTitle = Object.fromEntries(points.map((p) => [ p.title, p.label ]));
        expect(byTitle.A1).toBe(byTitle.A2);
        expect(byTitle.B1).toBe(byTitle.B2);
        expect(byTitle.A1).not.toBe(byTitle.B1);
        db.close();
    });

    it('--color-by cluster with a caller-supplied membership reports cluster_source: external', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        const providedClusters = [
            { cluster_id: 0, note_title: 'A1' }, { cluster_id: 0, note_title: 'A2' },
            { cluster_id: 1, note_title: 'B1' }, { cluster_id: 1, note_title: 'B2' },
        ];

        const { points, metadata } = reduceVectors(db, {
            level: 'note', algo: 'pca', colorBy: 'cluster', clusters: providedClusters, ...EMB,
        });

        expect(metadata.cluster_source).toBe('external');
        expect(points.find((p) => p.title === 'A1').label).toBe(0);
        db.close();
    });

    it('throws for an unknown --color-by', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => reduceVectors(db, { level: 'note', algo: 'pca', colorBy: 'nope', ...EMB }))
            .toThrow(/unknown --color-by/);
        db.close();
    });

    it('throws for an unknown --algo', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);
        expect(() => reduceVectors(db, { level: 'note', algo: 'nope', ...EMB })).toThrow(/unknown --algo/);
        db.close();
    });
});

describe('reduceVectors: umap', () => {
    it('projects each point to --dims coordinates', () => {
        const db = makeTempDb();
        seedTwoGroups(db, insertChunk);

        const { points } = reduceVectors(
            db, { level: 'note', algo: 'umap', dims: 2, neighbors: 2, ...EMB },
        );

        expect(points).toHaveLength(4);
        for (const p of points) {
            expect(typeof p.x).toBe('number');
            expect(typeof p.y).toBe('number');
        }
        db.close();
    });
});

describe('tagFit', () => {
    it('reports similarity to the tag centroid, worst fit first', () => {
        const db = makeTempDb();
        const inGroup1 = insertNote(db, 'A1.md');
        const inGroup2 = insertNote(db, 'A2.md');
        const outlier = insertNote(db, 'A3.md');
        insertChunk(db, inGroup1, { seed: 0.1 });
        insertChunk(db, inGroup2, { seed: 0.1 });
        insertChunk(db, outlier, { seed: 0.9 });
        tagNote(db, inGroup1, 'project');
        tagNote(db, inGroup2, 'project');
        tagNote(db, outlier, 'project');

        const rows = tagFit(db, { ...EMB });

        expect(rows).toHaveLength(3);
        expect(rows[0].note_title).toBe('A3');
        expect(rows[0].tag).toBe('project');
        expect(rows[0].similarity_to_centroid).toBeLessThan(rows[1].similarity_to_centroid);
        db.close();
    });

    it('skips a tag with only one member note', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        insertChunk(db, noteId, { seed: 0.1 });
        tagNote(db, noteId, 'solo');

        expect(tagFit(db, { ...EMB })).toEqual([]);
        db.close();
    });

    it('--tag restricts to a single tag', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.1 });
        tagNote(db, a, 'project');
        tagNote(db, b, 'other');
        const c = insertNote(db, 'C.md');
        insertChunk(db, c, { seed: 0.1 });
        tagNote(db, b, 'project');
        tagNote(db, c, 'other');

        const rows = tagFit(db, { tag: 'project', ...EMB });

        expect(rows.every((r) => r.tag === 'project')).toBe(true);
        db.close();
    });

    it('--threshold only shows rows below that similarity', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        const c = insertNote(db, 'C.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.1 });
        insertChunk(db, c, { seed: 0.9 });
        tagNote(db, a, 'project');
        tagNote(db, b, 'project');
        tagNote(db, c, 'project');

        const rows = tagFit(db, { threshold: 0.9, ...EMB });

        expect(rows.map((r) => r.note_title)).toEqual([ 'C' ]);
        db.close();
    });
});

describe('tagRedundancy', () => {
    it('flags tag pairs above the threshold, most similar first', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        const c = insertNote(db, 'C.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.1 });
        insertChunk(db, c, { seed: 0.9 });
        tagNote(db, a, 'alpha');
        tagNote(db, b, 'beta');
        tagNote(db, c, 'gamma');

        const rows = tagRedundancy(db, { threshold: 0.9, ...EMB });

        expect(rows).toHaveLength(1);
        expect([ rows[0].tag_a, rows[0].tag_b ]).toEqual([ 'alpha', 'beta' ]);
        db.close();
    });

    it('throws when --threshold is missing', () => {
        const db = makeTempDb();
        expect(() => tagRedundancy(db, { ...EMB })).toThrow(/--threshold is required/);
        db.close();
    });

    it('includes tags with a single member note (unlike tag-fit)', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.1 });
        tagNote(db, a, 'solo-a');
        tagNote(db, b, 'solo-b');

        const rows = tagRedundancy(db, { threshold: 0.5, ...EMB });

        expect(rows).toHaveLength(1);
        db.close();
    });
});

describe('findOutliers: isolated mode', () => {
    it('ranks the least-similar-to-anything point first', () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const outlier = insertNote(db, 'Outlier.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, outlier, { seed: 0.9 });

        const rows = findOutliers(db, { level: 'note', mode: 'isolated', ...EMB });

        expect(rows[0].note_title).toBe('Outlier');
        db.close();
    });

    it('--threshold only keeps rows below that similarity', () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const outlier = insertNote(db, 'Outlier.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, outlier, { seed: 0.9 });

        const rows = findOutliers(db, { level: 'note', mode: 'isolated', threshold: 0.9, ...EMB });

        expect(rows.map((r) => r.note_title)).toEqual([ 'Outlier' ]);
        db.close();
    });

    it('--top limits the result count', () => {
        const db = makeTempDb();
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, `N${i}.md`);
            insertChunk(db, noteId, { seed: 0.1 * i });
        }

        const rows = findOutliers(db, { level: 'note', mode: 'isolated', top: 2, ...EMB });

        expect(rows).toHaveLength(2);
        db.close();
    });

    it('throws for fewer than 2 points', () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        insertChunk(db, noteId, { seed: 0.1 });
        expect(() => findOutliers(db, { level: 'note', mode: 'isolated', ...EMB }))
            .toThrow(/at least 2 points/);
        db.close();
    });
});

describe('findOutliers: bridge mode', () => {
    it('scores a point sitting between two clusters higher than a firmly-in-cluster point', () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const b1 = insertNote(db, 'B1.md');
        const b2 = insertNote(db, 'B2.md');
        const middle = insertNote(db, 'Middle.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, b1, { seed: 0.9 });
        insertChunk(db, b2, { seed: 0.9 });
        insertChunk(db, middle, { seed: 0.5 });

        const membership = [
            { cluster_id: 0, note_title: 'A1' }, { cluster_id: 0, note_title: 'A2' },
            { cluster_id: 1, note_title: 'B1' }, { cluster_id: 1, note_title: 'B2' },
            { cluster_id: 0, note_title: 'Middle' },
        ];
        const rows = findOutliers(db, { level: 'note', mode: 'bridge', clusters: membership, ...EMB });

        expect(rows[0].note_title).toBe('Middle');
        expect(rows[0].cluster_a).toBeDefined();
        expect(rows[0].cluster_b).toBeDefined();
        db.close();
    });

    it('excludes noise points (cluster_id -1) from scoring', () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const b1 = insertNote(db, 'B1.md');
        const b2 = insertNote(db, 'B2.md');
        const noise = insertNote(db, 'Noise.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, b1, { seed: 0.9 });
        insertChunk(db, b2, { seed: 0.9 });
        insertChunk(db, noise, { seed: 0.5 });

        const membership = [
            { cluster_id: 0, note_title: 'A1' }, { cluster_id: 0, note_title: 'A2' },
            { cluster_id: 1, note_title: 'B1' }, { cluster_id: 1, note_title: 'B2' },
            { cluster_id: -1, note_title: 'Noise' },
        ];
        const rows = findOutliers(db, { level: 'note', mode: 'bridge', clusters: membership, ...EMB });

        expect(rows.some((r) => r.note_title === 'Noise')).toBe(false);
        db.close();
    });

    it('--top limits the result count', () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const b1 = insertNote(db, 'B1.md');
        const b2 = insertNote(db, 'B2.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, b1, { seed: 0.9 });
        insertChunk(db, b2, { seed: 0.9 });

        const membership = [
            { cluster_id: 0, note_title: 'A1' }, { cluster_id: 0, note_title: 'A2' },
            { cluster_id: 1, note_title: 'B1' }, { cluster_id: 1, note_title: 'B2' },
        ];
        const rows = findOutliers(db, { level: 'note', mode: 'bridge', clusters: membership, top: 1, ...EMB });

        expect(rows).toHaveLength(1);
        db.close();
    });

    it('throws when --clusters is missing', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.9 });
        expect(() => findOutliers(db, { level: 'note', mode: 'bridge', ...EMB }))
            .toThrow(/requires --clusters/);
        db.close();
    });

    it('throws when --clusters has fewer than 2 non-noise clusters', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.9 });
        const membership = [
            { cluster_id: 0, note_title: 'A' }, { cluster_id: 0, note_title: 'B' },
        ];
        expect(() => findOutliers(db, { level: 'note', mode: 'bridge', clusters: membership, ...EMB }))
            .toThrow(/at least 2 non-noise clusters/);
        db.close();
    });
});

describe('findOutliers: validation', () => {
    it('throws for an unknown --mode', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.9 });
        expect(() => findOutliers(db, { level: 'note', mode: 'nope', ...EMB })).toThrow(/unknown --mode/);
        db.close();
    });
});

describe('calibrate', () => {
    it('includes every resolvable linked pair with no sampling', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        const c = insertNote(db, 'C.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.2 });
        insertChunk(db, c, { seed: 0.3 });
        linkNotes(db, a, 'B');
        linkNotes(db, b, 'C');

        const { linked } = calibrate(db, { level: 'note', sampleSize: 10, ...EMB });

        expect(linked).toHaveLength(2);
        expect(linked.every((r) => typeof r.similarity === 'number')).toBe(true);
        db.close();
    });

    it('excludes links to a non-existent (broken) target', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        insertChunk(db, a, { seed: 0.1 });
        linkNotes(db, a, 'Nonexistent');

        const { linked } = calibrate(db, { level: 'note', sampleSize: 10, ...EMB });

        expect(linked).toEqual([]);
        db.close();
    });

    it('excludes a self-link', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        insertChunk(db, a, { seed: 0.1 });
        linkNotes(db, a, 'A');

        const { linked } = calibrate(db, { level: 'note', sampleSize: 10, ...EMB });

        expect(linked).toEqual([]);
        db.close();
    });

    it('samples up to --sample-size unlinked pairs, excluding linked ones', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        const c = insertNote(db, 'C.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.2 });
        insertChunk(db, c, { seed: 0.3 });
        linkNotes(db, a, 'B');

        const { unlinked } = calibrate(db, { level: 'note', sampleSize: 10, ...EMB });

        // A-B is linked, so only A-C and B-C are eligible unlinked pairs.
        expect(unlinked).toHaveLength(2);
        const pairs = unlinked.map((r) => [ r.note_a, r.note_b ].sort().join('-'));
        expect(pairs.sort()).toEqual([ 'A-C', 'B-C' ]);
        db.close();
    });

    it('--level chunk uses the best chunk-pair similarity (mirroring compare --aggregate=best-chunk)', () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { chunkIndex: 0, seed: 0.1 });
        insertChunk(db, a, { chunkIndex: 1, seed: 0.9 });
        insertChunk(db, b, { seed: 0.9 });
        linkNotes(db, a, 'B');

        const { linked } = calibrate(db, { level: 'chunk', sampleSize: 10, ...EMB });

        expect(linked[0].similarity).toBeCloseTo(1, 5);
        db.close();
    });

    it('returns empty populations for a vault with fewer than 2 notes', () => {
        const db = makeTempDb();
        const { linked, unlinked } = calibrate(db, { level: 'note', sampleSize: 10, ...EMB });
        expect(linked).toEqual([]);
        expect(unlinked).toEqual([]);
        db.close();
    });
});
