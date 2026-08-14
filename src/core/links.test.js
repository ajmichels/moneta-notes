import { describe, it, expect } from 'vitest';
import {
    extractLinkTargets, replaceLinkTarget, syncNoteLinks, getBacklinks, getBrokenLinks,
    resolveLinkTargets,
} from './links.js';
import { openDb } from './db.js';
import { buildTitleIndex } from './note-fs.js';

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

describe('extractLinkTargets', () => {
    it('extracts a plain wikilink target', () => {
        expect(extractLinkTargets('see [[Other Note]] for context')).toEqual([ 'Other Note' ]);
    });

    it('extracts a target with an alias, dropping the alias', () => {
        expect(extractLinkTargets('see [[Other Note|the other note]] for context'))
            .toEqual([ 'Other Note' ]);
    });

    it('extracts a target with a heading anchor, dropping the heading', () => {
        expect(extractLinkTargets('see [[Other Note#Some Heading]]')).toEqual([ 'Other Note' ]);
    });

    it('extracts a target with both a heading and an alias', () => {
        expect(extractLinkTargets('see [[Other Note#Some Heading|display text]]'))
            .toEqual([ 'Other Note' ]);
    });

    it('treats an embed the same as a plain link', () => {
        expect(extractLinkTargets('![[Other Note]]')).toEqual([ 'Other Note' ]);
    });

    it('dedupes multiple mentions of the same target, keeping first-appearance order', () => {
        const body = '[[B]] then [[A]] then [[B]] again';
        expect(extractLinkTargets(body)).toEqual([ 'B', 'A' ]);
    });

    it('extracts multiple distinct targets', () => {
        expect(extractLinkTargets('[[A]] and [[B]]')).toEqual([ 'A', 'B' ]);
    });

    it('returns an empty array when there are no links', () => {
        expect(extractLinkTargets('no links here')).toEqual([]);
    });

    it('ignores a wikilink-shaped string inside an inline code span', () => {
        expect(extractLinkTargets('the syntax is `[[Target]]` written like that')).toEqual([]);
    });

    it('ignores a wikilink-shaped string inside a fenced code block', () => {
        const body = [
            'example:',
            '```md',
            '[[Fenced Target]]',
            '```',
            'but [[Real Target]] is live',
        ].join('\n');
        expect(extractLinkTargets(body)).toEqual([ 'Real Target' ]);
    });
});

describe('replaceLinkTarget', () => {
    it('rewrites a plain link target', () => {
        const { body, count } = replaceLinkTarget('see [[Old]] here', 'Old', 'New');
        expect(body).toBe('see [[New]] here');
        expect(count).toBe(1);
    });

    it('preserves an alias while rewriting the target', () => {
        const { body, count } = replaceLinkTarget('[[Old|display text]]', 'Old', 'New');
        expect(body).toBe('[[New|display text]]');
        expect(count).toBe(1);
    });

    it('preserves a heading anchor while rewriting the target', () => {
        const { body, count } = replaceLinkTarget('[[Old#Section]]', 'Old', 'New');
        expect(body).toBe('[[New#Section]]');
        expect(count).toBe(1);
    });

    it('preserves both heading and alias', () => {
        const { body, count } = replaceLinkTarget('[[Old#Section|shown]]', 'Old', 'New');
        expect(body).toBe('[[New#Section|shown]]');
        expect(count).toBe(1);
    });

    it('rewrites every occurrence and reports the count', () => {
        const { body, count } = replaceLinkTarget('[[Old]] and [[Old|again]]', 'Old', 'New');
        expect(body).toBe('[[New]] and [[New|again]]');
        expect(count).toBe(2);
    });

    it('does not rewrite a different target that is a prefix of oldTitle', () => {
        const { body, count } = replaceLinkTarget('[[Old Extended]]', 'Old', 'New');
        expect(body).toBe('[[Old Extended]]');
        expect(count).toBe(0);
    });

    it('leaves a match inside a code span untouched', () => {
        const body = 'the syntax is `[[Old]]` written like that';
        const result = replaceLinkTarget(body, 'Old', 'New');
        expect(result.body).toBe(body);
        expect(result.count).toBe(0);
    });

    it('returns count 0 and the original body when there is nothing to replace', () => {
        const result = replaceLinkTarget('no links here', 'Old', 'New');
        expect(result.body).toBe('no links here');
        expect(result.count).toBe(0);
    });

    it('rewrites a short/basename-form reference when titleIndex confirms it resolves uniquely', () => {
        const db = makeTestDb();
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');
        const titleIndex = buildTitleIndex(db);

        const result = replaceLinkTarget(
            'see [[Barbara Garn]]', 'LoonStateHockey/JMS Hockey/Barbara Garn', 'New Name',
            { titleIndex },
        );

        expect(result.body).toBe('see [[New Name]]');
        expect(result.count).toBe(1);
        db.close();
    });

    it('does not rewrite a basename-form reference without a titleIndex', () => {
        const result = replaceLinkTarget(
            'see [[Barbara Garn]]', 'LoonStateHockey/JMS Hockey/Barbara Garn', 'New Name',
        );
        expect(result.body).toBe('see [[Barbara Garn]]');
        expect(result.count).toBe(0);
    });

    it('does not rewrite a basename-form reference that is ambiguous in titleIndex', () => {
        const db = makeTestDb();
        insertTestNote(db, 'A/Notes.md');
        insertTestNote(db, 'B/Notes.md');
        const titleIndex = buildTitleIndex(db);

        const result = replaceLinkTarget('see [[Notes]]', 'A/Notes', 'A/New Name', { titleIndex });

        expect(result.body).toBe('see [[Notes]]');
        expect(result.count).toBe(0);
        db.close();
    });

    it('still rewrites an exact full-title match even when titleIndex is provided', () => {
        const db = makeTestDb();
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');
        const titleIndex = buildTitleIndex(db);

        const result = replaceLinkTarget(
            'see [[LoonStateHockey/JMS Hockey/Barbara Garn]]',
            'LoonStateHockey/JMS Hockey/Barbara Garn', 'New Name', { titleIndex },
        );

        expect(result.body).toBe('see [[New Name]]');
        expect(result.count).toBe(1);
        db.close();
    });
});

describe('resolveLinkTargets', () => {
    it('resolves a mix of exact, basename, and unresolved targets', () => {
        const db = makeTestDb();
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');
        insertTestNote(db, 'Exact Title.md');

        const resolved = resolveLinkTargets(
            db, [ 'Barbara Garn', 'Exact Title', 'Nowhere To Be Found' ],
        );

        expect(resolved).toEqual([
            'LoonStateHockey/JMS Hockey/Barbara Garn', 'Exact Title', 'Nowhere To Be Found',
        ]);
        db.close();
    });

    it('leaves an ambiguous basename as the raw literal text', () => {
        const db = makeTestDb();
        insertTestNote(db, 'A/Notes.md');
        insertTestNote(db, 'B/Notes.md');

        expect(resolveLinkTargets(db, [ 'Notes' ])).toEqual([ 'Notes' ]);
        db.close();
    });

    it('returns an empty array for an empty input', () => {
        const db = makeTestDb();
        expect(resolveLinkTargets(db, [])).toEqual([]);
        db.close();
    });
});

describe('syncNoteLinks', () => {
    it('stores distinct target titles for a note', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteLinks(db, noteId, [ 'A', 'B' ]);

        const targets = db.prepare('SELECT target_title FROM note_links WHERE source_note_id = ? ORDER BY target_title')
            .all(noteId).map(r => r.target_title);
        expect(targets).toEqual([ 'A', 'B' ]);
        db.close();
    });

    it('replaces note_links rows on a second call, dropping stale targets', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteLinks(db, noteId, [ 'Old Target' ]);
        syncNoteLinks(db, noteId, [ 'New Target' ]);

        const targets = db.prepare('SELECT target_title FROM note_links WHERE source_note_id = ?')
            .all(noteId).map(r => r.target_title);
        expect(targets).toEqual([ 'New Target' ]);
        db.close();
    });

    it('is idempotent when called twice with the same targets', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteLinks(db, noteId, [ 'Stable' ]);
        syncNoteLinks(db, noteId, [ 'Stable' ]);

        const count = db.prepare('SELECT COUNT(*) AS count FROM note_links WHERE source_note_id = ?')
            .get(noteId).count;
        expect(count).toBe(1);
        db.close();
    });

    it('stores a target even when no note with that title exists (unresolved link)', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteLinks(db, noteId, [ 'Nonexistent' ]);

        const targets = db.prepare('SELECT target_title FROM note_links WHERE source_note_id = ?')
            .all(noteId).map(r => r.target_title);
        expect(targets).toEqual([ 'Nonexistent' ]);
        db.close();
    });
});

describe('getBacklinks', () => {
    it('returns titles of notes linking to the given title', () => {
        const db = makeTestDb();
        insertTestNote(db, 'Target.md');
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');
        insertTestNote(db, 'Unrelated.md');

        syncNoteLinks(db, noteA, [ 'Target' ]);
        syncNoteLinks(db, noteB, [ 'Target' ]);

        expect(getBacklinks(db, 'Target')).toEqual([ 'A', 'B' ]);
        db.close();
    });

    it('returns an empty array when nothing links to the title', () => {
        const db = makeTestDb();
        insertTestNote(db, 'Nothing Links Here.md');
        expect(getBacklinks(db, 'Nothing Links Here')).toEqual([]);
        db.close();
    });

    it('matches exact-string only, not case-insensitively', () => {
        const db = makeTestDb();
        insertTestNote(db, 'Target.md');
        const noteA = insertTestNote(db, 'A.md');
        syncNoteLinks(db, noteA, [ 'Target' ]);

        expect(getBacklinks(db, 'target')).toEqual([]);
        expect(getBacklinks(db, 'Target')).toEqual([ 'A' ]);
        db.close();
    });

    it('returns results ordered alphabetically by title', () => {
        const db = makeTestDb();
        insertTestNote(db, 'Target.md');
        const noteZ = insertTestNote(db, 'Z.md');
        const noteA = insertTestNote(db, 'A.md');

        syncNoteLinks(db, noteZ, [ 'Target' ]);
        syncNoteLinks(db, noteA, [ 'Target' ]);

        expect(getBacklinks(db, 'Target')).toEqual([ 'A', 'Z' ]);
        db.close();
    });

    it('finds a backlink written in short/basename form for a nested note', () => {
        const db = makeTestDb();
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');
        const linkerId = insertTestNote(db, 'Linker.md');
        syncNoteLinks(db, linkerId, [ 'Barbara Garn' ]);

        expect(getBacklinks(db, 'LoonStateHockey/JMS Hockey/Barbara Garn')).toEqual([ 'Linker' ]);
        db.close();
    });

    it('does not attribute a backlink whose basename is ambiguous', () => {
        const db = makeTestDb();
        insertTestNote(db, 'A/Notes.md');
        insertTestNote(db, 'B/Notes.md');
        const linkerId = insertTestNote(db, 'Linker.md');
        syncNoteLinks(db, linkerId, [ 'Notes' ]);

        expect(getBacklinks(db, 'A/Notes')).toEqual([]);
        expect(getBacklinks(db, 'B/Notes')).toEqual([]);
        db.close();
    });

    it('dedupes a source note reaching the target via two differently-written links', () => {
        const db = makeTestDb();
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');
        const linkerId = insertTestNote(db, 'Linker.md');
        syncNoteLinks(db, linkerId, [ 'Barbara Garn', 'LoonStateHockey/JMS Hockey/Barbara Garn' ]);

        expect(getBacklinks(db, 'LoonStateHockey/JMS Hockey/Barbara Garn')).toEqual([ 'Linker' ]);
        db.close();
    });
});

describe('getBrokenLinks', () => {
    it('returns a link whose target has no matching note', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Linker.md');
        syncNoteLinks(db, noteId, [ 'Nonexistent' ]);

        expect(getBrokenLinks(db)).toEqual([
            { sourceTitle: 'Linker', targetTitle: 'Nonexistent' },
        ]);
        db.close();
    });

    it('excludes a link whose target resolves to an existing note', () => {
        const db = makeTestDb();
        const linkerId = insertTestNote(db, 'Linker.md');
        insertTestNote(db, 'Target.md');
        syncNoteLinks(db, linkerId, [ 'Target' ]);

        expect(getBrokenLinks(db)).toEqual([]);
        db.close();
    });

    it('returns one row per (source, broken target) pair, across multiple notes', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');
        syncNoteLinks(db, noteA, [ 'Missing One' ]);
        syncNoteLinks(db, noteB, [ 'Missing One', 'Missing Two' ]);

        const broken = getBrokenLinks(db);
        expect(broken).toHaveLength(3);
        expect(broken).toContainEqual({ sourceTitle: 'A', targetTitle: 'Missing One' });
        expect(broken).toContainEqual({ sourceTitle: 'B', targetTitle: 'Missing One' });
        expect(broken).toContainEqual({ sourceTitle: 'B', targetTitle: 'Missing Two' });
        db.close();
    });

    it('returns an empty array when there are no links at all', () => {
        const db = makeTestDb();
        expect(getBrokenLinks(db)).toEqual([]);
        db.close();
    });

    it('orders results by source path then target title', () => {
        const db = makeTestDb();
        const noteB = insertTestNote(db, 'B.md');
        const noteA = insertTestNote(db, 'A.md');
        syncNoteLinks(db, noteB, [ 'Z Missing' ]);
        syncNoteLinks(db, noteA, [ 'Z Missing', 'A Missing' ]);

        expect(getBrokenLinks(db)).toEqual([
            { sourceTitle: 'A', targetTitle: 'A Missing' },
            { sourceTitle: 'A', targetTitle: 'Z Missing' },
            { sourceTitle: 'B', targetTitle: 'Z Missing' },
        ]);
        db.close();
    });
});
