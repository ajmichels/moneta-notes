import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

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

export function noteRead(vaultRoot, title, { startLine, endLine } = {}) {
    const filePath = titleToPath(vaultRoot, title);

    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Note not found: "${title}"`, { cause: err });
        }
        throw err;
    }

    const { data: metadata, content: body } = matter(raw);
    const totalLines = countLines(body);
    const contentHash = hashContent(raw);

    if (totalLines === 0) {
        return {
            title,
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            content_hash: contentHash,
            metadata,
            content: '',
        };
    }

    const start = startLine ?? 1;
    const end = endLine ?? totalLines;

    if (start < 1 || end < start || end > totalLines) {
        throw new Error(
            `Invalid line range ${start}-${end} for "${title}" (note has ${totalLines} lines)`,
        );
    }

    const content = body.split('\n').slice(start - 1, end).join('\n');

    return {
        title,
        start_line: start,
        end_line: end,
        total_lines: totalLines,
        content_hash: contentHash,
        metadata,
        content,
    };
}
