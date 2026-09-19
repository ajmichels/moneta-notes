import { readdirSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';

export function statOrNull(absPath) {
    try {
        return statSync(absPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

export function lstatOrNull(absPath) {
    try {
        return lstatSync(absPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

// realpathSync throws ENOENT for a dangling symlink (or one that vanished between calls) — treated
// the same way statOrNull treats a missing file, since both are "nothing there to resolve".
export function realpathOrNull(absPath) {
    try {
        return realpathSync(absPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

export function toVaultRelativePath(vaultRoot, absPath) {
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
//
// Symlinked directories (S005) descend via their alias path, never the realpath; a symlinked file
// or dangling link is skipped. `onSymlinkDir(aliasPath, realpath)` fires for each one found, at any
// depth — the hook a watcher uses to spawn its `fswatch` process. `visitedRealDirs` guards cycles
// by realpath; `startDir` scopes the walk while relative paths still resolve via `vaultRoot`.
export function walkVaultForMarkdown(vaultRoot, ignoreMatcher = ignore(), onSymlinkDir = () => {}, startDir = vaultRoot) {
    const results = [];
    const visitedRealDirs = new Set([ realpathSync(vaultRoot), realpathSync(startDir) ]);

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

        if (entry.isSymbolicLink()) {
            const target = realpathOrNull(full);
            const stats = target === null ? null : statOrNull(target);
            if (stats === null || !stats.isDirectory()) {
                return; // symlinked file, or dangling target — never indexed
            }
            if (visitedRealDirs.has(target) || ignoreMatcher.ignores(`${relativePath}/`)) {
                return;
            }
            visitedRealDirs.add(target);
            onSymlinkDir(relativePath, target);
            walk(full);
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

    walk(startDir);
    return results;
}

// Pure view of walkVaultForMarkdown's symlink discovery, testable with no fswatch involved.
// live-watcher.js builds its live registry by feeding the same hook into its own walk instead of
// calling this (it also needs to spawn watchers as each one is found, not just record it).
export function buildSymlinkRegistry(vaultRoot, ignoreMatcher = ignore()) {
    const registry = new Map();
    walkVaultForMarkdown(vaultRoot, ignoreMatcher, (aliasPath, realpath) => registry.set(aliasPath, realpath));
    return registry;
}

// A per-symlink fswatch child reports realpath-based paths (S005); rewrites one back to its
// vault-relative alias by longest-prefix match. null (a stale/torn-down watcher's event) must be
// logged and dropped, never enqueued — a raw realpath would break S001's path-identity rule.
export function rewriteEventPath(absPath, registry) {
    let bestAlias = null;
    let bestRealpath = '';
    for (const [ aliasPath, realpath ] of registry) {
        const isMatch = absPath === realpath || absPath.startsWith(`${realpath}${sep}`);
        if (isMatch && realpath.length > bestRealpath.length) {
            bestAlias = aliasPath;
            bestRealpath = realpath;
        }
    }
    if (bestAlias === null) {
        return null;
    }
    return `${bestAlias}${absPath.slice(bestRealpath.length)}`.split(sep).join('/');
}
