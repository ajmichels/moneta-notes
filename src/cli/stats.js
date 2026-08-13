import { statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { getMeta } from '../core/db.js';

export function computeStats(db, dbPath, embeddingModel, embeddingVersion) {
    const noteCount = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
    const tagCount = db.prepare('SELECT COUNT(*) AS count FROM tags').get().count;
    const lineStats = db.prepare(
        'SELECT COALESCE(SUM(line_count), 0) AS total, COALESCE(AVG(line_count), 0.0) AS average FROM notes',
    ).get();
    const pendingReembedding = db.prepare(`
        SELECT COUNT(DISTINCT note_id) AS count
        FROM chunks
        WHERE embedding_model != ? OR embedding_version != ?
    `).get(embeddingModel, embeddingVersion).count;
    const queueDepth = db.prepare('SELECT COUNT(*) AS count FROM index_queue').get().count;

    return {
        note_count: noteCount,
        tag_count: tagCount,
        total_line_count: lineStats.total,
        average_line_count: lineStats.average,
        embedding_model: embeddingModel,
        embedding_version: embeddingVersion,
        pending_reembedding_count: pendingReembedding,
        index_size_bytes: statSync(dbPath).size,
        last_reindex_at: getMeta(db, 'last_full_reindex_at'),
        queue_depth: queueDepth,
    };
}

export function checkDaemonRunning(socketPath, timeoutMs = 300) {
    return new Promise((resolve) => {
        let settled = false;
        const client = createConnection(socketPath);

        function finish(running) {
            if (settled) {
                return;
            }
            settled = true;
            client.destroy();
            resolve(running);
        }

        const timer = setTimeout(() => finish(false), timeoutMs);
        client.on('connect', () => {
            clearTimeout(timer);
            finish(true);
        });
        client.on('error', () => {
            clearTimeout(timer);
            finish(false);
        });
    });
}
