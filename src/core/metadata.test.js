import { describe, it, expect } from 'vitest';
import { buildMetadataJson } from './metadata.js';

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
