import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { createIpcServer } from '../indexer/daemon.js';
import { streamReindex, runReindexCommand } from './reindex.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-reindex-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

function baseDeps() {
    return {
        chunkText: (body) => (body.length === 0 ? [] : [ {
            chunkIndex: 0, charStart: 0, charEnd: body.length,
            lineStart: 1, lineEnd: body.split('\n').length, tokenCount: 1,
        } ]),
        embed: async () => new Float32Array(1024).fill(0.1),
        embeddingModel: 'test-model',
        embeddingVersion: 'v1',
        now: 0,
    };
}

describe('streamReindex / runReindexCommand', () => {
    it('streams per-path outcomes and a final summary from a real daemon socket', async () => {
        const vaultRoot = makeTempDir();
        writeFileSync(join(vaultRoot, 'A.md'), 'note body');
        const { db } = openDb(':memory:');
        const socketPath = join(makeTempDir(), 'daemon.sock');
        const server = createIpcServer(socketPath, vaultRoot, db, baseDeps());

        const result = await runReindexCommand([], { socketPath });

        server.close();
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('A.md | reindexed');
        expect(result.stdout).toContain('reindexed: 1, skipped: 0, failed: 0');
    });

    it('scopes to a single title when one is given', async () => {
        const vaultRoot = makeTempDir();
        writeFileSync(join(vaultRoot, 'Only.md'), 'note');
        writeFileSync(join(vaultRoot, 'Ignored.md'), 'note');
        const { db } = openDb(':memory:');
        const socketPath = join(makeTempDir(), 'daemon.sock');
        const server = createIpcServer(socketPath, vaultRoot, db, baseDeps());

        const result = await runReindexCommand([ 'Only' ], { socketPath });

        server.close();
        expect(result.stdout).toContain('Only.md | reindexed');
        expect(result.stdout).not.toContain('Ignored.md');
    });

    it('hard-errors with an actionable message when the daemon is not running', async () => {
        const socketPath = join(makeTempDir(), 'nobody-listening.sock');

        await expect(streamReindex(socketPath, null, () => {})).rejects.toThrow(/is it running/);
    });
});
