import { describe, it, expect } from 'vitest';
import {
    formatJson, formatJsonPretty, formatTable, formatSearchTable, formatExplain, formatGrepTable,
    formatTagListTable, formatTagNotesTable, formatLinksTable, formatBrokenLinksTable, formatStats,
} from './format.js';

describe('formatJson', () => {
    it('serializes data as compact JSON with a trailing newline', () => {
        expect(formatJson({ a: 1 })).toBe('{"a":1}\n');
    });

    it('serializes an array', () => {
        expect(formatJson([ 1, 2 ])).toBe('[1,2]\n');
    });
});

describe('formatJsonPretty', () => {
    it('serializes data as indented JSON with a trailing blank line', () => {
        expect(formatJsonPretty({ a: 1, b: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}\n\n');
    });
});

describe('formatTable', () => {
    it('renders a header row and one row per item, pipe-delimited, with a trailing newline', () => {
        const text = formatTable(
            [ 'a', 'b' ],
            [ { a: 1, b: 2 }, { a: 3, b: 4 } ],
        );

        expect(text).toBe('a|b\n1|2\n3|4\n');
    });

    it('renders a missing/null cell as an empty string, not "null" or "undefined"', () => {
        const text = formatTable([ 'a', 'b' ], [ { a: 1, b: null } ]);

        expect(text).toBe('a|b\n1|\n');
    });

    it('renders just the header row for an empty result set', () => {
        expect(formatTable([ 'a', 'b' ], [])).toBe('a|b\n');
    });

    describe('align: true', () => {
        it('pads each column to its widest cell (header included) and separates with " | "', () => {
            const text = formatTable(
                [ 'note_title', 'file_line_count' ],
                [ { note_title: 'Recipe', file_line_count: 5 }, { note_title: 'A', file_line_count: 120 } ],
                { align: true },
            );

            expect(text).toBe(
                'note_title | file_line_count\n'
                + '---------- | ---------------\n'
                + 'Recipe     | 5\n'
                + 'A          | 120\n',
            );
        });

        it('renders a hyphen-filled separator row under the header, sized to each column', () => {
            const text = formatTable([ 'a', 'bbbb' ], [ { a: 1, b: null } ], { align: true });
            expect(text).toBe('a | bbbb\n- | ----\n1 |\n');
        });

        it('renders the header and a separator row for an empty result set', () => {
            expect(formatTable([ 'a', 'b' ], [], { align: true })).toBe('a | b\n- | -\n');
        });
    });
});

describe('formatSearchTable', () => {
    it('omits rank columns for a non-hybrid mode, includes bm25_score for fulltext', () => {
        const text = formatSearchTable(
            [ { note_title: 'A', file_line_count: 5, bm25_score: -1.5 } ],
            'fulltext',
        );

        expect(text).toBe('note_title|file_line_count|bm25_score\nA|5|-1.5\n');
    });

    it('includes fulltext_rank/semantic_rank/chunk_line columns for hybrid mode, even with null values', () => {
        const text = formatSearchTable(
            [ {
                note_title: 'A', file_line_count: 5, fulltext_rank: 1, semantic_rank: null,
                chunk_line_start: null, chunk_line_end: null,
            } ],
            'hybrid',
        );

        expect(text).toBe(
            'note_title|file_line_count|fulltext_rank|semantic_rank|chunk_line_start|chunk_line_end\nA|5|1|||\n',
        );
    });

    it('includes chunk_line_start/chunk_line_end/cosine_distance columns for semantic mode', () => {
        const text = formatSearchTable(
            [ {
                note_title: 'A', file_line_count: 5, chunk_line_start: 12, chunk_line_end: 18,
                cosine_distance: 0.42,
            } ],
            'semantic',
        );

        expect(text).toBe(
            'note_title|file_line_count|chunk_line_start|chunk_line_end|cosine_distance\nA|5|12|18|0.42\n',
        );
    });

    it('aligns columns when align is true', () => {
        const text = formatSearchTable(
            [ { note_title: 'A', file_line_count: 5, bm25_score: -1.5 } ],
            'fulltext',
            { align: true },
        );

        expect(text).toBe(
            'note_title | file_line_count | bm25_score\n'
            + '---------- | --------------- | ----------\n'
            + 'A          | 5               | -1.5\n',
        );
    });
});

describe('formatExplain', () => {
    it('renders pipeline info, a column header row, and a bm25 row for fulltext mode', () => {
        const text = formatExplain({
            results: [ { note_title: 'A', file_line_count: 10, bm25_score: -1.2, rank: 1 } ],
            pipeline: { mode: 'fulltext', limit: 20, overfetchLimit: 100, fulltextExpression: 'graph' },
        });
        expect(text).toContain('mode=fulltext limit=20 overfetch=100 fts5_expression="graph"');
        expect(text).toContain('rank | note_title | file_line_count | bm25');
        expect(text).toContain('---- | ---------- | --------------- | ----');
        expect(text).toContain('1    | A          | 10              | -1.2');
    });

    it('renders a cosine + chunk-window row (line span and char offsets) for semantic mode', () => {
        const text = formatExplain({
            results: [ {
                note_title: 'A', file_line_count: 10, cosine_distance: 0.01,
                winning_chunk: { char_start: 0, char_end: 100, line_start: 1, line_end: 5 }, rank: 1,
            } ],
            pipeline: { mode: 'semantic', limit: 20, overfetchLimit: 100, fulltextExpression: 'x' },
        });
        expect(text).toContain('rank | note_title | file_line_count | cosine | chunk');
        expect(text).toContain('1    | A          | 10              | 0.01   | L1-5 [0:100]');
    });

    it('renders the rrf formula for hybrid mode', () => {
        const text = formatExplain({
            results: [ {
                note_title: 'A', file_line_count: 10, fulltext_rank: 1, semantic_rank: null,
                rrf_score: 0.0164, rrf_formula: '1/(60+1) = 0.0164',
            } ],
            pipeline: { mode: 'hybrid', limit: 20, overfetchLimit: 100, fulltextExpression: 'x' },
        });
        expect(text).toContain('rank | note_title | file_line_count | fulltext_rank | semantic_rank | rrf');
        expect(text).toContain('---- | ---------- | --------------- | ------------- | ------------- | -----------------');
        expect(text).toContain('1    | A          | 10              | 1             | -             | 1/(60+1) = 0.0164');
    });
});

describe('formatGrepTable', () => {
    it('renders line_matches as line numbers only by default (no match text)', () => {
        const text = formatGrepTable([
            {
                noteTitle: 'Recipe',
                fileLineCount: 10,
                lineMatches: [ { line: 2, text: 'hello world' }, { line: 5, text: 'hello again' } ],
                totalMatchCount: 2,
            },
        ]);

        expect(text).toBe('note_title|file_line_count|line_matches\nRecipe|10|L2, L5\n');
    });

    it('renders line_matches as "L<line>: <text>" joined by "; " when includeText is true', () => {
        const text = formatGrepTable([
            {
                noteTitle: 'Recipe',
                fileLineCount: 10,
                lineMatches: [ { line: 2, text: 'hello world' }, { line: 5, text: 'hello again' } ],
                totalMatchCount: 2,
            },
        ], { includeText: true });

        expect(text).toBe('note_title|file_line_count|line_matches\nRecipe|10|L2: hello world; L5: hello again\n');
    });

    it('appends "(+N more)" when totalMatchCount exceeds the capped lineMatches length', () => {
        const text = formatGrepTable([
            {
                noteTitle: 'Big',
                fileLineCount: 100,
                lineMatches: [ { line: 1, text: 'x' } ],
                totalMatchCount: 12,
            },
        ]);

        expect(text).toBe('note_title|file_line_count|line_matches\nBig|100|L1 (+11 more)\n');
    });

    it('aligns columns when align is true', () => {
        const text = formatGrepTable([
            { noteTitle: 'Recipe', fileLineCount: 10, lineMatches: [ { line: 2, text: 'x' } ], totalMatchCount: 1 },
        ], { align: true });

        expect(text).toBe(
            'note_title | file_line_count | line_matches\n'
            + '---------- | --------------- | ------------\n'
            + 'Recipe     | 10              | L2\n',
        );
    });
});

describe('formatTagListTable', () => {
    it('maps tag/notesWithTag to tag/notes_with_tag', () => {
        const text = formatTagListTable([ { tag: 'project', notesWithTag: 3 } ]);
        expect(text).toBe('tag|notes_with_tag\nproject|3\n');
    });
});

describe('formatTagNotesTable', () => {
    it('maps noteTitle/fileLineCount to note_title/file_line_count', () => {
        const text = formatTagNotesTable([ { noteTitle: 'A', fileLineCount: 5 } ]);
        expect(text).toBe('note_title|file_line_count\nA|5\n');
    });
});

describe('formatLinksTable', () => {
    it('renders backlinks then links_out, one row per link', () => {
        const text = formatLinksTable({ backlinks: [ 'A' ], links_out: [ 'B', 'C' ] });
        expect(text).toBe('direction|note_title\nbacklink|A\nlink_out|B\nlink_out|C\n');
    });

    it('renders just the header row when there are no links either direction', () => {
        expect(formatLinksTable({ backlinks: [], links_out: [] })).toBe('direction|note_title\n');
    });
});

describe('formatBrokenLinksTable', () => {
    it('maps sourceTitle/targetTitle to note_title/broken_target', () => {
        const text = formatBrokenLinksTable([ { sourceTitle: 'A', targetTitle: 'Missing' } ]);
        expect(text).toBe('note_title|broken_target\nA|Missing\n');
    });
});

describe('formatStats', () => {
    it('renders key: value lines including daemon status', () => {
        const text = formatStats({ note_count: 3 }, { daemonRunning: true });
        expect(text).toContain('note_count: 3');
        expect(text).toContain('daemon_running: true');
    });

    it('returns JSON when json is true', () => {
        const text = formatStats({ note_count: 3 }, { json: true, daemonRunning: false });
        expect(JSON.parse(text)).toEqual({ note_count: 3, daemon_running: false });
    });
});
