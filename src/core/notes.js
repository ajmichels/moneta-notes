import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import matter from 'gray-matter';
import { getContextLogger } from '../logger.js';
import { titleToPath, countLines } from './note-fs.js';

export function hashContent(content) {
    return createHash('sha1').update(content, 'utf8').digest('hex');
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

export const SIZE_DROP_THRESHOLD = 0.5; // fraction of current line count; config.toml-backed under S009

function updateNote(filePath, title, hash, metadata, content, { force, sizeDropThreshold }) {
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_write: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before writing.`,
        );
    }

    const { data: existingMetadata, content: existingBody } = matter(currentRaw);
    const currentLineCount = countLines(existingBody);
    const newLineCount = countLines(content);

    if (!force && newLineCount < currentLineCount * sizeDropThreshold) {
        throw new Error(
            `note_write: size-drop guard tripped for "${title}" — new content is ${newLineCount} `
            + `lines, down from ${currentLineCount} (below ${sizeDropThreshold * 100}% threshold). `
            + 'Pass force: true to override.',
        );
    }

    const data = withComputedId(mergeMetadata(existingMetadata, metadata), metadata, title);
    const raw = matter.stringify(content, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: newLineCount };
}

export function noteWrite(vaultRoot, title, {
    hash = null, metadata = null, content, force = false, sizeDropThreshold = SIZE_DROP_THRESHOLD,
} = {}) {
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

    return updateNote(filePath, title, hash, metadata, content, { force, sizeDropThreshold });
}

function countOccurrences(haystack, needle) {
    if (needle === '') {
        return 0;
    }
    return haystack.split(needle).length - 1;
}

export function noteEdit(vaultRoot, title, {
    hash, oldTxt, newTxt, metadata = null, sizeDropThreshold = SIZE_DROP_THRESHOLD,
} = {}) {
    if (!hash) {
        throw new Error(`note_edit: hash is required for "${title}"`);
    }

    const filePath = titleToPath(vaultRoot, title);
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_edit: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before editing.`,
        );
    }

    const { data: existingMetadata, content: existingBody } = matter(currentRaw);
    const occurrences = countOccurrences(existingBody, oldTxt);

    if (occurrences === 0) {
        throw new Error(`note_edit: old_txt not found in "${title}"`);
    }
    if (occurrences > 1) {
        throw new Error(
            `note_edit: old_txt matches ${occurrences} times in "${title}" — ambiguous edit, `
            + 'provide more surrounding context',
        );
    }

    const newBody = existingBody.replace(oldTxt, newTxt);
    const currentLineCount = countLines(existingBody);
    const newLineCount = countLines(newBody);

    if (newLineCount < currentLineCount * sizeDropThreshold) {
        throw new Error(
            `note_edit: size-drop guard tripped for "${title}" — new content is ${newLineCount} `
            + `lines, down from ${currentLineCount} (below ${sizeDropThreshold * 100}% threshold)`,
        );
    }

    const data = withComputedId(mergeMetadata(existingMetadata, metadata), metadata, title);
    const raw = matter.stringify(newBody, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: newLineCount };
}

// gray-matter's parsed body always carries the file's trailing newline (e.g. content '' written
// via matter.stringify round-trips as body '\n', not ''), so a naive concatenation would introduce
// a spurious blank line. Reconstruct the same "logical" body noteRead's windowing already produces.
function normalizeBody(body) {
    const totalLines = countLines(body);
    if (totalLines === 0) {
        return '';
    }
    return body.split('\n').slice(0, totalLines).join('\n');
}

export function noteAppend(vaultRoot, title, hash, content) {
    if (!hash) {
        throw new Error(`note_append: hash is required for "${title}"`);
    }

    const filePath = titleToPath(vaultRoot, title);
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_append: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before appending.`,
        );
    }

    const { data: existingMetadata, content: existingRawBody } = matter(currentRaw);
    const existingBody = normalizeBody(existingRawBody);
    const newBody = existingBody === '' ? content : `${existingBody}\n${content}`;

    const data = withComputedId(existingMetadata, null, title);
    const raw = matter.stringify(newBody, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(newBody) };
}

// Write-through counterpart to the daemon's delete-old-row/insert-new-row reconciliation
// (S005 processPath): updates the existing `notes` row in place under its original id, so
// chunks/chunk_vectors carry over untouched (no re-embed) and the note never actually disappears
// from search mid-rename. A no-op if the note wasn't indexed yet — the daemon's fswatch fallback
// picks up the new path as an ordinary create in that case.
function applyRenameToIndex(db, oldRelPath, newRelPath, newPath, note) {
    const { title, contentHash, lineCount, body, now } = note;
    const existing = db.prepare('SELECT id FROM notes WHERE path = ?').get(oldRelPath);
    if (!existing) {
        return;
    }

    const mtime = Math.floor(statSync(newPath).mtimeMs / 1000);
    const updatedAt = Math.floor(now / 1000);

    db.prepare(`
        UPDATE notes SET path = ?, content_hash = ?, line_count = ?, mtime = ?, updated_at = ?
        WHERE id = ?
    `).run(newRelPath, contentHash, lineCount, mtime, updatedAt, existing.id);

    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(existing.id);
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(existing.id, title, body);
}

export function noteRename(vaultRoot, oldTitle, newTitle, hash, db = null) {
    if (!hash) {
        throw new Error(`note_rename: hash is required for "${oldTitle}"`);
    }

    const oldPath = titleToPath(vaultRoot, oldTitle);
    const newPath = titleToPath(vaultRoot, newTitle);

    const currentRaw = readRawNote(oldPath, oldTitle);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_rename: hash mismatch for "${oldTitle}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before renaming.`,
        );
    }

    if (existsSync(newPath)) {
        throw new Error(
            `note_rename: "${newTitle}" already exists — cannot rename onto an existing note`,
        );
    }

    const { data: existingMetadata, content: body } = matter(currentRaw);
    const data = withComputedId(existingMetadata, null, newTitle);
    const raw = matter.stringify(body, data);

    mkdirSync(dirname(newPath), { recursive: true });
    writeFileSync(newPath, raw, 'utf8');
    unlinkSync(oldPath);

    const newHash = hashContent(raw);
    const lineCount = countLines(body);

    if (db !== null) {
        applyRenameToIndex(db, `${oldTitle}.md`, `${newTitle}.md`, newPath, {
            title: newTitle, contentHash: newHash, lineCount, body, now: Date.now(),
        });
    }

    return { title: newTitle, hash: newHash, line_count: lineCount };
}
