import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import { enqueuePath } from '../core/db.js';
import { pruneOrphanedTags } from '../core/tags.js';
import { getContextLogger } from '../logger.js';
import { createResilientWatcher, DEFAULT_BACKOFF_SCHEDULE_MS } from './fswatch-watcher.js';
import {
    walkVaultForMarkdown, statOrNull, realpathOrNull, lstatOrNull, toVaultRelativePath, isDotPath,
    rewriteEventPath,
} from './vault-walk.js';

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

// A removed or renamed symlinked directory takes its whole indexed subtree with it, unlike a
// single note's deletion — fetches every note under aliasPrefix and reuses deleteNoteByPath's
// cascade per row rather than duplicating its DELETE statements.
export function deleteNotesByPathPrefix(db, aliasPrefix) {
    const nestedPrefix = `${aliasPrefix}/`;
    const rows = db.prepare('SELECT path FROM notes').all()
        .filter((row) => row.path === aliasPrefix || row.path.startsWith(nestedPrefix));
    for (const row of rows) {
        deleteNoteByPath(db, row.path);
    }
    return rows.length;
}

export const DEFAULT_DEBOUNCE_MS = 15000;

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

// ctx.registry maps aliasPath (vault-relative, no trailing slash) -> realpath for everything
// currently registered as a symlinked directory (S005); ctx is a plain mutable bag shared by every
// function below, built once per createFsWatcher call.
function registerSymlinkDir(ctx, aliasPath, realpath) {
    ctx.registry.set(aliasPath, realpath);
    getContextLogger().info('symlinked directory registered', { alias_path: aliasPath, realpath });
    ctx.symlinkWatchers.set(aliasPath, createResilientWatcher(
        join(ctx.vaultRoot, aliasPath),
        (rawAbsPath) => acceptRawPath(ctx, rawAbsPath, (p) => rewriteEventPath(p, ctx.registry)),
        { backoffSchedule: ctx.backoffSchedule, isStillValid: () => statOrNull(realpath)?.isDirectory() ?? false },
    ));
}

// A removed/renamed symlink takes its subtree with it — nested registrations get torn down too.
function teardownAlias(ctx, aliasPath) {
    for (const knownAlias of [ ...ctx.registry.keys() ]) {
        if (knownAlias === aliasPath || knownAlias.startsWith(`${aliasPath}/`)) {
            ctx.symlinkWatchers.get(knownAlias)?.stop();
            ctx.symlinkWatchers.delete(knownAlias);
            ctx.registry.delete(knownAlias);
        }
    }
    const deletedCount = deleteNotesByPathPrefix(ctx.db, aliasPath);
    getContextLogger().info('symlinked directory removed', { alias_path: aliasPath, notes_deleted_count: deletedCount });
}

function acceptRawPath(ctx, rawAbsPath, toRelative) {
    if (ctx.stopped) {
        return;
    }
    const relativePath = toRelative(rawAbsPath);
    if (relativePath === null) {
        getContextLogger().error('fswatch event path did not resolve to a known path', { path: rawAbsPath });
        return;
    }
    if (!isDotPath(relativePath) && !ctx.ignoreMatcher.ignores(relativePath)) {
        ctx.debouncer.notify(relativePath);
    }
}

// Register+index a settled symlink resolving to a not-yet-registered directory, tear down a stale
// registration if the target changed, or clean up a stray note row for a file/dangling target.
function handleSettledSymlink(ctx, relativePath, absPath) {
    const target = realpathOrNull(absPath);
    const targetStats = target === null ? null : statOrNull(target);
    const isDirTarget = targetStats !== null && targetStats.isDirectory();
    const registeredRealpath = ctx.registry.get(relativePath);

    if (registeredRealpath !== undefined && registeredRealpath !== target) {
        teardownAlias(ctx, relativePath);
    }
    if (isDirTarget && !ctx.registry.has(relativePath)) {
        registerSymlinkDir(ctx, relativePath, target);
        // A scoped watermark-catch-up rooted at this alias, recursing into any nested symlinks.
        const onNested = (aliasPath, realpath) => registerSymlinkDir(ctx, aliasPath, realpath);
        for (const mdPath of walkVaultForMarkdown(ctx.vaultRoot, ctx.ignoreMatcher, onNested, absPath)) {
            enqueuePath(ctx.db, toVaultRelativePath(ctx.vaultRoot, mdPath));
        }
    } else if (!isDirTarget) {
        deleteNoteByPath(ctx.db, relativePath);
    }
}

// "Recheck reality after debounce" (S005) extended to symlink create/remove, not just file changes.
function handleSettledPath(ctx, relativePath) {
    const absPath = join(ctx.vaultRoot, relativePath);
    const lstat = lstatOrNull(absPath);

    if (lstat === null) {
        if (ctx.registry.has(relativePath)) {
            teardownAlias(ctx, relativePath);
        } else {
            deleteNoteByPath(ctx.db, relativePath);
        }
        return;
    }

    if (lstat.isSymbolicLink()) {
        handleSettledSymlink(ctx, relativePath, absPath);
        return;
    }

    if (ctx.registry.has(relativePath)) {
        teardownAlias(ctx, relativePath); // a real file/dir replaced what used to be a symlinked alias
    }
    if (lstat.isFile()) {
        enqueuePath(ctx.db, relativePath);
    } else {
        // A directory (or other non-regular entry) now sits here — may have previously been an
        // indexed note (e.g. `rm Note.md && mkdir Note.md`); deleteNoteByPath is a no-op if not.
        deleteNoteByPath(ctx.db, relativePath);
    }
}

export function createFsWatcher(vaultRoot, db, {
    debounceMs, ignoreMatcher = ignore(), backoffSchedule = DEFAULT_BACKOFF_SCHEDULE_MS,
} = {}) {
    const ctx = {
        vaultRoot, db, ignoreMatcher, backoffSchedule, stopped: false, debouncer: null,
        registry: new Map(), symlinkWatchers: new Map(),
    };

    ctx.debouncer = createDebouncer((relativePath) => {
        // fswatch's stdout can still have buffered lines in flight when child.kill() runs below,
        // so a debounce timer can settle after stop() — this guard keeps that a no-op instead of
        // touching a since-closed db.
        if (!ctx.stopped) {
            handleSettledPath(ctx, relativePath);
        }
    }, { debounceMs });

    // Register every pre-existing symlinked directory before the main watcher starts; markdown
    // paths this walk also finds are ignored — watermarkCatchup already enqueued them at startup.
    walkVaultForMarkdown(vaultRoot, ignoreMatcher, (aliasPath, realpath) => registerSymlinkDir(ctx, aliasPath, realpath));

    // fswatch reports absolute paths in canonical (realpath) form regardless of what literal
    // string was passed as its watch root — so if vaultRoot itself sits behind a symlink hop
    // (e.g. macOS's /var -> /private/var), matching against the raw vaultRoot here would produce
    // a bogus `../`-laden relative path for every single event. Canonicalize once for this
    // comparison only; join()/walkVaultForMarkdown elsewhere in ctx stay on the literal vaultRoot,
    // which is self-consistent since the OS resolves symlinked path components transparently.
    const canonicalVaultRoot = realpathSync(vaultRoot);
    const mainWatcher = createResilientWatcher(
        vaultRoot,
        (rawAbsPath) => acceptRawPath(ctx, rawAbsPath, (p) => toVaultRelativePath(canonicalVaultRoot, p)),
        { backoffSchedule },
    );

    return {
        stop() {
            ctx.stopped = true;
            ctx.debouncer.cancelAll();
            mainWatcher.stop();
            for (const watcher of ctx.symlinkWatchers.values()) {
                watcher.stop();
            }
            ctx.symlinkWatchers.clear();
        },
    };
}
