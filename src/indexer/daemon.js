import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getContextLogger } from '../logger.js';

export function enqueuePath(db, path, now = Date.now()) {
    db.prepare(`
        INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO NOTHING
    `).run(path, now, now);
}

export function dequeueNextPath(db, now = Date.now()) {
    const row = db.prepare(`
        SELECT path FROM index_queue
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at, enqueued_at
        LIMIT 1
    `).get(now);
    return row ? row.path : null;
}

export async function processPath(vaultRoot, db, path) {
    const absPath = join(vaultRoot, path);
    const title = path.replace(/\.md$/, '');
    const stats = statSync(absPath);
    const currentMtime = Math.floor(stats.mtimeMs / 1000);

    const existing = db.prepare('SELECT id, mtime, content_hash FROM notes WHERE path = ?').get(path);
    if (existing && existing.mtime === currentMtime) {
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    throw new Error('processPath: content-changed branch not yet implemented');
}
