import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { search, explainSearch } from './search.js';
import { getLogger, runWithLogger } from '../logger.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

function insertNote(db, { path, contentHash = 'hash', lineCount = 10, mtime = 1000 }) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, contentHash, lineCount, mtime, mtime);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function insertFtsRow(db, noteId, title, body) {
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

function insertChunkWithVector(db, noteId, {
    chunkIndex = 0,
    seed,
    embeddingModel = 'test-model',
    embeddingVersion = 'v1',
    lineStart = 1,
    lineEnd = 1,
}) {
    db.prepare(`
        INSERT INTO chunks
            (note_id, chunk_index, char_start, char_end, line_start, line_end, token_count,
             embedding_model, embedding_version)
        VALUES (?, ?, 0, 100, ?, ?, 50, ?, ?)
    `).run(noteId, chunkIndex, lineStart, lineEnd, embeddingModel, embeddingVersion);

    const chunkId = db.prepare(
        'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
    ).get(noteId, chunkIndex).id;

    const vector = makeVector(seed);
    db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
        chunkId,
        Buffer.from(vector.buffer),
    );
    return chunkId;
}

// A constant-fill vector has the same *direction* regardless of magnitude, so two constant-fill
// vectors always have cosine distance 0 to each other no matter what seed produced them. Deriving
// each dimension from the seed via a simple deterministic PRNG instead gives genuinely different
// directions per seed (same seed always reproduces the same vector) so cosine distance actually
// differentiates "close" from "far" in these tests.
function makeVector(seed) {
    const vector = new Float32Array(1024);
    let state = Math.floor(seed * 1e6) + 1;
    for (let i = 0; i < 1024; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        vector[i] = (state % 1000) / 1000;
    }
    return vector;
}

function fakeEmbed(seed) {
    return async () => makeVector(seed);
}

describe('search: fulltext mode', () => {
    it('returns note_title (derived from path), file_line_count, and bm25_score for a MATCH hit', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Projects/Moneta.md', lineCount: 42 });
        insertFtsRow(db, noteId, 'Moneta', 'notes about a personal knowledge graph');

        const results = await search(db, { query: 'knowledge graph', mode: 'fulltext', limit: 20 });

        expect(results).toEqual([
            { note_title: 'Projects/Moneta', file_line_count: 42, bm25_score: expect.any(Number) },
        ]);
        db.close();
    });

    it('ranks a note with more query-term occurrences above one with fewer', async () => {
        const { db } = openDb(':memory:');
        const strongId = insertNote(db, { path: 'Strong.md' });
        const weakId = insertNote(db, { path: 'Weak.md' });
        insertFtsRow(db, weakId, 'Weak', 'graph appears once here');
        insertFtsRow(db, strongId, 'Strong', 'graph graph graph graph everywhere, graph');

        const results = await search(db, { query: 'graph', mode: 'fulltext', limit: 20 });

        expect(results.map((r) => r.note_title)).toEqual([ 'Strong', 'Weak' ]);
        db.close();
    });

    it('truncates to limit after over-fetching', async () => {
        const { db } = openDb(':memory:');
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, { path: `Note${i}.md` });
            insertFtsRow(db, noteId, `Note${i}`, 'shared term');
        }

        const results = await search(db, { query: 'shared', mode: 'fulltext', limit: 2 });

        expect(results).toHaveLength(2);
        db.close();
    });

    it('throws when query is missing', async () => {
        const { db } = openDb(':memory:');
        await expect(search(db, { mode: 'fulltext', limit: 20 })).rejects.toThrow(/query/);
        db.close();
    });
});

describe('search: semantic mode', () => {
    it('returns the note whose chunk vector is closest to the query embedding', async () => {
        const { db } = openDb(':memory:');
        const closeId = insertNote(db, { path: 'Close.md', lineCount: 5 });
        const farId = insertNote(db, { path: 'Far.md', lineCount: 5 });
        insertChunkWithVector(db, closeId, { seed: 0.5 });
        insertChunkWithVector(db, farId, { seed: 0.9 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].note_title).toBe('Close');
        expect(typeof results[0].cosine_distance).toBe('number');
        db.close();
    });

    it('collapses multiple chunk hits from the same note to one row (best chunk wins)', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Multi.md' });
        insertChunkWithVector(db, noteId, { chunkIndex: 0, seed: 0.9 });
        insertChunkWithVector(db, noteId, { chunkIndex: 1, seed: 0.5 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results).toHaveLength(1);
        expect(results[0].note_title).toBe('Multi');
        db.close();
    });

    it("includes the winning chunk's line span as chunk_line_start/chunk_line_end", async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Lines.md' });
        insertChunkWithVector(db, noteId, { seed: 0.5, lineStart: 12, lineEnd: 18 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].chunk_line_start).toBe(12);
        expect(results[0].chunk_line_end).toBe(18);
        db.close();
    });

    it("reports the winning (closest) chunk's line span, not another chunk's, on a multi-chunk note", async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Multi.md' });
        insertChunkWithVector(db, noteId, { chunkIndex: 0, seed: 0.9, lineStart: 1, lineEnd: 5 });
        insertChunkWithVector(db, noteId, { chunkIndex: 1, seed: 0.5, lineStart: 40, lineEnd: 55 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].chunk_line_start).toBe(40);
        expect(results[0].chunk_line_end).toBe(55);
        db.close();
    });

    it('excludes chunks from a stale embedding_model/version', async () => {
        const { db } = openDb(':memory:');
        const staleId = insertNote(db, { path: 'Stale.md' });
        insertChunkWithVector(db, staleId, {
            seed: 0.5,
            embeddingModel: 'old-model',
            embeddingVersion: 'v0',
        });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results).toHaveLength(0);
        db.close();
    });

    it('throws when no embed function is provided', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, {
                query: 'x',
                mode: 'semantic',
                limit: 20,
                embeddingModel: 'test-model',
                embeddingVersion: 'v1',
            }),
        ).rejects.toThrow(/embed/);
        db.close();
    });
});

describe('search: hybrid mode', () => {
    it('defaults to hybrid mode when mode is omitted', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Both.md' });
        insertFtsRow(db, noteId, 'Both', 'graph search');
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const results = await search(db, {
            query: 'graph',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].note_title).toBe('Both');
        expect(results[0].fulltext_rank).toBe(1);
        expect(results[0].semantic_rank).toBe(1);
        db.close();
    });

    it('includes a note found by only one side, with the other rank null', async () => {
        const { db } = openDb(':memory:');
        const fulltextOnlyId = insertNote(db, { path: 'FulltextOnly.md' });
        insertFtsRow(db, fulltextOnlyId, 'FulltextOnly', 'graph search');
        // no chunk/vector row for this note — it can never appear on the semantic side

        const results = await search(db, {
            query: 'graph',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.1),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].note_title).toBe('FulltextOnly');
        expect(results[0].fulltext_rank).toBe(1);
        expect(results[0].semantic_rank).toBeNull();
        expect(results[0].chunk_line_start).toBeNull();
        expect(results[0].chunk_line_end).toBeNull();
        db.close();
    });

    it('includes chunk_line_start/chunk_line_end for a note that matched (partly) via the semantic side', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Both.md' });
        insertFtsRow(db, noteId, 'Both', 'graph search');
        insertChunkWithVector(db, noteId, { seed: 0.5, lineStart: 4, lineEnd: 9 });

        const results = await search(db, {
            query: 'graph',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].chunk_line_start).toBe(4);
        expect(results[0].chunk_line_end).toBe(9);
        db.close();
    });

    it('ranks a note appearing on both sides above one appearing on only one side', async () => {
        const { db } = openDb(':memory:');
        const bothId = insertNote(db, { path: 'Both.md', mtime: 1000 });
        const fulltextOnlyId = insertNote(db, { path: 'FulltextOnly.md', mtime: 1000 });
        insertFtsRow(db, bothId, 'Both', 'graph graph graph');
        insertFtsRow(db, fulltextOnlyId, 'FulltextOnly', 'graph graph graph graph graph');
        insertChunkWithVector(db, bothId, { seed: 0.5 });

        const results = await search(db, {
            query: 'graph',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        // fulltextOnlyId ranks #1 on the fulltext side alone (more term occurrences), but bothId
        // contributes RRF terms from *both* sides, which outweighs a single #1 vs. a #2 + a #1.
        expect(results[0].note_title).toBe('Both');
        db.close();
    });
});

describe('search: tie-breaking by mtime', () => {
    it('breaks an exact BM25 tie by mtime descending (fulltext mode)', async () => {
        const { db } = openDb(':memory:');
        const olderId = insertNote(db, { path: 'Older.md', mtime: 1000 });
        const newerId = insertNote(db, { path: 'Newer.md', mtime: 2000 });
        insertFtsRow(db, olderId, 'Older', 'shared term shared term');
        insertFtsRow(db, newerId, 'Newer', 'shared term shared term');

        const results = await search(db, { query: 'shared term', mode: 'fulltext', limit: 20 });

        expect(results.map((r) => r.note_title)).toEqual([ 'Newer', 'Older' ]);
        db.close();
    });

    it('breaks an exact cosine-distance tie by mtime descending (semantic mode)', async () => {
        const { db } = openDb(':memory:');
        const olderId = insertNote(db, { path: 'Older.md', mtime: 1000 });
        const newerId = insertNote(db, { path: 'Newer.md', mtime: 2000 });
        insertChunkWithVector(db, olderId, { seed: 0.5 });
        insertChunkWithVector(db, newerId, { seed: 0.5 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results.map((r) => r.note_title)).toEqual([ 'Newer', 'Older' ]);
        db.close();
    });

    it('breaks an exact RRF score tie by mtime descending (hybrid mode)', async () => {
        const { db } = openDb(':memory:');
        const olderId = insertNote(db, { path: 'Older.md', mtime: 1000 });
        const newerId = insertNote(db, { path: 'Newer.md', mtime: 2000 });
        insertFtsRow(db, olderId, 'Older', 'shared term');
        insertFtsRow(db, newerId, 'Newer', 'shared term');

        const results = await search(db, {
            query: 'shared term',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.1),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results.map((r) => r.note_title)).toEqual([ 'Newer', 'Older' ]);
        db.close();
    });
});

describe('search: limit validation', () => {
    it.each([
        [ 0 ],
        [ -1 ],
        [ 101 ],
        [ 1.5 ],
    ])('rejects an out-of-range or non-integer limit (%j)', async (limit) => {
        const { db } = openDb(':memory:');
        await expect(search(db, { query: 'x', mode: 'fulltext', limit })).rejects.toThrow(/limit/);
        db.close();
    });

    it('accepts the boundary values 1 and 100', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md' });
        insertFtsRow(db, noteId, 'A', 'term');

        await expect(search(db, { query: 'term', mode: 'fulltext', limit: 1 })).resolves.not.toThrow();
        await expect(search(db, { query: 'term', mode: 'fulltext', limit: 100 })).resolves.not.toThrow();
        db.close();
    });
});

describe('search: config-backed limit/overfetch/rrf_k (S009)', () => {
    it('uses limitDefault when limit is omitted', async () => {
        const { db } = openDb(':memory:');
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, { path: `Note${i}.md` });
            insertFtsRow(db, noteId, `Note${i}`, 'shared term');
        }

        const results = await search(db, { query: 'shared', mode: 'fulltext', limitDefault: 3 });

        expect(results).toHaveLength(3);
        db.close();
    });

    it('validates against a caller-supplied limitMax instead of the built-in 100', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, { query: 'x', mode: 'fulltext', limit: 10, limitMax: 5 }),
        ).rejects.toThrow(/limit must be an integer between 1 and 5/);
        db.close();
    });

    it('caps overfetch using a caller-supplied overfetchMultiplier/overfetchCap', async () => {
        const { db } = openDb(':memory:');
        const { pipeline } = await explainSearch(db, {
            query: 'x', mode: 'fulltext', limit: 10, overfetchMultiplier: 2, overfetchCap: 15,
        });

        // 10 * 2 = 20, capped to 15
        expect(pipeline.overfetchLimit).toBe(15);
        db.close();
    });

    it('uses a caller-supplied rrfK in the hybrid score and formula', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'C.md' });
        insertFtsRow(db, noteId, 'C', 'graph');
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const { results } = await explainSearch(db, {
            query: 'graph', mode: 'hybrid', limit: 20, rrfK: 10,
            embed: fakeEmbed(0.5), embeddingModel: 'test-model', embeddingVersion: 'v1',
        });

        expect(results[0].rrf_score).toBeCloseTo(1 / 11 + 1 / 11, 10);
        expect(results[0].rrf_formula).toBe(`1/(10+1) + 1/(10+1) = ${results[0].rrf_score}`);
        db.close();
    });
});

describe('explainSearch: fulltext mode', () => {
    it('exposes the raw bm25 score, rank, and pipeline detail', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md' });
        insertFtsRow(db, noteId, 'A', 'graph graph graph');

        const { results, pipeline } = await explainSearch(db, { query: 'graph', mode: 'fulltext', limit: 20 });

        expect(results[0].note_title).toBe('A');
        expect(typeof results[0].bm25_score).toBe('number');
        expect(results[0].rank).toBe(1);
        expect(pipeline).toEqual({ mode: 'fulltext', limit: 20, overfetchLimit: 100, fulltextExpression: 'graph' });
        db.close();
    });
});

describe('explainSearch: semantic mode', () => {
    it('exposes the raw cosine distance and the winning chunk boundaries', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'B.md' });
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const { results } = await explainSearch(db, {
            query: 'x', mode: 'semantic', limit: 20,
            embed: fakeEmbed(0.5), embeddingModel: 'test-model', embeddingVersion: 'v1',
        });

        expect(typeof results[0].cosine_distance).toBe('number');
        expect(results[0].winning_chunk).toEqual({ char_start: 0, char_end: 100, line_start: 1, line_end: 1 });
        db.close();
    });
});

describe('explainSearch: hybrid mode', () => {
    it('exposes the rrf formula and both source ranks', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'C.md' });
        insertFtsRow(db, noteId, 'C', 'graph');
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const { results } = await explainSearch(db, {
            query: 'graph', mode: 'hybrid', limit: 20,
            embed: fakeEmbed(0.5), embeddingModel: 'test-model', embeddingVersion: 'v1',
        });

        expect(results[0].fulltext_rank).toBe(1);
        expect(results[0].semantic_rank).toBe(1);
        expect(results[0].rrf_score).toBeCloseTo(1 / 61 + 1 / 61, 10);
        expect(results[0].rrf_formula).toBe(`1/(60+1) + 1/(60+1) = ${results[0].rrf_score}`);
        db.close();
    });
});

describe('search: malformed FTS5 query', () => {
    it('throws a descriptive error for invalid FTS5 syntax in fulltext mode', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, { query: '"unterminated phrase', mode: 'fulltext', limit: 20 }),
        ).rejects.toThrow(/malformed/i);
        db.close();
    });

    it('throws the same descriptive error for invalid FTS5 syntax in hybrid mode', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, {
                query: '"unterminated phrase',
                mode: 'hybrid',
                limit: 20,
                embed: fakeEmbed(0.1),
                embeddingModel: 'test-model',
                embeddingVersion: 'v1',
            }),
        ).rejects.toThrow(/malformed/i);
        db.close();
    });

    it('does not raise a fulltext-syntax error in semantic mode (fts5 side unused)', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md' });
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        await expect(
            search(db, {
                query: '"unterminated phrase',
                mode: 'semantic',
                limit: 20,
                embed: fakeEmbed(0.5),
                embeddingModel: 'test-model',
                embeddingVersion: 'v1',
            }),
        ).resolves.not.toThrow();
        db.close();
    });

    it('logs a warn line via the context logger before throwing', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-search-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const { db } = openDb(':memory:');

        await expect(
            runWithLogger(logger, () =>
                search(db, { query: '"unterminated phrase', mode: 'fulltext', limit: 20 })),
        ).rejects.toThrow(/malformed/i);
        db.close();

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('WARN  [mcp-server] malformed FTS5 query');
            expect(line).toContain('query="\\"unterminated phrase"');
        });
        await cleanupTempDir(logDir);
    });
});
