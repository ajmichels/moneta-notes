import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { vectorToBuffer } from '../core/vectors.js';
import { runVectorsCommand } from './vectors.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

function makeTempDb() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-vectors-test-'));
    tempDirs.push(dir);
    return openDb(join(dir, 'index.db')).db;
}

function insertNote(db, path) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'hash', 10, 1000, 1000);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function makeVector(seed, dims = 1024) {
    const vector = new Float32Array(dims);
    let state = Math.floor(seed * 1e6) + 1;
    for (let i = 0; i < dims; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        vector[i] = (state % 1000) / 1000;
    }
    return vector;
}

function insertChunk(db, noteId, { chunkIndex = 0, seed, lineStart = 1, lineEnd = 1 } = {}) {
    db.prepare(`
        INSERT INTO chunks
            (note_id, chunk_index, char_start, char_end, line_start, line_end, token_count,
             embedding_model, embedding_version)
        VALUES (?, ?, 0, 100, ?, ?, 50, 'test-model', 'v1')
    `).run(noteId, chunkIndex, lineStart, lineEnd);
    const chunkId = db.prepare(
        'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
    ).get(noteId, chunkIndex).id;
    db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
        chunkId, vectorToBuffer(makeVector(seed)),
    );
    return chunkId;
}

function makeDeps(db) {
    return { db, embeddingModel: 'test-model', embeddingVersion: 'v1' };
}

describe('mnotes vectors compare', () => {
    it('prints a plain similarity line by default (note-level, centroid)', async () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.1 });

        const result = await runVectorsCommand([ 'compare', 'A', 'B' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^similarity: /);
        db.close();
    });

    it('--json prints structured JSON', async () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.1 });

        const result = await runVectorsCommand([ 'compare', 'A', 'B', '--json' ], makeDeps(db));

        expect(JSON.parse(result.stdout)).toEqual({ similarity: expect.any(Number) });
        db.close();
    });

    it('--level chunk compares two raw chunk ids', async () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkA = insertChunk(db, noteId, { chunkIndex: 0, seed: 0.1 });
        const chunkB = insertChunk(db, noteId, { chunkIndex: 1, seed: 0.1 });

        const result = await runVectorsCommand(
            [ 'compare', String(chunkA), String(chunkB), '--level', 'chunk' ], makeDeps(db),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^similarity: /);
        db.close();
    });

    it('rejects --aggregate combined with --level chunk', async () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkA = insertChunk(db, noteId, { chunkIndex: 0, seed: 0.1 });
        const chunkB = insertChunk(db, noteId, { chunkIndex: 1, seed: 0.1 });

        await expect(runVectorsCommand(
            [ 'compare', String(chunkA), String(chunkB), '--level', 'chunk', '--aggregate', 'best-chunk' ],
            makeDeps(db),
        )).rejects.toThrow(/not valid with --level chunk/);
        db.close();
    });

    it('--aggregate best-chunk includes chunk_a/chunk_b line spans, JSON-only text output', async () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1, lineStart: 3, lineEnd: 7 });
        insertChunk(db, noteB, { seed: 0.1, lineStart: 20, lineEnd: 25 });

        const result = await runVectorsCommand(
            [ 'compare', 'A', 'B', '--aggregate', 'best-chunk' ], makeDeps(db),
        );

        expect(result.stdout).toContain('chunk_a: L3-7');
        expect(result.stdout).toContain('chunk_b: L20-25');
        db.close();
    });

    it('--aggregate all-pairs always outputs JSON, ignoring the absence of --json', async () => {
        const db = makeTempDb();
        const noteA = insertNote(db, 'A.md');
        const noteB = insertNote(db, 'B.md');
        insertChunk(db, noteA, { seed: 0.1 });
        insertChunk(db, noteB, { seed: 0.2 });

        const result = await runVectorsCommand(
            [ 'compare', 'A', 'B', '--aggregate', 'all-pairs' ], makeDeps(db),
        );

        const parsed = JSON.parse(result.stdout);
        expect(parsed.matrix).toEqual([ [ expect.any(Number) ] ]);
        db.close();
    });
});

describe('mnotes vectors nearest', () => {
    it('ranks by similarity, rank-only by default (no similarity column)', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        const close = insertNote(db, 'Close.md');
        insertChunk(db, query, { seed: 0.5 });
        insertChunk(db, close, { seed: 0.5 });

        const result = await runVectorsCommand([ 'nearest', 'Query' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Close');
        expect(result.stdout).not.toMatch(/similarity/);
        db.close();
    });

    it('--score includes a similarity column', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        const close = insertNote(db, 'Close.md');
        insertChunk(db, query, { seed: 0.5 });
        insertChunk(db, close, { seed: 0.5 });

        const result = await runVectorsCommand([ 'nearest', 'Query', '--score' ], makeDeps(db));

        expect(result.stdout).toMatch(/similarity/);
        db.close();
    });

    it('--json prints structured JSON', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        const close = insertNote(db, 'Close.md');
        insertChunk(db, query, { seed: 0.5 });
        insertChunk(db, close, { seed: 0.5 });

        const result = await runVectorsCommand([ 'nearest', 'Query', '--json' ], makeDeps(db));

        const parsed = JSON.parse(result.stdout);
        expect(parsed).toEqual([ { rank: 1, similarity: expect.any(Number), note_title: 'Close' } ]);
        db.close();
    });

    it('--k limits the result count', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        insertChunk(db, query, { seed: 0.5 });
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, `N${i}.md`);
            insertChunk(db, noteId, { seed: 0.1 * i });
        }

        const result = await runVectorsCommand([ 'nearest', 'Query', '--k', '2', '--json' ], makeDeps(db));

        expect(JSON.parse(result.stdout)).toHaveLength(2);
        db.close();
    });

    it('defaults --k from config.vectors.nearest_k_default', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        insertChunk(db, query, { seed: 0.5 });
        for (let i = 0; i < 3; i += 1) {
            const noteId = insertNote(db, `N${i}.md`);
            insertChunk(db, noteId, { seed: 0.1 * i });
        }

        const deps = { ...makeDeps(db), config: { vectors: { nearest_k_default: 1 } } };
        const result = await runVectorsCommand([ 'nearest', 'Query', '--json' ], deps);

        expect(JSON.parse(result.stdout)).toHaveLength(1);
        db.close();
    });

    it('--against chunk includes chunk line span columns', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        const other = insertNote(db, 'Other.md');
        insertChunk(db, query, { seed: 0.5 });
        insertChunk(db, other, { seed: 0.5, lineStart: 3, lineEnd: 9 });

        const result = await runVectorsCommand([ 'nearest', 'Query', '--against', 'chunk' ], makeDeps(db));

        expect(result.stdout).toContain('3');
        expect(result.stdout).toContain('9');
        db.close();
    });

    it('rejects --aggregate combined with --level chunk', async () => {
        const db = makeTempDb();
        const noteId = insertNote(db, 'A.md');
        const chunkA = insertChunk(db, noteId, { seed: 0.5 });

        await expect(runVectorsCommand(
            [ 'nearest', String(chunkA), '--level', 'chunk', '--aggregate', 'best-chunk' ], makeDeps(db),
        )).rejects.toThrow(/not valid with --level chunk/);
        db.close();
    });

    it('rejects an unsupported --aggregate value', async () => {
        const db = makeTempDb();
        const query = insertNote(db, 'Query.md');
        insertChunk(db, query, { seed: 0.5 });

        await expect(runVectorsCommand(
            [ 'nearest', 'Query', '--aggregate', 'all-pairs' ], makeDeps(db),
        )).rejects.toThrow(/--aggregate must be one of/);
        db.close();
    });
});

function seedTwoGroups(db) {
    const groupA = [ insertNote(db, 'A1.md'), insertNote(db, 'A2.md') ];
    const groupB = [ insertNote(db, 'B1.md'), insertNote(db, 'B2.md') ];
    for (const noteId of groupA) {
        insertChunk(db, noteId, { seed: 0.1 });
    }
    for (const noteId of groupB) {
        insertChunk(db, noteId, { seed: 0.9 });
    }
}

describe('mnotes vectors cluster', () => {
    it('prints an aligned cluster_id | size | example_titles table by default', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand([ 'cluster', '--algo', 'kmeans', '--k', '2' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('cluster_id');
        expect(result.stdout).toContain('example_titles');
        db.close();
    });

    it('--format json prints full membership', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'cluster', '--algo', 'kmeans', '--k', '2', '--format', 'json' ], makeDeps(db),
        );

        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveLength(4);
        expect(parsed[0]).toEqual({ cluster_id: expect.any(Number), note_title: expect.any(String) });
        db.close();
    });

    it('--algo dbscan with --epsilon/--min-points separates the two groups', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'cluster', '--algo', 'dbscan', '--epsilon', '0.1', '--min-points', '2', '--format', 'json' ],
            makeDeps(db),
        );

        const parsed = JSON.parse(result.stdout);
        const byTitle = Object.fromEntries(parsed.map((r) => [ r.note_title, r.cluster_id ]));
        expect(byTitle.A1).toBe(byTitle.A2);
        expect(byTitle.B1).toBe(byTitle.B2);
        expect(byTitle.A1).not.toBe(byTitle.B1);
        db.close();
    });

    it('requires --algo', async () => {
        const db = makeTempDb();
        await expect(runVectorsCommand([ 'cluster' ], makeDeps(db))).rejects.toThrow(/--algo is required/);
        db.close();
    });

    it('surfaces core validation errors (e.g. --k missing for kmeans)', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);
        await expect(runVectorsCommand([ 'cluster', '--algo', 'kmeans' ], makeDeps(db)))
            .rejects.toThrow(/--k is required/);
        db.close();
    });
});

describe('mnotes vectors: unknown subcommand', () => {
    it('returns a non-zero exit code with an error on stderr', async () => {
        const db = makeTempDb();
        const result = await runVectorsCommand([ 'nope' ], makeDeps(db));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown vectors subcommand/);
        db.close();
    });
});
