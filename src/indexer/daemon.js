#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import { noteRead } from '../core/notes.js';
import { stripMdExtension, loadIgnoreMatcher } from '../core/note-fs.js';
import { extractTags, syncNoteTags, pruneOrphanedTags } from '../core/tags.js';
import { extractLinkTargets, syncNoteLinks } from '../core/links.js';
import { buildMetadataJson } from '../core/metadata.js';
import { openDb, setMeta, enqueuePath } from '../core/db.js';
import { getLogger, defaultLogDir, runWithLogger, getContextLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { appSupportDir, watcherInstallHint } from '../platform/index.js';
import {
    chunkText as realChunkText, loadTokenizer, tokenizeWithOffsets as realTokenizeWithOffsets,
    embed as realEmbed, embedQuery as realEmbedQuery, configureEmbedder, buildChunkPrompt,
} from './embed.js';

// Re-exported for existing callers (this file's own tests, IPC/queue-drain code below) — the
// implementation lives in core/db.js (S001, alongside the rest of the index_queue table's plain
// data-layer functions) so core/notes.js's note_rename link cascade (S003/S011) can call it too
// without core/ reaching back into indexer/, which would create a circular import (daemon.js
// already imports core/notes.js).
export { enqueuePath };

export function dequeueNextPath(db, now = Date.now()) {
    const row = db.prepare(`
        SELECT path FROM index_queue
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at, enqueued_at
        LIMIT 1
    `).get(now);
    return row ? row.path : null;
}

function hasStaleChunks(db, noteId, embeddingModel, embeddingVersion) {
    const row = db.prepare(`
        SELECT COUNT(*) AS count FROM chunks
        WHERE note_id = ? AND NOT (embedding_model = ? AND embedding_version = ?)
    `).get(noteId, embeddingModel, embeddingVersion);
    return row.count > 0;
}

// EXTRACTION_VERSION is a plain code constant, not config-driven (unlike embeddingModel/
// embeddingVersion) — extraction logic isn't a user-tunable, so bumping it is how a future
// tag/link-extraction-logic fix (S004/S011) forces reprocessing of already-indexed notes via a
// plain `mnotes reindex`, mirroring how embeddingVersion already does this for embeddings (S005).
export const EXTRACTION_VERSION = 2;

function isExtractionStale(existing) {
    return existing.extraction_version !== EXTRACTION_VERSION;
}

function upsertNoteRow(db, path, contentHash, lineCount, mtime, updatedAt, metadataJson) {
    db.prepare(`
        INSERT INTO notes (
            path, content_hash, line_count, mtime, updated_at, extraction_version, metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            line_count = excluded.line_count,
            mtime = excluded.mtime,
            updated_at = excluded.updated_at,
            extraction_version = excluded.extraction_version,
            metadata_json = excluded.metadata_json
    `).run(path, contentHash, lineCount, mtime, updatedAt, EXTRACTION_VERSION, metadataJson);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion) {
    db.prepare(`
        DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)
    `).run(noteId);
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);

    const insertChunk = db.prepare(`
        INSERT INTO chunks (
            note_id, chunk_index, char_start, char_end, line_start, line_end, token_count,
            embedding_model, embedding_version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVector = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)');

    for (const chunk of embeddedChunks) {
        const { lastInsertRowid: chunkId } = insertChunk.run(
            noteId, chunk.chunkIndex, chunk.charStart, chunk.charEnd,
            chunk.lineStart, chunk.lineEnd, chunk.tokenCount,
            embeddingModel, embeddingVersion,
        );
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
    const noteTitle = stripMdExtension(path);

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
    db.prepare(`
        DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)
    `).run(note.id);
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(note.id);
    // cascades chunks, note_tags, note_links (S001 FKs)
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    // The cascade above never goes through syncNoteTags, so a tag this note was the last carrier
    // of would otherwise linger as a permanent orphan row (#1).
    pruneOrphanedTags(db);
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

async function embedChunks(title, content, chunkText, embed) {
    const embeddedChunks = [];
    for (const descriptor of chunkText(content)) {
        const chunkBody = content.slice(descriptor.charStart, descriptor.charEnd);
        const vector = await embed(buildChunkPrompt(title, chunkBody));
        embeddedChunks.push({ ...descriptor, vector });
    }
    return embeddedChunks;
}

// Guards the consumer side too, not just the walk/watch producers above: a dot path can still
// reach processPath via a leftover index_queue row enqueued before this filtering existed (or an
// explicit `mnotes reindex <title>` naming one), and this is what actually purges any note row
// already indexed for it.
function purgeDotPath(db, path) {
    if (!isDotPath(path)) {
        return false;
    }
    deleteNoteByPath(db, path);
    return true;
}

// Same shape as purgeDotPath, for a path matched by .mnotesignore instead of a dot-segment.
// Reached the same three ways: a leftover queue row, an explicit `mnotes reindex <title>` naming
// a now-ignored note, or (this feature's own addition) a live fswatch event for one.
function purgeIgnoredPath(db, ignoreMatcher, path) {
    if (!ignoreMatcher.ignores(path)) {
        return false;
    }
    deleteNoteByPath(db, path);
    return true;
}

export async function processPath(vaultRoot, db, path, deps) {
    if (purgeDotPath(db, path) || purgeIgnoredPath(db, deps.ignoreMatcher ?? ignore(), path)) {
        return { status: 'deleted' };
    }

    const { chunkText, embed, embeddingModel, embeddingVersion, now = Date.now() } = deps;
    const absPath = join(vaultRoot, path);
    const title = stripMdExtension(path);

    const stats = statOrNull(absPath);
    if (stats === null) {
        deleteNoteByPath(db, path);
        return { status: 'deleted' };
    }

    const currentMtime = Math.floor(stats.mtimeMs / 1000);
    const existing = db.prepare(
        'SELECT id, mtime, content_hash, extraction_version FROM notes WHERE path = ?',
    ).get(path);
    if (existing && existing.mtime === currentMtime
        && !hasStaleChunks(db, existing.id, embeddingModel, embeddingVersion)
        && !isExtractionStale(existing)) {
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    const read = readNoteOrNull(vaultRoot, title);
    if (read === null) {
        deleteNoteByPath(db, path);
        return { status: 'deleted' };
    }

    if (existing && existing.content_hash === read.content_hash
        && !hasStaleChunks(db, existing.id, embeddingModel, embeddingVersion)
        && !isExtractionStale(existing)) {
        db.prepare('UPDATE notes SET mtime = ?, updated_at = ? WHERE id = ?')
            .run(currentMtime, Math.floor(now / 1000), existing.id);
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    const embeddedChunks = await embedChunks(title, read.content, chunkText, embed);

    const noteId = upsertNoteRow(
        db, path, read.content_hash, read.total_lines, currentMtime, Math.floor(now / 1000),
        buildMetadataJson(read.metadata),
    );
    replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion);
    replaceFtsRow(db, noteId, title, read.content);
    syncNoteTags(db, noteId, extractTags(read.content, read.metadata));
    syncNoteLinks(db, noteId, extractLinkTargets(read.content));

    getContextLogger().info('reindexed note', { note_title: title, chunk_count: embeddedChunks.length });
    return { status: 'reindexed' };
}

function toVaultRelativePath(vaultRoot, absPath) {
    return relative(vaultRoot, absPath).split(sep).join('/');
}

// Dotfiles/dot-directories (.obsidian/, .trash/, .git/, .DS_Store, ...) are never notes — skip them
// everywhere the vault tree is walked or watched, rather than letting them churn the index queue.
function isDotEntryName(name) {
    return name.startsWith('.');
}

export function isDotPath(relativePath) {
    return relativePath.split(sep).some(isDotEntryName);
}

// A gitignore-style .mnotesignore at the vault root (loaded via S010's loadIgnoreMatcher) — the
// Obsidian template-folder case that motivated this (a template's frontmatter placeholders like
// `id: {{title}}` parse as nested YAML objects, not the literal string they're meant to be, which
// otherwise pollutes the index). Directories are checked with a trailing slash so a dir-only
// pattern like "Templates/" prunes the walk before descending, same convention `ignore` itself
// recommends for directory paths.
function walkVaultForMarkdown(vaultRoot, ignoreMatcher = ignore()) {
    const results = [];

    function visitEntry(dir, entry) {
        if (isDotEntryName(entry.name)) {
            return;
        }
        const full = join(dir, entry.name);
        const relativePath = toVaultRelativePath(vaultRoot, full);
        if (entry.isDirectory()) {
            if (!ignoreMatcher.ignores(`${relativePath}/`)) {
                walk(full);
            }
            return;
        }
        if (entry.isFile() && entry.name.endsWith('.md') && !ignoreMatcher.ignores(relativePath)) {
            results.push(full);
        }
    }

    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            visitEntry(dir, entry);
        }
    }

    walk(vaultRoot);
    return results;
}

export function watermarkCatchup(db, vaultRoot, now = Date.now(), ignoreMatcher = ignore()) {
    const row = db.prepare('SELECT MAX(updated_at) AS watermark FROM notes').get();
    const watermark = row.watermark ?? 0;

    let enqueuedCount = 0;
    for (const absPath of walkVaultForMarkdown(vaultRoot, ignoreMatcher)) {
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

// Retroactive cleanup for a .mnotesignore that starts matching a path already sitting in the
// index (added after the note was indexed, or a broader pattern than before) — mirrors
// existenceCheck's sweep-and-purge shape. Run at daemon startup and at the start of a full-vault
// runReindex, so both "restart the daemon" and "run `mnotes reindex`" self-heal without the
// caller needing to reason about what was indexed before the pattern existed (CLAUDE.md's
// idempotent-reindex rule).
export function ignoredPathsCheck(db, ignoreMatcher) {
    let deletedCount = 0;
    for (const row of db.prepare('SELECT path FROM notes').all()) {
        if (ignoreMatcher.ignores(row.path)) {
            deleteNoteByPath(db, row.path);
            deletedCount += 1;
        }
    }
    getContextLogger().info('ignored-paths check complete', { deleted_count: deletedCount });
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
            throw new Error(`fswatch not found — install via \`${watcherInstallHint()}\``, { cause: error });
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

    const ignoreMatcher = deps.ignoreMatcher ?? ignore();
    if (noteTitle === null) {
        ignoredPathsCheck(db, ignoreMatcher);
    }

    const paths = noteTitle !== null
        ? [ `${noteTitle}.md` ]
        : walkVaultForMarkdown(vaultRoot, ignoreMatcher).map((absPath) => toVaultRelativePath(vaultRoot, absPath));

    for (const path of paths) {
        enqueuePath(db, path, now);
    }

    const counts = { reindexed: 0, skipped: 0, failed: 0 };
    for (const path of paths) {
        const outcome = await attemptPathUntilSettled(vaultRoot, db, path, deps, now, onMessage);
        counts[outcome] += 1;
    }

    getContextLogger().info('reindex complete', counts);

    if (noteTitle === null) {
        setMeta(db, 'last_full_reindex_at', String(now));
    }

    onMessage({ summary: counts });
}

export function defaultAppSupportDir() {
    return appSupportDir();
}

export function defaultSocketPath() {
    return join(defaultAppSupportDir(), 'daemon.sock');
}

function handleIpcRequest(line, socket, ctx) {
    const { vaultRoot, db, deps, gate } = ctx;
    const request = JSON.parse(line);

    if (request.action === 'embed') {
        // Not run under `gate` — embedding a query touches no shared queue/DB state, so there's no
        // correctness reason to make an interactive search wait behind an in-flight reindex/drain
        // pass (unlike `reindex` below, which mutates the same rows processPath does).
        deps.embedQuery(request.text)
            .then((vector) => socket.end(`${JSON.stringify({ vector: Array.from(vector) })}\n`))
            .catch((err) => socket.end(`${JSON.stringify({ error: err.message })}\n`));
        return;
    }

    if (request.action !== 'reindex') {
        socket.end(`${JSON.stringify({ error: `unknown action "${request.action}"` })}\n`);
        return;
    }
    // Runs under the same gate as the periodic drain loop (see createSerialGate) — an IPC-triggered
    // reindex and a background drain tick must never call processPath on the same path at once.
    gate.schedule(() => runReindex(
        vaultRoot, db, deps, { noteTitle: request.noteTitle ?? null },
        (msg) => socket.write(`${JSON.stringify(msg)}\n`),
    )).then(() => socket.end());
}

function handleIpcConnection(socket, ctx) {
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
            handleIpcRequest(line, socket, ctx);
        }
    });
}

export function createIpcServer(socketPath, vaultRoot, db, deps, gate = createSerialGate()) {
    if (existsSync(socketPath)) {
        rmSync(socketPath);
    }

    const ctx = { vaultRoot, db, deps, gate };
    const server = createServer((socket) => handleIpcConnection(socket, ctx));
    server.listen(socketPath);
    return server;
}

export const DEFAULT_EMBEDDING_MODEL = 'Qwen3-Embedding-0.6B';
export const DEFAULT_EMBEDDING_VERSION = 'q8-v3';
const DEFAULT_DRAIN_INTERVAL_MS = 2000;

async function resolveChunkText(providedChunkText) {
    if (providedChunkText) {
        return providedChunkText;
    }
    const tokenizer = await loadTokenizer();
    return (body) => realChunkText(body, (text) => realTokenizeWithOffsets(tokenizer, text));
}

function defaultCreateWatcher(vaultRoot, db, { debounceMs, ignoreMatcher = ignore() } = {}) {
    let stopped = false;

    const debouncer = createDebouncer((path) => {
        // fswatch's stdout can still have buffered lines in flight when child.kill() runs below,
        // so a debounce timer can settle after stop() — this guard keeps that a no-op instead of
        // touching a since-closed db.
        if (stopped) {
            return;
        }
        const absPath = join(vaultRoot, path);
        if (existsSync(absPath)) {
            enqueuePath(db, path);
        } else {
            deleteNoteByPath(db, path);
        }
    }, { debounceMs });

    const child = spawnFswatch(vaultRoot, (absPath) => {
        if (stopped) {
            return;
        }
        const relativePath = toVaultRelativePath(vaultRoot, absPath);
        if (!isDotPath(relativePath) && !ignoreMatcher.ignores(relativePath)) {
            debouncer.notify(relativePath);
        }
    });

    return {
        stop() {
            stopped = true;
            debouncer.cancelAll();
            child.kill();
        },
    };
}

// Serializes drainQueueOnce (the periodic background pass) against runReindex (an IPC-triggered
// `mnotes reindex`) so the two never call processPath on the same path concurrently. Without this,
// a manual reindex issued while a background pass is mid-flight could have both re-dequeue/re-embed
// the same still-queued note at once — wasted embedding work, and two interleaved
// delete-then-insert passes racing to write the same chunks/chunk_vectors rows. A queued path isn't
// removed from index_queue until its embed finishes, so nothing here can be safely run concurrently
// with itself either — the same gate covers both cases.
export function createSerialGate() {
    let queueTail = Promise.resolve();
    let pending = 0;

    function schedule(fn) {
        // `pending` increments synchronously (not inside the .then() below) so isBusy() is accurate
        // immediately after schedule() returns, with no microtask-timing gap for an eager caller.
        pending += 1;
        const result = queueTail.then(fn, fn);
        queueTail = result.catch(() => {});
        result.finally(() => { pending -= 1; });
        return result;
    }

    return { schedule, isBusy: () => pending > 0 };
}

function startDrainLoop(vaultRoot, db, deps, drainIntervalMs, gate) {
    if (drainIntervalMs === null) {
        return null;
    }
    // A single drainQueueOnce pass can outlast drainIntervalMs by a lot (e.g. draining a large
    // initial backlog while each note takes hundreds of ms to embed). Without this guard,
    // setInterval fires a new overlapping pass anyway — skipping a tick while the gate is busy is
    // safe since the next tick picks up anything left in the queue.
    return setInterval(() => {
        if (gate.isBusy()) {
            return;
        }
        gate.schedule(() => drainQueueOnce(vaultRoot, db, deps))
            .catch((err) => getContextLogger().error('queue drain failed', { error_message: err.message }));
    }, drainIntervalMs);
}

export async function startDaemon(options = {}) {
    const {
        vaultRoot,
        dbPath,
        socketPath = defaultSocketPath(),
        embeddingModel = DEFAULT_EMBEDDING_MODEL,
        embeddingVersion = DEFAULT_EMBEDDING_VERSION,
        embed = realEmbed,
        embedQuery = realEmbedQuery,
        createWatcher = defaultCreateWatcher,
        drainIntervalMs = DEFAULT_DRAIN_INTERVAL_MS,
        debounceMs = DEFAULT_DEBOUNCE_MS,
        backoffSchedule = DEFAULT_BACKOFF_SCHEDULE_MS,
    } = options;

    getContextLogger().info('daemon started');

    // openDb's own schema-check/rebuild logging ("schema created" / "schema version mismatch,
    // rebuilding", S001) fires from inside this call and lands in the same runWithLogger context
    // main() established — no second log line added here (S005 "Logging").
    const { db, reindexRequired } = openDb(dbPath);

    const chunkText = await resolveChunkText(options.chunkText);
    const ignoreMatcher = loadIgnoreMatcher(vaultRoot);
    const deps = { chunkText, embed, embedQuery, embeddingModel, embeddingVersion, backoffSchedule, ignoreMatcher };

    watermarkCatchup(db, vaultRoot, undefined, ignoreMatcher);
    if (!reindexRequired) {
        // A schema rebuild (reindexRequired) resets the watermark to 0, so watermarkCatchup alone
        // already re-enqueues the entire vault — existenceCheck/ignoredPathsCheck would find
        // nothing to delete against a freshly-rebuilt, currently-empty notes table, so both are
        // skipped in that case.
        existenceCheck(db, vaultRoot);
        ignoredPathsCheck(db, ignoreMatcher);
    }

    const gate = createSerialGate();
    const watcher = createWatcher(vaultRoot, db, { debounceMs, ignoreMatcher });
    const drainTimer = startDrainLoop(vaultRoot, db, deps, drainIntervalMs, gate);
    if (drainTimer === null) {
        await drainQueueOnce(vaultRoot, db, deps);
    }

    const ipcServer = createIpcServer(socketPath, vaultRoot, db, deps, gate);

    async function stop() {
        if (drainTimer !== null) {
            clearInterval(drainTimer);
        }
        watcher.stop();
        await new Promise((resolve) => ipcServer.close(resolve));
        db.close();
    }

    return { db, stop };
}

// The actual process entry point — everything above is built as an importable, independently
// testable function, but a real `launchd`-managed daemon process needs something that runs on
// `node src/indexer/daemon.js` with no caller supplying options.
export async function main() {
    const config = loadConfig();
    configureEmbedder({
        dtype: config.index.embedding_dtype,
        idleTimeoutMs: config.index.model_idle_unload_minutes * 60 * 1000,
    });
    return startDaemon({
        vaultRoot: config.vault_path,
        dbPath: config.db_path,
        debounceMs: config.index.debounce_ms,
        backoffSchedule: config.index.retry_backoff_seconds.map((seconds) => seconds * 1000),
    });
}

// S005 "Logging": daemon.js is a runWithLogger root — this is the one place in the whole process
// that establishes the AsyncLocalStorage context, before anything else runs. Every
// getContextLogger() call anywhere in daemon.js/embed.js, for the lifetime of the process,
// resolves against this same context. Guarded so `import`ing daemon.js (this test file, and
// S006's CLI) never triggers a real daemon startup as a side effect of the import.
//
// realpathSync(argv[1]), not a raw string compare — see the identical comment in cli/main.js.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.title = 'mnotes-indexer';
    runWithLogger(getLogger('indexer', defaultLogDir()), () => main());
}
