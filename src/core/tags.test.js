import { describe, it, expect } from 'vitest';
import { extractTags, syncNoteTags, tagList, tagNotes, tagMatchClause } from './tags.js';
import { openDb } from './db.js';

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function insertTestNote(db, path) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'abc123', 1, 1000, 1000);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

describe('extractTags: frontmatter', () => {
    it('returns tags from metadata.tags', () => {
        const tags = extractTags('some body text', { tags: [ 'Project', 'work' ] });
        expect(tags).toEqual([ 'Project', 'work' ]);
    });

    it('returns an empty array when there is no tags array', () => {
        expect(extractTags('body', {})).toEqual([]);
        expect(extractTags('body')).toEqual([]);
    });

    it('dedupes case-insensitively within frontmatter, keeping the first casing', () => {
        const tags = extractTags('body', { tags: [ 'Project', 'project', 'PROJECT' ] });
        expect(tags).toEqual([ 'Project' ]);
    });
});

describe('extractTags: inline hashtags', () => {
    it('extracts a tag at the start of a line and after whitespace', () => {
        const tags = extractTags('#project kickoff\nsome notes about #work today', {});
        expect(tags.sort()).toEqual([ 'project', 'work' ]);
    });

    it('extracts nested tags with slashes and hyphens', () => {
        const tags = extractTags('working on #project/api-migration today', {});
        expect(tags).toEqual([ 'project/api-migration' ]);
    });

    it('does not extract a mid-word # or a URL fragment preceded by a word character', () => {
        const tags = extractTags('see foo#bar and https://example.com/page#section', {});
        expect(tags).toEqual([]);
    });

    it('extracts a URL fragment preceded by a slash, matching a known unfixed Obsidian bug', () => {
        const tags = extractTags('see https://example.com/#section for context', {});
        expect(tags).toEqual([ 'section' ]);
    });

    it('merges frontmatter and inline sources, frontmatter casing wins on conflict', () => {
        const tags = extractTags('mentions #Project inline too', { tags: [ 'project' ] });
        expect(tags).toEqual([ 'project' ]);
    });
});

describe('extractTags: numeric-only tags are invalid', () => {
    it('rejects a purely numeric tag', () => {
        expect(extractTags('the year #1984 was notable', {})).toEqual([]);
    });

    it('accepts a tag with at least one non-numeric character', () => {
        expect(extractTags('see #y1984 for context', {})).toEqual([ 'y1984' ]);
    });
});

describe('extractTags: leading-slash tags are invalid', () => {
    it('rejects a tag with a leading slash, matching Obsidian (unsupported nested-tag form)', () => {
        expect(extractTags('see #/foo for context', {})).toEqual([]);
    });
});

describe('extractTags: the tag-start boundary check does not consume a character', () => {
    // The scan uses a zero-width lookbehind for "start of line or non-word character" rather than a
    // consuming capture group. A consuming group would eat the single separator character between
    // two adjacent tags (e.g. the "/" in "#foo/#bar"), leaving no boundary character available for
    // the next "#" and silently dropping it from the results.
    it('does not drop the middle tag in a run of slash-separated adjacent hashtags', () => {
        const tags = extractTags('#foo/#bar/#baz', {});
        expect(tags).toEqual([ 'foo/', 'bar/', 'baz' ]);
    });
});

describe('extractTags: slash-adjacent issue references match Obsidian, not "junk" filtering', () => {
    // Obsidian itself parses adjacent prose issue refs like "#2/#3/#7" into real (if odd-looking)
    // trailing-slash tags, and a slash immediately followed by prose text into a real compound tag
    // — it does not special-case or reject either shape. Extraction mirrors that exactly rather
    // than guessing at "junk"; `\#` is the documented Obsidian escape for a literal issue ref.
    it('extracts a trailing-slash tag from each adjacent issue ref, #2/#3/#7', () => {
        const tags = extractTags('Settled across #2/#3/#7 in the end.', {});
        expect(tags).toEqual([ '2/', '3/' ]);
    });

    it('extracts a doubled-slash tag as-is', () => {
        expect(extractTags('see #foo//bar for context', {})).toEqual([ 'foo//bar' ]);
    });

    it('extracts a slash immediately followed by prose as one compound tag', () => {
        const tags = extractTags('Settled across #6/the research-findings note.', {});
        expect(tags).toEqual([ '6/the' ]);
    });

    it('still accepts a normal nested tag with no empty segment', () => {
        const tags = extractTags('working on #project/api-migration today', {});
        expect(tags).toEqual([ 'project/api-migration' ]);
    });

    it('treats spaced-out issue refs as bare numeric tags, already rejected', () => {
        const tags = extractTags('Settled across #5 / #6 / #7 in the end.', {});
        expect(tags).toEqual([]);
    });
});

describe('extractTags: excludes code fences and inline code spans', () => {
    it('ignores a hashtag-shaped string inside an inline code span', () => {
        const body = 'the tag syntax is `#project` written like that';
        expect(extractTags(body, {})).toEqual([]);
    });

    it('ignores a CSS hex color inside an inline code span', () => {
        const body = 'use `#3498db` for the accent color';
        expect(extractTags(body, {})).toEqual([]);
    });

    it('ignores a shebang inside a fenced code block', () => {
        const body = [
            'run this script:',
            '```bash',
            '#!/bin/bash',
            'echo hello',
            '```',
            'that was #actual/tag though',
        ].join('\n');
        expect(extractTags(body, {})).toEqual([ 'actual/tag' ]);
    });
});

describe('syncNoteTags', () => {
    it('creates tags and links them to the note', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'Project', 'work' ]);

        const tagNames = db.prepare('SELECT name FROM tags ORDER BY name').all().map(r => r.name);
        expect(tagNames).toEqual([ 'Project', 'work' ]);

        const linkCount = db.prepare('SELECT COUNT(*) AS count FROM note_tags WHERE note_id = ?')
            .get(noteId).count;
        expect(linkCount).toBe(2);
        db.close();
    });

    it('preserves first-seen tag casing across notes via COLLATE NOCASE', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');

        syncNoteTags(db, noteA, [ 'Project' ]);
        syncNoteTags(db, noteB, [ 'project' ]);

        const tagNames = db.prepare('SELECT name FROM tags').all().map(r => r.name);
        expect(tagNames).toEqual([ 'Project' ]);
        db.close();
    });

    it('replaces note_tags rows on a second call, dropping stale links', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'old-tag' ]);
        syncNoteTags(db, noteId, [ 'new-tag' ]);

        const linkedNames = db.prepare(`
            SELECT t.name FROM tags t
            JOIN note_tags nt ON nt.tag_id = t.id
            WHERE nt.note_id = ?
        `).all(noteId).map(r => r.name);
        expect(linkedNames).toEqual([ 'new-tag' ]);
        db.close();
    });

    it('is idempotent when called twice with the same tags', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'stable' ]);
        syncNoteTags(db, noteId, [ 'stable' ]);

        const linkCount = db.prepare('SELECT COUNT(*) AS count FROM note_tags WHERE note_id = ?')
            .get(noteId).count;
        expect(linkCount).toBe(1);
        db.close();
    });

    it('deletes a tag row once its last note reference is resynced away (fixes #1)', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'old-tag' ]);
        syncNoteTags(db, noteId, [ 'new-tag' ]);

        const tagNames = db.prepare('SELECT name FROM tags').all().map(r => r.name);
        expect(tagNames).toEqual([ 'new-tag' ]);
        db.close();
    });

    it('leaves a tag row alone while at least one other note still references it', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');

        syncNoteTags(db, noteA, [ 'shared' ]);
        syncNoteTags(db, noteB, [ 'shared' ]);
        syncNoteTags(db, noteA, []);

        const tagNames = db.prepare('SELECT name FROM tags').all().map(r => r.name);
        expect(tagNames).toEqual([ 'shared' ]);
        db.close();
    });
});

describe('tagList', () => {
    it('returns exact-match counts per distinct tag, nested tags counted separately', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');
        const noteC = insertTestNote(db, 'C.md');

        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'project' ]);
        syncNoteTags(db, noteC, [ 'project/api-migration' ]);

        const list = tagList(db);

        expect(list).toEqual([
            { tag: 'project', notesWithTag: 2 },
            { tag: 'project/api-migration', notesWithTag: 1 },
        ]);
        db.close();
    });

    it('excludes a tag with no linked notes', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'A.md');

        syncNoteTags(db, noteId, [ 'temp' ]);
        syncNoteTags(db, noteId, []);

        expect(tagList(db)).toEqual([]);
        db.close();
    });
});

describe('tagMatchClause', () => {
    it('returns an exact-or-nested-child predicate with two bound params', () => {
        const { clause, params } = tagMatchClause('project');
        expect(clause).toBe("t.name = ? OR t.name LIKE ? || '/%'");
        expect(params).toEqual([ 'project', 'project' ]);
    });
});

describe('tagNotes', () => {
    it('returns notes tagged exactly and notes tagged with a nested child', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');
        const noteC = insertTestNote(db, 'Unrelated.md');

        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'project/api-migration' ]);
        syncNoteTags(db, noteC, [ 'other' ]);

        const results = tagNotes(db, 'project');

        expect(results.map(r => r.noteTitle).sort()).toEqual([ 'A', 'B' ]);
        db.close();
    });

    it('matches case-insensitively', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'Project' ]);

        const results = tagNotes(db, 'project');

        expect(results.map(r => r.noteTitle)).toEqual([ 'A' ]);
        db.close();
    });

    it('returns a note only once when it carries both a parent and a child tag', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'project', 'project/api-migration' ]);

        const results = tagNotes(db, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].noteTitle).toBe('A');
        db.close();
    });

    it('includes fileLineCount from the notes table', () => {
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'abc123', 42, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('A.md').id;
        syncNoteTags(db, noteId, [ 'project' ]);

        const results = tagNotes(db, 'project');

        expect(results[0].fileLineCount).toBe(42);
        db.close();
    });
});
