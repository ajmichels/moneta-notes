import { join, relative, sep } from 'node:path';

export function titleToPath(vaultRoot, title) {
    const candidate = join(vaultRoot, `${title}.md`);
    const rel = relative(vaultRoot, candidate);

    if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`titleToPath: title "${title}" resolves outside the vault`);
    }

    return candidate;
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
