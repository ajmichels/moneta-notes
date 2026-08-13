import { join, relative, sep } from 'node:path';

export function titleToPath(vaultRoot, title) {
    return join(vaultRoot, `${title}.md`);
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
