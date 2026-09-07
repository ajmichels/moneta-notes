import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import matter from 'gray-matter';
import { getContextLogger } from '../logger.js';
import { titleToPath, countLines, buildTitleIndex, resolveTitle } from './note-fs.js';
import { extractLinkTargets, getBacklinks, replaceLinkTarget, resolveLinkTargets } from './links.js';
import { grep } from './grep.js';
import { enqueuePath } from './db.js';

export function hashContent(content) {
    return createHash('sha1').update(content, 'utf8').digest('hex');
}

// gray-matter attributes the blank line separating frontmatter from content to `content` itself
// (e.g. parsing "---\nid: x\n---\n\nHello" yields content "\nHello\n"). Strip exactly one leading
// blank line here so `content` at every tool-facing boundary (noteRead, size-drop line counts,
// etc.) is just the note's real body, never the structural separator — the inverse of the blank
// line stringifyNote always re-adds below. A body with no separator at all (not yet conformant, or
// created before this convention existed) passes through unchanged rather than losing a real line.
function stripSeparatorBlankLine(body) {
    return body.startsWith('\n') ? body.slice(1) : body;
}

function parseNote(raw) {
    const { data, content } = matter(raw);
    return { data, content: stripSeparatorBlankLine(content) };
}

// gray-matter's own stringify butts the closing `---` straight against the first content line with
// no blank line, which doesn't match obsidian.nvim's note_frontmatter_func convention (see
// CLAUDE.local.md). Reuse gray-matter for the YAML block itself (stringify against '' isolates it,
// independent of body) and unconditionally splice in exactly one blank line before any non-empty
// body — callers always pass the real body (via parseNote above), never one still carrying the
// separator, so this never has to guess how many leading blanks are structural.
function stringifyNote(body, data) {
    const frontmatter = matter.stringify('', data).trimEnd();
    if (body === '') {
        return `${frontmatter}\n`;
    }
    return `${frontmatter}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
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

// Exact title match first (no db needed); falls back to a unique-basename match (S010) only when
// the exact path doesn't exist and a db was provided — additive, never a behavior change for a
// caller that passes no db. Returns both the resolved title and the path so the caller never needs
// to re-derive either.
function resolveReadTarget(vaultRoot, title, db) {
    const exactPath = titleToPath(vaultRoot, title);
    if (existsSync(exactPath) || db === null) {
        return { resolvedTitle: title, filePath: exactPath };
    }

    const resolved = resolveTitle(db, title);
    if (resolved === null) {
        return { resolvedTitle: title, filePath: exactPath };
    }
    return { resolvedTitle: resolved, filePath: titleToPath(vaultRoot, resolved) };
}

export function noteRead(vaultRoot, title, { startLine, endLine, db = null } = {}) {
    const { resolvedTitle, filePath } = resolveReadTarget(vaultRoot, title, db);
    const raw = readRawNote(filePath, title);

    const { data: metadata, content: body } = parseNote(raw);
    const totalLines = countLines(body);
    const contentHash = hashContent(raw);
    // Always parsed from the full body, regardless of any start_line/end_line window below — a
    // windowed read of a large note should still surface everything it links to (S003).
    const rawLinksOut = extractLinkTargets(body);
    const linksOut = db !== null ? resolveLinkTargets(db, rawLinksOut) : rawLinksOut;
    const backlinks = db !== null ? getBacklinks(db, resolvedTitle) : [];

    if (totalLines === 0) {
        return {
            title: resolvedTitle,
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            content_hash: contentHash,
            metadata,
            content: '',
            backlinks,
            links_out: linksOut,
        };
    }

    const start = startLine ?? 1;
    const end = endLine ?? totalLines;

    if (start < 1 || end < start || end > totalLines) {
        throw new Error(
            `Invalid line range ${start}-${end} for "${resolvedTitle}" (note has ${totalLines} lines)`,
        );
    }

    const content = body.split('\n').slice(start - 1, end).join('\n');

    return {
        title: resolvedTitle,
        start_line: start,
        end_line: end,
        total_lines: totalLines,
        content_hash: contentHash,
        metadata,
        content,
        backlinks,
        links_out: linksOut,
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

function withCreatedTimestamp(baseMetadata, callerMetadata, title) {
    if (callerMetadata && Object.prototype.hasOwnProperty.call(callerMetadata, 'created')) {
        getContextLogger().debug('overwrote caller-supplied created', {
            note_title: title,
            supplied_created: callerMetadata.created,
        });
    }
    return { ...baseMetadata, created: new Date().toISOString() };
}

function createNote(filePath, title, metadata, content) {
    const data = withCreatedTimestamp(withComputedId(metadata, metadata, title), metadata, title);
    const raw = stringifyNote(content, data);

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(content) };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

// Obsidian and obsidian.nvim don't support nested frontmatter structures in YAML — a bare nested
// object (`depends_on: {project: x}`) or an array containing one (`depends_on: [{project: x}]`)
// round-trips fine through gray-matter, but obsidian.nvim's on-save reformatting mangles it
// (verified empirically). Only a *newly supplied* patch is checked — pre-existing nested
// frontmatter (written before this rule, or by something other than mnotes) is left alone by
// mergeMetadata's shallow merge, so untouched keys are never retroactively rejected.
function assertFlatMetadataPatch(patch, title, toolName) {
    if (!patch) {
        return;
    }
    for (const [ key, value ] of Object.entries(patch)) {
        const hasNestedObject = isPlainObject(value) || (Array.isArray(value) && value.some(isPlainObject));
        if (hasNestedObject) {
            throw new Error(
                `${toolName}: metadata key "${key}" for "${title}" contains a nested object — `
                + 'Obsidian/obsidian.nvim frontmatter only supports flat scalars and arrays of '
                + 'scalars, never a nested object (bare or inside an array).',
            );
        }
    }
}

// Obsidian's `tags` frontmatter property expects bare names ("project"), never the "#project"
// syntax that only belongs on an inline body tag — a caller reusing that syntax in frontmatter
// (plausible since it's the same word in both places) produces a tag that silently fails to merge
// with the bare-named tag elsewhere in the vault's tag graph: no error, just a fragmented tag
// index.
// Only the `tags` key of a newly supplied patch is checked (mirrors assertFlatMetadataPatch's scope
// and rationale) — pre-existing frontmatter is left alone.
function assertNoHashPrefixedTags(patch, title, toolName) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'tags')) {
        return;
    }
    const values = Array.isArray(patch.tags) ? patch.tags : [ patch.tags ];
    for (const value of values) {
        if (typeof value === 'string' && value.startsWith('#')) {
            throw new Error(
                `${toolName}: tag "${value}" for "${title}" starts with "#" — frontmatter tags `
                + 'must be bare names (e.g. "project"), not the inline "#project" body-tag syntax.',
            );
        }
    }
}

// A wikilink or embed's brackets must stay on one line — `[[Some\nTitle]]` parses in gray-matter/
// Markdown fine but Obsidian and obsidian.nvim never resolve it (silently: no error, just a dead
// link), so this can't be caught by round-tripping. Checked against whatever text the caller is
// newly supplying (mirrors assertFlatMetadataPatch): the full content on note_write, the inserted
// new_txt on note_edit, the appended content on note_append — never the pre-existing body, so a
// note that already had one before this rule existed isn't retroactively rejected by an unrelated
// write. Non-greedy so `[[A]] .. [[B\nC]]` flags only the second link, not the whole span between.
function assertNoSplitWikilinks(text, title, toolName) {
    for (const match of text.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
        if (match[1].includes('\n')) {
            throw new Error(
                `${toolName}: a wikilink in "${title}" is split across a newline — `
                + `"[[${match[1].replace(/\n/g, '\\n')}]]" must stay on a single line, or `
                + 'Obsidian/obsidian.nvim will not resolve it.',
            );
        }
    }
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

    const { data: existingMetadata, content: existingBody } = parseNote(currentRaw);
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
    const raw = stringifyNote(content, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: newLineCount };
}

export function noteWrite(vaultRoot, title, {
    hash = null, metadata = null, content, force = false, sizeDropThreshold = SIZE_DROP_THRESHOLD,
} = {}) {
    assertFlatMetadataPatch(metadata, title, 'note_write');
    assertNoHashPrefixedTags(metadata, title, 'note_write');
    assertNoSplitWikilinks(content, title, 'note_write');

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
    assertFlatMetadataPatch(metadata, title, 'note_edit');
    assertNoHashPrefixedTags(metadata, title, 'note_edit');
    assertNoSplitWikilinks(newTxt, title, 'note_edit');

    const filePath = titleToPath(vaultRoot, title);
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_edit: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before editing.`,
        );
    }

    const { data: existingMetadata, content: existingBody } = parseNote(currentRaw);
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
    const raw = stringifyNote(newBody, data);

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
    assertNoSplitWikilinks(content, title, 'note_append');

    const filePath = titleToPath(vaultRoot, title);
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_append: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before appending.`,
        );
    }

    const { data: existingMetadata, content: existingRawBody } = parseNote(currentRaw);
    const existingBody = normalizeBody(existingRawBody);
    const newBody = existingBody === '' ? content : `${existingBody}\n${content}`;

    const data = withComputedId(existingMetadata, null, title);
    const raw = stringifyNote(newBody, data);

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

// Rewrites one candidate's [[oldTitle]] (or basename-form) wikilink references to [[newTitle]] in
// place. Throws on any failure (read, write, or an unwritable file) — the caller below treats that
// as best-effort and skips this one candidate rather than propagating it.
function rewriteLinkCandidate(vaultRoot, candidateTitle, { oldTitle, newTitle, db, titleIndex }) {
    const candidatePath = titleToPath(vaultRoot, candidateTitle);
    const candidateRaw = readFileSync(candidatePath, 'utf8');
    const { data: candidateMetadata, content: candidateBody } = parseNote(candidateRaw);
    const { body: newBody, count } = replaceLinkTarget(
        candidateBody, oldTitle, newTitle, { titleIndex },
    );

    if (count === 0) {
        return;
    }

    writeFileSync(candidatePath, stringifyNote(newBody, candidateMetadata), 'utf8');

    if (db !== null) {
        enqueuePath(db, `${candidateTitle}.md`);
    }
}

function discoverLinkCascadeCandidates(vaultRoot, oldTitle) {
    const oldBasename = oldTitle.split('/').pop();
    const patterns = oldBasename === oldTitle ? [ oldTitle ] : [ oldTitle, oldBasename ];

    const byTitle = new Map();
    for (const pattern of patterns) {
        for (const candidate of grep(vaultRoot, `[[${pattern}`)) {
            byTitle.set(candidate.noteTitle, candidate);
        }
    }
    return [ ...byTitle.values() ];
}

// Rewrites [[oldTitle]] wikilink references (including short/basename-form ones, e.g. [[Barbara
// Garn]] for a note at LoonStateHockey/JMS Hockey/Barbara Garn) to [[newTitle]] in every other note
// that links to the note being renamed (S003/S011). Best-effort throughout — a discovery or
// per-candidate failure is logged and skipped, never thrown, since the primary rename has already
// fully succeeded by the time this runs. Reused (unmodified) for the renamed note's own new file
// too, if it happens to contain a self-referential link — grep finds it like any other candidate.
//
// `titleIndex` must be built from vault state *before* the file-level rename below (S010's
// buildTitleIndex) — by the time this runs, oldTitle no longer exists on disk, so an index built
// afterward could never confirm a basename resolves uniquely to it. Without a db (titleIndex null),
// only exact full-title matches get rewritten — see replaceLinkTarget (S011).
function cascadeLinkRename(vaultRoot, oldTitle, newTitle, db, titleIndex) {
    let candidates;
    try {
        candidates = discoverLinkCascadeCandidates(vaultRoot, oldTitle);
    } catch (err) {
        getContextLogger().warn('link cascade: candidate discovery failed', {
            note_title: newTitle,
            error_message: err.message,
        });
        return;
    }

    for (const candidate of candidates) {
        const candidateTitle = candidate.noteTitle;
        try {
            rewriteLinkCandidate(vaultRoot, candidateTitle, { oldTitle, newTitle, db, titleIndex });
        } catch (err) {
            getContextLogger().warn('link cascade: failed to update candidate', {
                note_title: newTitle,
                candidate_title: candidateTitle,
                error_message: err.message,
            });
        }
    }
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

    // Captured before the file move / index write-through below — the link cascade needs to know
    // whether oldTitle's basename was unique *before* the rename, since oldTitle won't exist in the
    // vault (or in a post-rename index) by the time the cascade runs (S003).
    const titleIndex = db !== null ? buildTitleIndex(db) : null;

    const { data: existingMetadata, content: body } = parseNote(currentRaw);
    const data = withComputedId(existingMetadata, null, newTitle);
    const raw = stringifyNote(body, data);

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

    cascadeLinkRename(vaultRoot, oldTitle, newTitle, db, titleIndex);

    // Re-read the final on-disk state rather than trusting newHash/lineCount above — the cascade
    // just run may have rewritten this exact file a second time if it contained a self-referential
    // [[oldTitle]] link, and a caller chaining a follow-up mutation off this response needs a hash
    // that matches reality, not the intermediate post-rename-only value (S003).
    const finalRaw = readFileSync(newPath, 'utf8');
    const { content: finalBody } = parseNote(finalRaw);

    return { title: newTitle, hash: hashContent(finalRaw), line_count: countLines(finalBody) };
}
