import { stripMdExtension, stripCodeRegions } from './note-fs.js';

// (?<!\\) rejects a backslash-escaped "#" (Obsidian's own tag/heading escape syntax) without
// consuming it, same non-consuming reasoning as the boundary lookbehind before it: consuming the
// backslash would shift what "preceded by" means for a following character and isn't needed anyway
// since a lookbehind never advances the match position.
const INLINE_TAG_PATTERN = /(?<=^|[^\p{L}\p{N}_])(?<!\\)#([\p{L}\p{N}_/-]+)/gmu;

export function extractTags(body, metadata = {}) {
    const seen = new Map();

    addTags(seen, frontmatterTags(metadata));
    addTags(seen, inlineTags(body));

    return Array.from(seen.values());
}

function frontmatterTags(metadata) {
    if (!Array.isArray(metadata.tags)) {
        return [];
    }
    return metadata.tags.map(tag => String(tag).trim()).filter(tag => tag.length > 0);
}

function inlineTags(body) {
    const stripped = stripCodeRegions(body);
    const tags = [];
    for (const match of stripped.matchAll(INLINE_TAG_PATTERN)) {
        const tag = match[1];
        if (/^\d+$/.test(tag) || tag.startsWith('/')) {
            continue;
        }
        tags.push(tag);
    }
    return tags;
}

function addTags(seen, tags) {
    for (const tag of tags) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, tag);
        }
    }
}

export function syncNoteTags(db, noteId, tagNames) {
    const tagIds = new Set(tagNames.map(name => upsertTag(db, name)));

    db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);

    const insert = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)');
    for (const tagId of tagIds) {
        insert.run(noteId, tagId);
    }

    pruneOrphanedTags(db);
}

function upsertTag(db, name) {
    db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
    return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
}

// A tag row with no note_tags reference left is garbage — nothing else ever deletes from `tags`
// (upsertTag only ever inserts). Called after every resync so `tags.name` count stays consistent
// with tagList/tagNotes, which already filter to referenced tags via their JOIN (see #1: mnotes
// stats previously counted these orphans since it does a raw `SELECT COUNT(*) FROM tags`).
export function pruneOrphanedTags(db) {
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)').run();
}

export function tagList(db) {
    return db.prepare(`
        SELECT t.name AS tag, COUNT(nt.note_id) AS notesWithTag
        FROM tags t
        JOIN note_tags nt ON nt.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.name COLLATE NOCASE
    `).all();
}

// Exact match, or a nested child (parent-includes-child, e.g. "project" matches "project/api") —
// case-insensitive via `tags.name`'s COLLATE NOCASE (S001/S004). Shared by tagNotes below and
// metadata_query's `key: "tags"` interception (S014), so the two can never drift apart.
export function tagMatchClause(tagName) {
    return { clause: 't.name = ? OR t.name LIKE ? || \'/%\'', params: [ tagName, tagName ] };
}

export function tagNotes(db, tagName) {
    const { clause, params } = tagMatchClause(tagName);
    const rows = db.prepare(`
        SELECT DISTINCT n.path AS path, n.line_count AS fileLineCount
        FROM notes n
        JOIN note_tags nt ON nt.note_id = n.id
        JOIN tags t ON t.id = nt.tag_id
        WHERE ${clause}
        ORDER BY n.path
    `).all(...params);

    return rows.map(row => ({
        noteTitle: stripMdExtension(row.path),
        fileLineCount: row.fileLineCount,
    }));
}
