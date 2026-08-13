import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { noteRead } from '../core/notes.js';
import { extractTags, syncNoteTags } from '../core/tags.js';
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

function upsertNoteRow(db, path, contentHash, lineCount, mtime, updatedAt) {
    db.prepare(`
        INSERT INTO notes (path, content_hash, line_count, mtime, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            line_count = excluded.line_count,
            mtime = excluded.mtime,
            updated_at = excluded.updated_at
    `).run(path, contentHash, lineCount, mtime, updatedAt);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion) {
    const staleChunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(noteId).map((r) => r.id);
    for (const chunkId of staleChunkIds) {
        db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?').run(chunkId);
    }
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);

    const insertChunk = db.prepare(`
        INSERT INTO chunks (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVector = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)');

    for (const chunk of embeddedChunks) {
        insertChunk.run(
            noteId, chunk.chunkIndex, chunk.charStart, chunk.charEnd, chunk.tokenCount,
            embeddingModel, embeddingVersion,
        );
        const chunkId = db.prepare(
            'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
        ).get(noteId, chunk.chunkIndex).id;
        insertVector.run(chunkId, Buffer.from(chunk.vector.buffer));
    }
}

function replaceFtsRow(db, noteId, title, body) {
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(noteId);
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

export const DEFAULT_BACKOFF_SCHEDULE_MS = [ 30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000 ];

// index_queue.next_attempt_at/enqueued_at are epoch milliseconds throughout (matching
// enqueuePath/dequeueNextPath above) — unlike notes.mtime/updated_at, which are epoch seconds.
export function recordFailure(db, path, now = Date.now(), backoffSchedule = DEFAULT_BACKOFF_SCHEDULE_MS) {
    const row = db.prepare('SELECT attempts FROM index_queue WHERE path = ?').get(path);
    if (!row) {
        return { permanentlyFailed: false, attempts: 0 };
    }

    const attempts = row.attempts + 1;
    const maxAttempts = backoffSchedule.length + 1;

    if (attempts >= maxAttempts) {
        db.prepare('DELETE FROM index_queue WHERE path = ?').run(path);
        return { permanentlyFailed: true, attempts };
    }

    const nextAttemptAt = now + backoffSchedule[attempts - 1];
    db.prepare('UPDATE index_queue SET attempts = ?, next_attempt_at = ? WHERE path = ?')
        .run(attempts, nextAttemptAt, path);
    return { permanentlyFailed: false, attempts };
}

function recordAndLogFailure(db, path, err, now, backoffSchedule) {
    const { permanentlyFailed, attempts } = recordFailure(db, path, now, backoffSchedule);
    const noteTitle = path.replace(/\.md$/, '');

    if (permanentlyFailed) {
        getContextLogger().error('reindex permanently failed', {
            note_title: noteTitle,
            attempts,
            error_message: err.message,
        });
    } else {
        const row = db.prepare('SELECT next_attempt_at FROM index_queue WHERE path = ?').get(path);
        getContextLogger().warn('reindex attempt failed', {
            note_title: noteTitle,
            attempt: attempts,
            next_attempt_at: row.next_attempt_at,
            error_message: err.message,
        });
    }

    return { permanentlyFailed, attempts };
}

async function processQueuedPath(vaultRoot, db, path, deps, now) {
    try {
        const result = await processPath(vaultRoot, db, path, deps);
        db.prepare('DELETE FROM index_queue WHERE path = ?').run(path);
        return result.status === 'reindexed' ? 'reindexed' : 'skipped';
    } catch (err) {
        const { permanentlyFailed } = recordAndLogFailure(db, path, err, now, deps.backoffSchedule);
        return permanentlyFailed ? 'failed' : 'retry';
    }
}

export async function drainQueueOnce(vaultRoot, db, deps) {
    const { now = Date.now() } = deps;
    const counts = { reindexed: 0, skipped: 0, failed: 0 };

    let path = dequeueNextPath(db, now);
    while (path !== null) {
        const outcome = await processQueuedPath(vaultRoot, db, path, deps, now);
        if (outcome !== 'retry') {
            counts[outcome] += 1;
        }
        path = dequeueNextPath(db, now);
    }

    return counts;
}

export function deleteNoteByPath(db, path) {
    const note = db.prepare('SELECT id FROM notes WHERE path = ?').get(path);
    if (!note) {
        return;
    }
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(note.id).map((r) => r.id);
    for (const chunkId of chunkIds) {
        db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?').run(chunkId);
    }
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(note.id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id); // cascades chunks, note_tags (S001 FKs)
}

function statOrNull(absPath) {
    try {
        return statSync(absPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

function readNoteOrNull(vaultRoot, title) {
    try {
        return noteRead(vaultRoot, title);
    } catch (err) {
        if (/not found/i.test(err.message)) {
            return null;
        }
        throw err;
    }
}

async function embedChunks(content, chunkText, embed) {
    const embeddedChunks = [];
    for (const descriptor of chunkText(content)) {
        const chunkBody = content.slice(descriptor.charStart, descriptor.charEnd);
        const vector = await embed(chunkBody);
        embeddedChunks.push({ ...descriptor, vector });
    }
    return embeddedChunks;
}

export async function processPath(vaultRoot, db, path, deps) {
    const { chunkText, embed, embeddingModel, embeddingVersion, now = Date.now() } = deps;
    const absPath = join(vaultRoot, path);
    const title = path.replace(/\.md$/, '');

    const stats = statOrNull(absPath);
    if (stats === null) {
        deleteNoteByPath(db, path);
        return { status: 'deleted' };
    }

    const currentMtime = Math.floor(stats.mtimeMs / 1000);
    const existing = db.prepare('SELECT id, mtime, content_hash FROM notes WHERE path = ?').get(path);
    if (existing && existing.mtime === currentMtime) {
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    const read = readNoteOrNull(vaultRoot, title);
    if (read === null) {
        deleteNoteByPath(db, path);
        return { status: 'deleted' };
    }

    if (existing && existing.content_hash === read.content_hash) {
        db.prepare('UPDATE notes SET mtime = ?, updated_at = ? WHERE id = ?')
            .run(currentMtime, Math.floor(now / 1000), existing.id);
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    const embeddedChunks = await embedChunks(read.content, chunkText, embed);

    const noteId = upsertNoteRow(
        db, path, read.content_hash, read.total_lines, currentMtime, Math.floor(now / 1000),
    );
    replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion);
    replaceFtsRow(db, noteId, title, read.content);
    syncNoteTags(db, noteId, extractTags(read.content, read.metadata));

    getContextLogger().info('reindexed note', { note_title: title, chunk_count: embeddedChunks.length });
    return { status: 'reindexed' };
}

function toVaultRelativePath(vaultRoot, absPath) {
    return relative(vaultRoot, absPath).split(sep).join('/');
}

function walkVaultForMarkdown(vaultRoot) {
    const results = [];
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(full);
            }
        }
    }
    walk(vaultRoot);
    return results;
}

export function watermarkCatchup(db, vaultRoot, now = Date.now()) {
    const row = db.prepare('SELECT MAX(updated_at) AS watermark FROM notes').get();
    const watermark = row.watermark ?? 0;

    let enqueuedCount = 0;
    for (const absPath of walkVaultForMarkdown(vaultRoot)) {
        const mtimeSec = Math.floor(statSync(absPath).mtimeMs / 1000);
        if (mtimeSec > watermark) {
            enqueuePath(db, toVaultRelativePath(vaultRoot, absPath), now);
            enqueuedCount += 1;
        }
    }
    getContextLogger().info('watermark catch-up complete', { watermark, enqueued_count: enqueuedCount });
    return enqueuedCount;
}

export function existenceCheck(db, vaultRoot) {
    let deletedCount = 0;
    for (const row of db.prepare('SELECT path FROM notes').all()) {
        if (!existsSync(join(vaultRoot, row.path))) {
            deleteNoteByPath(db, row.path);
            deletedCount += 1;
        }
    }
    getContextLogger().info('existence check complete', { deleted_count: deletedCount });
    return deletedCount;
}

const DEFAULT_DEBOUNCE_MS = 15000;

export function createDebouncer(onSettle, options = {}) {
    const { debounceMs = DEFAULT_DEBOUNCE_MS, scheduleFn = setTimeout, cancelFn = clearTimeout } = options;
    const timers = new Map();

    function notify(path) {
        if (timers.has(path)) {
            cancelFn(timers.get(path));
        }
        const timer = scheduleFn(() => {
            timers.delete(path);
            onSettle(path);
        }, debounceMs);
        timers.set(path, timer);
    }

    function cancelAll() {
        for (const timer of timers.values()) {
            cancelFn(timer);
        }
        timers.clear();
    }

    return { notify, cancelAll };
}

export function assertFswatchAvailable(env = process.env) {
    try {
        execFileSync('fswatch', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('fswatch not found — install via `brew install fswatch`', { cause: error });
        }
        throw error;
    }
}

export function spawnFswatch(vaultRoot, onPath) {
    assertFswatchAvailable();
    const child = spawn('fswatch', [ '-r', vaultRoot ]);
    getContextLogger().info('fswatch watcher started');
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
        const path = line.trim();
        if (path.length > 0) {
            onPath(path);
        }
    });
    return child;
}

async function attemptPathUntilSettled(vaultRoot, db, path, deps, now, onMessage) {
    try {
        const result = await processPath(vaultRoot, db, path, deps);
        db.prepare('DELETE FROM index_queue WHERE path = ?').run(path);
        const outcome = result.status === 'reindexed' ? 'reindexed' : 'skipped';
        onMessage({ path, outcome });
        return outcome;
    } catch (err) {
        const { permanentlyFailed, attempts } = recordAndLogFailure(db, path, err, now, deps.backoffSchedule);
        onMessage({ path, outcome: 'attempt_failed', attempts, error: err.message });
        if (permanentlyFailed) {
            onMessage({ path, outcome: 'failed' });
            return 'failed';
        }
        // An IPC-triggered reindex retries immediately rather than waiting out the real backoff
        // delay, since a caller is actively blocked on this connection watching it happen.
        return attemptPathUntilSettled(vaultRoot, db, path, deps, now, onMessage);
    }
}

export async function runReindex(vaultRoot, db, deps, options = {}, onMessage = () => {}) {
    const { noteTitle = null } = options;
    const now = deps.now ?? Date.now();

    getContextLogger().info('reindex requested', {
        scope: noteTitle !== null ? 'note' : 'vault',
        note_title: noteTitle,
    });

    const paths = noteTitle !== null
        ? [ `${noteTitle}.md` ]
        : walkVaultForMarkdown(vaultRoot).map((absPath) => toVaultRelativePath(vaultRoot, absPath));

    for (const path of paths) {
        enqueuePath(db, path, now);
    }

    const counts = { reindexed: 0, skipped: 0, failed: 0 };
    for (const path of paths) {
        const outcome = await attemptPathUntilSettled(vaultRoot, db, path, deps, now, onMessage);
        counts[outcome] += 1;
    }

    getContextLogger().info('reindex complete', counts);
    onMessage({ summary: counts });
}
