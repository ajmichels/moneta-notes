import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

export function titleToPath(vaultRoot, title) {
    return join(vaultRoot, `${title}.md`);
}

export function pathToTitle(vaultRoot, filePath) {
    return relative(vaultRoot, filePath).replace(/\.md$/, '');
}

export function hashContent(content) {
    return createHash('sha1').update(content, 'utf8').digest('hex');
}

export function countLines(content) {
    if (content === '') {
        return 0;
    }
    const lines = content.split('\n');
    return content.endsWith('\n') ? lines.length - 1 : lines.length;
}
