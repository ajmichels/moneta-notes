import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function linkNotes(db, sourceNoteId, targetTitle) {
    db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)').run(sourceNoteId, targetTitle);
}

function tagNote(db, noteId, tagName) {
    db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(tagName);
    const { id: tagId } = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);
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

describe('mnotes vectors reduce', () => {
    it('streams a coordinates-only header + one CSV row per point to stdout by default', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand([ 'reduce', '--algo', 'pca' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        const lines = result.stdout.trim().split('\n');
        expect(lines[0]).toBe('x,y');
        expect(lines).toHaveLength(5);
        db.close();
    });

    it('default output has no extra columns, so a positional scatter tool plots one clean series', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand([ 'reduce', '--algo', 'pca' ], makeDeps(db));

        const [ header, firstRow ] = result.stdout.trim().split('\n');
        expect(header.split(',')).toEqual([ 'x', 'y' ]);
        const cells = firstRow.split(',');
        expect(cells).toHaveLength(2);
        expect(cells.every((c) => !Number.isNaN(Number(c)))).toBe(true);
        db.close();
    });

    it('--dims=3 adds a z column — --dims=2 omits it entirely', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const dims2 = await runVectorsCommand([ 'reduce', '--algo', 'pca', '--dims', '2' ], makeDeps(db));
        const dims3 = await runVectorsCommand([ 'reduce', '--algo', 'pca', '--dims', '3' ], makeDeps(db));

        expect(dims2.stdout.split('\n')[0]).toBe('x,y');
        expect(dims3.stdout.split('\n')[0]).toBe('x,y,z');
        db.close();
    });

    it('--metadata appends id,title,label after the coordinate columns', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--metadata' ], makeDeps(db),
        );

        expect(result.stdout.split('\n')[0]).toBe('x,y,id,title,label');
        db.close();
    });

    it('--metadata --level=chunk adds chunk_line_start/chunk_line_end too', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--level', 'chunk', '--metadata' ], makeDeps(db),
        );

        expect(result.stdout.split('\n')[0]).toBe('x,y,id,title,chunk_line_start,chunk_line_end,label');
        db.close();
    });

    it('--format json prints { points, metadata }', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--format', 'json' ], makeDeps(db),
        );

        const parsed = JSON.parse(result.stdout);
        expect(parsed.points).toHaveLength(4);
        expect(parsed.metadata).toEqual({ cluster_source: null });
        db.close();
    });

    it('--output writes to a file instead of stdout', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);
        const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-vectors-out-'));
        tempDirs.push(dir);
        const outPath = join(dir, 'out.csv');

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--output', outPath ], makeDeps(db),
        );

        expect(result.stdout).toContain(`wrote 4 points to ${outPath}`);
        expect(readFileSync(outPath, 'utf8')).toContain('x,y');
        db.close();
    });

    it('--level chunk still reduces at chunk granularity (coords-only output, same as note level)', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--level', 'chunk' ], makeDeps(db),
        );

        expect(result.stdout.split('\n')[0]).toBe('x,y');
        db.close();
    });

    it('--color-by cluster runs an internal kmeans by default (cluster_source: internal)', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--color-by', 'cluster', '--format', 'json' ], makeDeps(db),
        );

        expect(JSON.parse(result.stdout).metadata.cluster_source).toBe('internal');
        db.close();
    });

    it('--clusters points at a saved cluster membership file (cluster_source: external)', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);
        const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-vectors-clusters-'));
        tempDirs.push(dir);
        const clustersPath = join(dir, 'clusters.json');
        writeFileSync(clustersPath, JSON.stringify([
            { cluster_id: 0, note_title: 'A1' }, { cluster_id: 0, note_title: 'A2' },
            { cluster_id: 1, note_title: 'B1' }, { cluster_id: 1, note_title: 'B2' },
        ]));

        const result = await runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--color-by', 'cluster', '--clusters', clustersPath, '--format', 'json' ],
            makeDeps(db),
        );

        expect(JSON.parse(result.stdout).metadata.cluster_source).toBe('external');
        db.close();
    });

    it('requires --algo', async () => {
        const db = makeTempDb();
        await expect(runVectorsCommand([ 'reduce' ], makeDeps(db))).rejects.toThrow(/--algo is required/);
        db.close();
    });

    it('rejects --neighbors/--min-dist combined with --algo pca', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);
        await expect(runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--neighbors', '5' ], makeDeps(db),
        )).rejects.toThrow(/not valid with --algo pca/);
        db.close();
    });

    it('rejects an invalid --dims', async () => {
        const db = makeTempDb();
        seedTwoGroups(db);
        await expect(runVectorsCommand(
            [ 'reduce', '--algo', 'pca', '--dims', '4' ], makeDeps(db),
        )).rejects.toThrow(/--dims must be 2 or 3/);
        db.close();
    });
});

describe('mnotes vectors tag-fit', () => {
    it('prints a tag | note_title | similarity_to_centroid table by default', async () => {
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

        const result = await runVectorsCommand([ 'tag-fit' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('similarity_to_centroid');
        expect(result.stdout).toContain('C');
        db.close();
    });

    it('--format json prints structured rows', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.9 });
        tagNote(db, a, 'project');
        tagNote(db, b, 'project');

        const result = await runVectorsCommand([ 'tag-fit', '--format', 'json' ], makeDeps(db));

        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toEqual({
            tag: 'project', note_title: expect.any(String), similarity_to_centroid: expect.any(Number),
        });
        db.close();
    });

    it('--tag restricts to a single tag', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.9 });
        tagNote(db, a, 'project');
        tagNote(db, b, 'project');
        tagNote(db, b, 'other');
        const c = insertNote(db, 'C.md');
        insertChunk(db, c, { seed: 0.5 });
        tagNote(db, c, 'other');

        const result = await runVectorsCommand([ 'tag-fit', '--tag', 'other', '--format', 'json' ], makeDeps(db));

        const parsed = JSON.parse(result.stdout);
        expect(parsed.every((r) => r.tag === 'other')).toBe(true);
        db.close();
    });
});

describe('mnotes vectors tag-redundancy', () => {
    it('requires --threshold', async () => {
        const db = makeTempDb();
        await expect(runVectorsCommand([ 'tag-redundancy' ], makeDeps(db)))
            .rejects.toThrow(/--threshold is required/);
        db.close();
    });

    it('prints a tag_a | tag_b | centroid_similarity table by default', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.1 });
        tagNote(db, a, 'alpha');
        tagNote(db, b, 'beta');

        const result = await runVectorsCommand([ 'tag-redundancy', '--threshold', '0.5' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('centroid_similarity');
        expect(result.stdout).toContain('alpha');
        db.close();
    });

    it('--format json prints structured rows', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.1 });
        tagNote(db, a, 'alpha');
        tagNote(db, b, 'beta');

        const result = await runVectorsCommand(
            [ 'tag-redundancy', '--threshold', '0.5', '--format', 'json' ], makeDeps(db),
        );

        expect(JSON.parse(result.stdout)).toEqual([
            { tag_a: 'alpha', tag_b: 'beta', centroid_similarity: expect.any(Number) },
        ]);
        db.close();
    });
});

describe('mnotes vectors outliers', () => {
    it('isolated mode prints a note_title | nearest_neighbor_similarity table by default', async () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const outlier = insertNote(db, 'Outlier.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, outlier, { seed: 0.9 });

        const result = await runVectorsCommand([ 'outliers', '--mode', 'isolated' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('nearest_neighbor_similarity');
        expect(result.stdout).toContain('Outlier');
        db.close();
    });

    it('isolated --format json prints structured rows', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.9 });

        const result = await runVectorsCommand(
            [ 'outliers', '--mode', 'isolated', '--format', 'json' ], makeDeps(db),
        );

        expect(JSON.parse(result.stdout)).toHaveLength(2);
        db.close();
    });

    it('bridge mode reads --clusters from a file and prints cluster_a/cluster_b/bridge_score', async () => {
        const db = makeTempDb();
        const a1 = insertNote(db, 'A1.md');
        const a2 = insertNote(db, 'A2.md');
        const b1 = insertNote(db, 'B1.md');
        const b2 = insertNote(db, 'B2.md');
        insertChunk(db, a1, { seed: 0.1 });
        insertChunk(db, a2, { seed: 0.1 });
        insertChunk(db, b1, { seed: 0.9 });
        insertChunk(db, b2, { seed: 0.9 });
        const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-vectors-clusters2-'));
        tempDirs.push(dir);
        const clustersPath = join(dir, 'clusters.json');
        writeFileSync(clustersPath, JSON.stringify([
            { cluster_id: 0, note_title: 'A1' }, { cluster_id: 0, note_title: 'A2' },
            { cluster_id: 1, note_title: 'B1' }, { cluster_id: 1, note_title: 'B2' },
        ]));

        const result = await runVectorsCommand(
            [ 'outliers', '--mode', 'bridge', '--clusters', clustersPath ], makeDeps(db),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('bridge_score');
        db.close();
    });

    it('requires --mode', async () => {
        const db = makeTempDb();
        await expect(runVectorsCommand([ 'outliers' ], makeDeps(db)))
            .rejects.toThrow(/--mode is required/);
        db.close();
    });

    it('rejects --threshold combined with --mode bridge', async () => {
        const db = makeTempDb();
        await expect(runVectorsCommand(
            [ 'outliers', '--mode', 'bridge', '--threshold', '0.5' ], makeDeps(db),
        )).rejects.toThrow(/not valid with --mode bridge/);
        db.close();
    });

    it('rejects --threshold combined with --top in isolated mode', async () => {
        const db = makeTempDb();
        await expect(runVectorsCommand(
            [ 'outliers', '--mode', 'isolated', '--threshold', '0.5', '--top', '3' ], makeDeps(db),
        )).rejects.toThrow(/mutually exclusive/);
        db.close();
    });
});

describe('mnotes vectors calibrate', () => {
    it('prints a population | count | p10..p90 table by default', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        const c = insertNote(db, 'C.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.2 });
        insertChunk(db, c, { seed: 0.3 });
        linkNotes(db, a, 'B');

        const result = await runVectorsCommand([ 'calibrate' ], makeDeps(db));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('population');
        expect(result.stdout).toContain('linked');
        expect(result.stdout).toContain('unlinked');
        db.close();
    });

    it('--format json prints raw linked/unlinked pairs', async () => {
        const db = makeTempDb();
        const a = insertNote(db, 'A.md');
        const b = insertNote(db, 'B.md');
        insertChunk(db, a, { seed: 0.1 });
        insertChunk(db, b, { seed: 0.2 });
        linkNotes(db, a, 'B');

        const result = await runVectorsCommand([ 'calibrate', '--format', 'json' ], makeDeps(db));

        const parsed = JSON.parse(result.stdout);
        expect(parsed.linked).toHaveLength(1);
        expect(parsed.unlinked).toEqual([]);
        db.close();
    });

    it('--sample-size overrides the default sample size', async () => {
        const db = makeTempDb();
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, `N${i}.md`);
            insertChunk(db, noteId, { seed: 0.1 * i });
        }

        const result = await runVectorsCommand(
            [ 'calibrate', '--sample-size', '2', '--format', 'json' ], makeDeps(db),
        );

        expect(JSON.parse(result.stdout).unlinked.length).toBeLessThanOrEqual(2);
        db.close();
    });

    it('defaults --sample-size from config.vectors.calibrate_sample_size', async () => {
        const db = makeTempDb();
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, `N${i}.md`);
            insertChunk(db, noteId, { seed: 0.1 * i });
        }

        const deps = { ...makeDeps(db), config: { vectors: { calibrate_sample_size: 1 } } };
        const result = await runVectorsCommand([ 'calibrate', '--format', 'json' ], deps);

        expect(JSON.parse(result.stdout).unlinked).toHaveLength(1);
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

describe('mnotes vectors: help output', () => {
    it('no subcommand prints the overview listing every subcommand', async () => {
        const result = await runVectorsCommand([], {});
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Subcommands:');
        for (const name of [
            'compare', 'nearest', 'cluster', 'reduce', 'tag-fit', 'tag-redundancy', 'outliers', 'calibrate',
        ]) {
            expect(result.stdout).toContain(name);
        }
    });

    it('"vectors --help" and "vectors -h" print the same overview', async () => {
        const long = await runVectorsCommand([ '--help' ], {});
        const short = await runVectorsCommand([ '-h' ], {});
        expect(long.stdout).toBe(short.stdout);
        expect(long.stdout).toContain('Subcommands:');
    });

    it.each([
        'compare', 'nearest', 'cluster', 'reduce', 'tag-fit', 'tag-redundancy', 'outliers', 'calibrate',
    ])('"vectors %s --help" prints that subcommand\'s own usage and flags, without invoking it', async (sub) => {
        const result = await runVectorsCommand([ sub, '--help' ], {});
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Usage: mnotes vectors ${sub}`);
        expect(result.stdout).toContain('Flags:');
    });

    it('"-h" is also recognized, not just "--help"', async () => {
        const result = await runVectorsCommand([ 'compare', '-h' ], {});
        expect(result.stdout).toContain('Usage: mnotes vectors compare');
    });

    it('--help can appear anywhere in the subcommand args, not just first', async () => {
        const result = await runVectorsCommand([ 'compare', 'a', 'b', '--help' ], {});
        expect(result.stdout).toContain('Usage: mnotes vectors compare');
    });

    it('an unknown subcommand with --help is still reported as unknown, not shown help', async () => {
        const result = await runVectorsCommand([ 'bogus', '--help' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown vectors subcommand/);
    });
});
