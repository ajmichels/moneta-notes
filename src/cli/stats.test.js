import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openDb, setMeta } from '../core/db.js';
import { computeStats, checkDaemonRunning } from './stats.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempDbPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-stats-test-'));
    tempDirs.push(dir);
    return join(dir, 'index.db');
}

afterEach(() => {
    while (tempDirs.length > 0) {
        cleanupTempDir(tempDirs.pop());
    }
});

describe('computeStats', () => {
    it('reports note/tag counts, line stats, embedding config, and queue depth', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'hash', 10, 1000, 1000);
        db.prepare('INSERT INTO tags (name) VALUES (?)').run('project');
        db.prepare('INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)').run('B.md', 1, 1);
        setMeta(db, 'last_full_reindex_at', '5000');

        const stats = computeStats(db, dbPath, 'test-model', 'v1');

        expect(stats.note_count).toBe(1);
        expect(stats.tag_count).toBe(1);
        expect(stats.total_line_count).toBe(10);
        expect(stats.average_line_count).toBe(10);
        expect(stats.embedding_model).toBe('test-model');
        expect(stats.embedding_version).toBe('v1');
        expect(stats.last_reindex_at).toBe('5000');
        expect(stats.queue_depth).toBe(1);
        expect(stats.index_size_bytes).toBeGreaterThan(0);
        db.close();
    });

    it('counts notes with a stale embedding_model/version as pending re-embedding', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'hash', 1, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('A.md').id;
        db.prepare(`
            INSERT INTO chunks (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 1, 1, 'old-model', 'v0')
        `).run(noteId);

        const stats = computeStats(db, dbPath, 'test-model', 'v1');

        expect(stats.pending_reembedding_count).toBe(1);
        db.close();
    });

    it('reports last_reindex_at as null before any full reindex has run', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);

        expect(computeStats(db, dbPath, 'm', 'v1').last_reindex_at).toBeNull();
        db.close();
    });
});

describe('checkDaemonRunning', () => {
    it('resolves true when something is listening on the socket', async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), 'mnotes-cli-stats-test-')), 'daemon.sock');
        const server = createServer(() => {});
        await new Promise((resolve) => server.listen(socketPath, resolve));

        expect(await checkDaemonRunning(socketPath)).toBe(true);
        server.close();
    });

    it('resolves false without throwing when nothing is listening', async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), 'mnotes-cli-stats-test-')), 'nobody.sock');

        expect(await checkDaemonRunning(socketPath)).toBe(false);
    });
});
