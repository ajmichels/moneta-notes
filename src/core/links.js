import { stripMdExtension, stripCodeRegions, buildTitleIndex, resolveAgainstIndex } from './note-fs.js';

const WIKILINK_PATTERN = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g;

export function extractLinkTargets(body) {
    const stripped = stripCodeRegions(body);
    const seen = new Set();
    const targets = [];

    for (const match of stripped.matchAll(WIKILINK_PATTERN)) {
        const target = match[1].trim();
        if (!seen.has(target)) {
            seen.add(target);
            targets.push(target);
        }
    }

    return targets;
}

export function replaceLinkTarget(body, oldTitle, newTitle, { titleIndex = null } = {}) {
    const oldBasename = oldTitle.split('/').pop();
    const stripped = stripCodeRegions(body);
    let count = 0;

    const newBody = body.replace(WIKILINK_PATTERN, (match, target, heading, alias, offset) => {
        // Skip matches that fall inside a code region — stripCodeRegions blanks those spans in
        // `stripped` (same length/offsets as `body`), so a match whose corresponding span there
        // no longer looks like a wikilink was inside a fence/span and must be left untouched.
        if (stripped.slice(offset, offset + match.length) !== match) {
            return match;
        }

        const trimmedTarget = target.trim();
        const matchesExact = trimmedTarget === oldTitle;
        // A basename-only rewrite is only safe if that basename resolved uniquely to oldTitle at
        // the vault snapshot the caller captured (titleIndex) — never guessed from a post-rename
        // index, where oldTitle no longer exists (see S003 for why the caller builds it first).
        const matchesBasename = titleIndex !== null
            && trimmedTarget === oldBasename
            && resolveAgainstIndex(titleIndex, trimmedTarget) === oldTitle;

        if (!matchesExact && !matchesBasename) {
            return match;
        }
        count += 1;
        return `[[${newTitle}${heading ?? ''}${alias ?? ''}]]`;
    });

    return { body: newBody, count };
}

export function syncNoteLinks(db, noteId, targetTitles) {
    db.prepare('DELETE FROM note_links WHERE source_note_id = ?').run(noteId);

    const insert = db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)');
    for (const target of targetTitles) {
        insert.run(noteId, target);
    }
}

function allLinkRows(db) {
    return db.prepare(`
        SELECT n.path AS source_path, nl.target_title AS target_title
        FROM note_links nl
        JOIN notes n ON n.id = nl.source_note_id
        ORDER BY n.path, nl.target_title
    `).all();
}

export function getBrokenLinks(db) {
    const index = buildTitleIndex(db);

    return allLinkRows(db)
        .filter(row => resolveAgainstIndex(index, row.target_title) === null)
        .map(row => ({
            sourceTitle: stripMdExtension(row.source_path),
            targetTitle: row.target_title,
        }));
}

export function getBacklinks(db, title) {
    const index = buildTitleIndex(db);

    const titles = allLinkRows(db)
        .filter(row => resolveAgainstIndex(index, row.target_title) === title)
        .map(row => stripMdExtension(row.source_path));

    return [ ...new Set(titles) ].sort();
}

export function resolveLinkTargets(db, rawTargets) {
    const index = buildTitleIndex(db);
    return rawTargets.map(raw => resolveAgainstIndex(index, raw) ?? raw);
}
