import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import matter from 'gray-matter';
import { getContextLogger } from '../logger.js';

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

function readRawNote(filePath, title) {
    try {
        return readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Note not found: "${title}"`, { cause: err });
        }
        throw err;
    }
}

export function noteRead(vaultRoot, title, { startLine, endLine } = {}) {
    const filePath = titleToPath(vaultRoot, title);
    const raw = readRawNote(filePath, title);

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

function computeId(title) {
    const segments = title.split('/');
    return segments[segments.length - 1];
}

// `callerMetadata` is the metadata object passed to *this* call (null when the tool has no
// metadata param, e.g. append/rename) — distinct from `baseMetadata`, which may already be a
// merge of existing + caller metadata (S003 "Logging": only a caller-supplied `id` in this call's
// own input is worth flagging, not the routine case of an existing id carrying forward unchanged).
function withComputedId(baseMetadata, callerMetadata, title) {
    const computedId = computeId(title);
    if (callerMetadata && Object.prototype.hasOwnProperty.call(callerMetadata, 'id')) {
        getContextLogger().debug('overwrote caller-supplied id', {
            note_title: title,
            supplied_id: callerMetadata.id,
            computed_id: computedId,
        });
    }
    return { ...(baseMetadata ?? {}), id: computedId };
}

function createNote(filePath, title, metadata, content) {
    const data = withComputedId(metadata, metadata, title);
    const raw = matter.stringify(content, data);

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(content) };
}

function mergeMetadata(existing, patch) {
    if (!patch) {
        return { ...existing };
    }
    const merged = { ...existing };
    for (const [ key, value ] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function updateNote(filePath, title, hash, metadata, content) {
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_write: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before writing.`,
        );
    }

    const { data: existingMetadata } = matter(currentRaw);
    const data = withComputedId(mergeMetadata(existingMetadata, metadata), metadata, title);
    const raw = matter.stringify(content, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(content) };
}

export function noteWrite(vaultRoot, title, { hash = null, metadata = null, content } = {}) {
    const filePath = titleToPath(vaultRoot, title);
    const fileExists = existsSync(filePath);

    if (hash === null) {
        if (fileExists) {
            throw new Error(
                `note_write: "${title}" already exists — a null hash only creates a new note. `
                + 'Read the note first to get its current hash.',
            );
        }
        return createNote(filePath, title, metadata, content);
    }

    if (!fileExists) {
        throw new Error(
            `note_write: "${title}" does not exist — cannot match hash "${hash}" against a `
            + 'nonexistent note.',
        );
    }

    return updateNote(filePath, title, hash, metadata, content);
}
