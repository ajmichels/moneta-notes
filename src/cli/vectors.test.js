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

describe('mnotes vectors: unknown subcommand', () => {
    it('returns a non-zero exit code with an error on stderr', async () => {
        const db = makeTempDb();
        const result = await runVectorsCommand([ 'nope' ], makeDeps(db));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown vectors subcommand/);
        db.close();
    });
});
