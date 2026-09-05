import { describe, it, expect } from 'vitest';
import { buildMetadataJson, metadataKeys, metadataQuery } from './metadata.js';
import { openDb } from './db.js';
import { syncNoteTags } from './tags.js';

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function insertNoteWithMetadata(db, path, metadata) {
    return insertNoteWithRawMetadataJson(db, path, JSON.stringify(metadata));
}

// Some tests need a metadata_json string JS can't produce by first building a plain object — e.g.
// an integer literal larger than Number.MAX_SAFE_INTEGER would already be rounded by the time a JS
// number literal reached JSON.stringify, before ever exercising the bug under test.
function insertNoteWithRawMetadataJson(db, path, json) {
    db.prepare(`
        INSERT INTO notes (path, content_hash, line_count, mtime, updated_at, metadata_json)
        VALUES (?, 'abc123', 1, 1000, 1000, ?)
    `).run(path, json);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

describe('buildMetadataJson', () => {
    it('stringifies plain frontmatter fields', () => {
        expect(buildMetadataJson({ status: 'active', priority: 3 }))
            .toBe(JSON.stringify({ status: 'active', priority: 3 }));
    });

    it('excludes tags', () => {
        expect(buildMetadataJson({ status: 'active', tags: [ 'project', 'work' ] }))
            .toBe(JSON.stringify({ status: 'active' }));
    });

    it('includes id and created like any other key', () => {
        const metadata = { id: 'abc123', created: new Date('2026-01-01T00:00:00.000Z') };
        expect(buildMetadataJson(metadata))
            .toBe(JSON.stringify({ id: 'abc123', created: '2026-01-01T00:00:00.000Z' }));
    });

    it('replaces a top-level Date with its ISO string', () => {
        const metadata = { due: new Date('2026-03-05T00:00:00.000Z') };
        expect(buildMetadataJson(metadata))
            .toBe(JSON.stringify({ due: '2026-03-05T00:00:00.000Z' }));
    });

    it('replaces a Date nested inside an object', () => {
        const metadata = { project: { due: new Date('2026-03-05T00:00:00.000Z'), name: 'foo' } };
        expect(buildMetadataJson(metadata))
            .toBe(JSON.stringify({ project: { due: '2026-03-05T00:00:00.000Z', name: 'foo' } }));
    });

    it('replaces a Date nested inside an array of objects', () => {
        const metadata = {
            depends_on: [
                { project: 'foo/bar', due: new Date('2026-03-05T00:00:00.000Z') },
                { project: 'biz/buz', due: new Date('2026-04-01T00:00:00.000Z') },
            ],
        };
        expect(JSON.parse(buildMetadataJson(metadata))).toEqual({
            depends_on: [
                { project: 'foo/bar', due: '2026-03-05T00:00:00.000Z' },
                { project: 'biz/buz', due: '2026-04-01T00:00:00.000Z' },
            ],
        });
    });

    it('replaces a Date nested inside a plain array', () => {
        const metadata = { milestones: [ new Date('2026-01-01T00:00:00.000Z'), 'not-a-date' ] };
        expect(JSON.parse(buildMetadataJson(metadata))).toEqual({
            milestones: [ '2026-01-01T00:00:00.000Z', 'not-a-date' ],
        });
    });

    it('defaults to an empty object when metadata is empty', () => {
        expect(buildMetadataJson({})).toBe('{}');
    });
});

describe('metadataKeys', () => {
    it('infers number/string/boolean/date types from a sampled value', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', {
            priority: 3, status: 'active', done: true, due: '2026-01-01T00:00:00.000Z',
        });

        const keys = metadataKeys(db).sort((a, b) => a.key.localeCompare(b.key));

        expect(keys).toEqual([
            { key: 'done', type: 'boolean', example: true, notesWithKey: 1 },
            { key: 'due', type: 'date', example: '2026-01-01T00:00:00.000Z', notesWithKey: 1 },
            { key: 'priority', type: 'number', example: 3, notesWithKey: 1 },
            { key: 'status', type: 'string', example: 'active', notesWithKey: 1 },
        ]);
    });

    it('counts a key once per note even when it appears in multiple array entries', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', {
            depends_on: [ { project: 'foo/bar' }, { project: 'biz/buz' } ],
        });
        insertNoteWithMetadata(db, 'B.md', { depends_on: [ { project: 'foo/bar' } ] });

        const keys = metadataKeys(db);

        expect(keys).toEqual([
            { key: 'depends_on.project', type: 'string', example: 'foo/bar', notesWithKey: 2 },
        ]);
    });

    it('normalizes a hyphenated (quoted) key down to its bare dot-path form', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { 'depends-on': 'foo/bar' });

        expect(metadataKeys(db)).toEqual([
            { key: 'depends-on', type: 'string', example: 'foo/bar', notesWithKey: 1 },
        ]);
    });

    it('never surfaces tags as a key, since buildMetadataJson already excludes it at write time', () => {
        const db = makeTestDb();
        const path = 'A.md';
        db.prepare(`
            INSERT INTO notes (path, content_hash, line_count, mtime, updated_at, metadata_json)
            VALUES (?, 'abc123', 1, 1000, 1000, ?)
        `).run(path, buildMetadataJson({ tags: [ 'project' ], status: 'active' }));

        expect(metadataKeys(db).map((k) => k.key)).toEqual([ 'status' ]);
    });

    it('skips a null value when sampling the example/type but still counts the note', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { due: null });
        insertNoteWithMetadata(db, 'B.md', { due: '2026-01-01' });

        expect(metadataKeys(db)).toEqual([
            { key: 'due', type: 'date', example: '2026-01-01', notesWithKey: 2 },
        ]);
    });

    it('returns an empty array when no note has any metadata', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', {});

        expect(metadataKeys(db)).toEqual([]);
    });

    it('does not crash on an integer larger than Number.MAX_SAFE_INTEGER (e.g. an obsidian.nvim id), '
        + 'preserving its exact digits as the example instead of a silently-rounded number', () => {
        const db = makeTestDb();
        insertNoteWithRawMetadataJson(db, 'A.md', '{"id":20240708102843484}');

        expect(metadataKeys(db)).toEqual([
            { key: 'id', type: 'number', example: '20240708102843484', notesWithKey: 1 },
        ]);
    });

    it('still returns a normal JS number for an in-range integer', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { priority: 3 });

        expect(metadataKeys(db)).toEqual([
            { key: 'priority', type: 'number', example: 3, notesWithKey: 1 },
        ]);
    });
});

function titles(results) {
    return results.map((r) => r.noteTitle).sort();
}

describe('metadataQuery: scalar conditions', () => {
    it('matches a plain scalar equality', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { status: 'active' });
        insertNoteWithMetadata(db, 'B.md', { status: 'archived' });

        const results = metadataQuery(db, { filters: [ { key: 'status', op: 'eq', value: 'active' } ] });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('matches a numeric range', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { priority: 5 });
        insertNoteWithMetadata(db, 'B.md', { priority: 1 });

        const results = metadataQuery(db, { filters: [ { key: 'priority', op: 'gte', value: 3 } ] });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('matches "in" against a list of values', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { status: 'active' });
        insertNoteWithMetadata(db, 'B.md', { status: 'draft' });
        insertNoteWithMetadata(db, 'C.md', { status: 'archived' });

        const results = metadataQuery(db, {
            filters: [ { key: 'status', op: 'in', value: [ 'active', 'draft' ] } ],
        });
        expect(titles(results)).toEqual([ 'A', 'B' ]);
    });

    it('exists matches only notes where the key resolves non-null', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { due: '2026-01-01' });
        insertNoteWithMetadata(db, 'B.md', { due: null });
        insertNoteWithMetadata(db, 'C.md', { status: 'active' });

        const results = metadataQuery(db, { filters: [ { key: 'due', op: 'exists' } ] });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('missing (negated exists) matches notes where the key is absent or null', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { due: '2026-01-01' });
        insertNoteWithMetadata(db, 'B.md', { due: null });
        insertNoteWithMetadata(db, 'C.md', { status: 'active' });

        const results = metadataQuery(db, {
            filters: [ { key: 'due', op: 'exists', negate: true } ],
        });
        expect(titles(results)).toEqual([ 'B', 'C' ]);
    });
});

describe('metadataQuery: dot-path/array-of-object addressing', () => {
    it('matches an independent field inside an array-of-objects entry', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', {
            depends_on: [ { project: 'foo/bar', source: 'x' }, { project: 'other', source: 'y' } ],
        });
        insertNoteWithMetadata(db, 'B.md', { depends_on: [ { project: 'other', source: 'z' } ] });

        const results = metadataQuery(db, {
            filters: [ { key: 'depends_on.project', op: 'eq', value: 'foo/bar' } ],
        });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('matches a plain scalar the same way a single-element array would', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { status: 'active' });

        const results = metadataQuery(db, { filters: [ { key: 'status', op: 'eq', value: 'active' } ] });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('rejects a key with more than one dot', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { a: { b: { c: 1 } } });

        expect(() => metadataQuery(db, { filters: [ { key: 'a.b.c', op: 'eq', value: 1 } ] }))
            .toThrow(/more than one dot/);
    });
});

describe('metadataQuery: negation on multi-valued keys', () => {
    it('correctly excludes a note that depends on the negated value among others', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', {
            depends_on: [ { project: 'foo/bar' }, { project: 'biz/buz' } ],
        });
        insertNoteWithMetadata(db, 'B.md', { depends_on: [ { project: 'biz/buz' } ] });

        // Note A depends on both foo/bar and biz/buz. A naive per-element `!= 'foo/bar'` check
        // would wrongly match A (it has *some* element that isn't foo/bar) even though it also
        // depends on foo/bar — exactly what negating "depends on foo/bar" should exclude.
        const results = metadataQuery(db, {
            filters: [ { key: 'depends_on.project', op: 'eq', value: 'foo/bar', negate: true } ],
        });
        expect(titles(results)).toEqual([ 'B' ]);
    });
});

describe('metadataQuery: match combinator', () => {
    it('match: all (default) requires every condition', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { status: 'active', priority: 5 });
        insertNoteWithMetadata(db, 'B.md', { status: 'active', priority: 1 });

        const results = metadataQuery(db, {
            filters: [
                { key: 'status', op: 'eq', value: 'active' },
                { key: 'priority', op: 'gte', value: 3 },
            ],
        });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('match: any requires only one condition', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { status: 'active' });
        insertNoteWithMetadata(db, 'B.md', { priority: 9 });
        insertNoteWithMetadata(db, 'C.md', { status: 'archived', priority: 1 });

        const results = metadataQuery(db, {
            match: 'any',
            filters: [
                { key: 'status', op: 'eq', value: 'active' },
                { key: 'priority', op: 'gte', value: 5 },
            ],
        });
        expect(titles(results)).toEqual([ 'A', 'B' ]);
    });
});

describe('metadataQuery: boolean values', () => {
    it('matches a boolean equality (node:sqlite cannot bind a raw JS boolean)', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { done: true });
        insertNoteWithMetadata(db, 'B.md', { done: false });

        const results = metadataQuery(db, { filters: [ { key: 'done', op: 'eq', value: true } ] });
        expect(titles(results)).toEqual([ 'A' ]);
    });
});

describe('metadataQuery: date literals', () => {
    it('canonicalizes a short-form date literal so an exact-midnight match is excluded from gt', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { due: '2026-01-01T00:00:00.000Z' });

        const gt = metadataQuery(db, { filters: [ { key: 'due', op: 'gt', value: '2026-01-01' } ] });
        expect(titles(gt)).toEqual([]);

        const gte = metadataQuery(db, { filters: [ { key: 'due', op: 'gte', value: '2026-01-01' } ] });
        expect(titles(gte)).toEqual([ 'A' ]);
    });

    it('does not canonicalize a plain numeric literal', () => {
        const db = makeTestDb();
        insertNoteWithMetadata(db, 'A.md', { priority: 5 });

        const results = metadataQuery(db, { filters: [ { key: 'priority', op: 'gt', value: 3 } ] });
        expect(titles(results)).toEqual([ 'A' ]);
    });
});

describe('metadataQuery: tag interception', () => {
    it('matches notes by tag, including a nested child, without touching metadata_json', () => {
        const db = makeTestDb();
        const noteA = insertNoteWithMetadata(db, 'A.md', {});
        const noteB = insertNoteWithMetadata(db, 'B.md', {});
        const noteC = insertNoteWithMetadata(db, 'C.md', {});
        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'project/api-migration' ]);
        syncNoteTags(db, noteC, [ 'other' ]);

        const results = metadataQuery(db, { filters: [ { key: 'tags', op: 'eq', value: 'project' } ] });
        expect(titles(results)).toEqual([ 'A', 'B' ]);
    });

    it('combines a tag condition with a metadata_json condition under match: all', () => {
        const db = makeTestDb();
        const noteA = insertNoteWithMetadata(db, 'A.md', { status: 'active' });
        const noteB = insertNoteWithMetadata(db, 'B.md', { status: 'active' });
        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'other' ]);

        const results = metadataQuery(db, {
            filters: [
                { key: 'tags', op: 'eq', value: 'project' },
                { key: 'status', op: 'eq', value: 'active' },
            ],
        });
        expect(titles(results)).toEqual([ 'A' ]);
    });

    it('negate on a tag condition matches notes that do not carry the tag (or a nested child)', () => {
        const db = makeTestDb();
        const noteA = insertNoteWithMetadata(db, 'A.md', {});
        const noteB = insertNoteWithMetadata(db, 'B.md', {});
        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'other' ]);

        const results = metadataQuery(db, {
            filters: [ { key: 'tags', op: 'eq', value: 'project', negate: true } ],
        });
        expect(titles(results)).toEqual([ 'B' ]);
    });

    it('rejects an ordering op against tags', () => {
        const db = makeTestDb();
        expect(() => metadataQuery(db, { filters: [ { key: 'tags', op: 'gt', value: 'a' } ] }))
            .toThrow(/not valid for key "tags"/);
    });

    it('rejects dot-path nesting under tags', () => {
        const db = makeTestDb();
        expect(() => metadataQuery(db, { filters: [ { key: 'tags.foo', op: 'eq', value: 'a' } ] }))
            .toThrow(/does not support dot-path nesting/);
    });
});

describe('metadataQuery: validation', () => {
    it('rejects an empty filters array', () => {
        const db = makeTestDb();
        expect(() => metadataQuery(db, { filters: [] })).toThrow(/non-empty array/);
    });

    it('rejects an invalid match value', () => {
        const db = makeTestDb();
        expect(() => metadataQuery(db, {
            match: 'bogus', filters: [ { key: 'status', op: 'eq', value: 'active' } ],
        })).toThrow(/"all" or "any"/);
    });
});
