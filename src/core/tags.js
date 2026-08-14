import { stripMdExtension, stripCodeRegions } from './note-fs.js';

const INLINE_TAG_PATTERN = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_/-]+)/gmu;

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
        const tag = match[2];
        if (/^\d+$/.test(tag)) {
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
}

function upsertTag(db, name) {
    db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
    return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
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

export function tagNotes(db, tagName) {
    const rows = db.prepare(`
        SELECT DISTINCT n.path AS path, n.line_count AS fileLineCount
        FROM notes n
        JOIN note_tags nt ON nt.note_id = n.id
        JOIN tags t ON t.id = nt.tag_id
        WHERE t.name = ? OR t.name LIKE ? || '/%'
        ORDER BY n.path
    `).all(tagName, tagName);

    return rows.map(row => ({
        noteTitle: stripMdExtension(row.path),
        fileLineCount: row.fileLineCount,
    }));
}
