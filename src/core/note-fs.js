import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';

export function resolveVaultPath(vaultRoot, relativePath) {
    const candidate = join(vaultRoot, relativePath);
    const rel = relative(vaultRoot, candidate);

    if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`resolveVaultPath: "${relativePath}" resolves outside the vault`);
    }

    return candidate;
}

export function titleToPath(vaultRoot, title) {
    return resolveVaultPath(vaultRoot, `${title}.md`);
}

export function stripMdExtension(relativePath) {
    return relativePath.replace(/\.md$/, '');
}

export function pathToTitle(vaultRoot, filePath) {
    return stripMdExtension(relative(vaultRoot, filePath).split(sep).join('/'));
}

export function countLines(content) {
    if (content === '') {
        return 0;
    }
    const lines = content.split('\n');
    return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

function blank(match) {
    return ' '.repeat(match.length);
}

export function stripCodeRegions(body) {
    return body
        .replace(/```[\s\S]*?```/g, blank)
        .replace(/`[^`\n]*`/g, blank);
}

export function buildTitleIndex(db) {
    const byTitle = new Set();
    const byBasename = new Map();

    for (const { path } of db.prepare('SELECT path FROM notes').all()) {
        const title = stripMdExtension(path);
        byTitle.add(title);

        const basename = title.split('/').pop();
        if (!byBasename.has(basename)) {
            byBasename.set(basename, []);
        }
        byBasename.get(basename).push(title);
    }

    return { byTitle, byBasename };
}

export function resolveAgainstIndex(index, rawTitle) {
    if (index.byTitle.has(rawTitle)) {
        return rawTitle;
    }
    const candidates = index.byBasename.get(rawTitle);
    return candidates && candidates.length === 1 ? candidates[0] : null;
}

export function resolveTitle(db, rawTitle) {
    return resolveAgainstIndex(buildTitleIndex(db), rawTitle);
}

// Gitignore-style exclusion for vault-relative paths (Obsidian template folders being the driving
// case — see S010). An absent .mnotesignore is equivalent to an empty one: the returned matcher's
// ignores() always returns false, no different from a project with no .gitignore. Checking a
// directory during a walk should pass a trailing slash (matches ignore's own directory convention)
// so a dir-only pattern like "Templates/" matches before descending into it.
export function loadIgnoreMatcher(vaultRoot) {
    const ignoreFilePath = join(vaultRoot, '.mnotesignore');
    const patterns = existsSync(ignoreFilePath) ? readFileSync(ignoreFilePath, 'utf8') : '';
    return ignore().add(patterns);
}
