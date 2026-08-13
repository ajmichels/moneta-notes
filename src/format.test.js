import { describe, it, expect } from 'vitest';
import {
    formatJson, formatTable, formatSearchTable, formatExplain, formatGrepTable,
    formatTagListTable, formatTagNotesTable, formatStats,
} from './format.js';

describe('formatJson', () => {
    it('serializes data as compact JSON, no whitespace, no trailing newline', () => {
        expect(formatJson({ a: 1 })).toBe('{"a":1}');
    });

    it('serializes an array', () => {
        expect(formatJson([ 1, 2 ])).toBe('[1,2]');
    });
});

describe('formatTable', () => {
    it('renders a header row and one row per item, pipe-delimited', () => {
        const text = formatTable(
            [ 'a', 'b' ],
            [ { a: 1, b: 2 }, { a: 3, b: 4 } ],
        );

        expect(text).toBe('a|b\n1|2\n3|4');
    });

    it('renders a missing/null cell as an empty string, not "null" or "undefined"', () => {
        const text = formatTable([ 'a', 'b' ], [ { a: 1, b: null } ]);

        expect(text).toBe('a|b\n1|');
    });

    it('renders just the header row for an empty result set', () => {
        expect(formatTable([ 'a', 'b' ], [])).toBe('a|b');
    });
});

describe('formatSearchTable', () => {
    it('omits rank columns for a non-hybrid mode', () => {
        const text = formatSearchTable(
            [ { note_title: 'A', file_line_count: 5 } ],
            'fulltext',
        );

        expect(text).toBe('note_title|file_line_count\nA|5');
    });

    it('includes fulltext_rank/semantic_rank columns for hybrid mode, even with a null rank', () => {
        const text = formatSearchTable(
            [ { note_title: 'A', file_line_count: 5, fulltext_rank: 1, semantic_rank: null } ],
            'hybrid',
        );

        expect(text).toBe('note_title|file_line_count|fulltext_rank|semantic_rank\nA|5|1|');
    });
});

describe('formatExplain', () => {
    it('renders pipeline info and a bm25 line for fulltext mode', () => {
        const text = formatExplain({
            results: [ { note_title: 'A', file_line_count: 10, bm25_score: -1.2, rank: 1 } ],
            pipeline: { mode: 'fulltext', limit: 20, overfetchLimit: 100, fulltextExpression: 'graph' },
        });
        expect(text).toContain('mode=fulltext limit=20 overfetch=100 fts5_expression="graph"');
        expect(text).toContain('1 | A | 10 | bm25=-1.2');
    });

    it('renders a cosine + chunk-window line for semantic mode', () => {
        const text = formatExplain({
            results: [ {
                note_title: 'A', file_line_count: 10, cosine_distance: 0.01,
                winning_chunk: { char_start: 0, char_end: 100 }, rank: 1,
            } ],
            pipeline: { mode: 'semantic', limit: 20, overfetchLimit: 100, fulltextExpression: 'x' },
        });
        expect(text).toContain('1 | A | 10 | cosine=0.01 | chunk[0:100]');
    });

    it('renders the rrf formula for hybrid mode', () => {
        const text = formatExplain({
            results: [ {
                note_title: 'A', file_line_count: 10, fulltext_rank: 1, semantic_rank: null,
                rrf_score: 0.0164, rrf_formula: '1/(60+1) = 0.0164',
            } ],
            pipeline: { mode: 'hybrid', limit: 20, overfetchLimit: 100, fulltextExpression: 'x' },
        });
        expect(text).toContain('1 | A | 10 | fulltext_rank=1 | semantic_rank=- | rrf=1/(60+1) = 0.0164');
    });
});

describe('formatGrepTable', () => {
    it('renders line_matches as "L<line>: <text>" joined by "; "', () => {
        const text = formatGrepTable([
            {
                noteTitle: 'Recipe',
                fileLineCount: 10,
                lineMatches: [ { line: 2, text: 'hello world' }, { line: 5, text: 'hello again' } ],
                totalMatchCount: 2,
            },
        ]);

        expect(text).toBe('note_title|file_line_count|line_matches\nRecipe|10|L2: hello world; L5: hello again');
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

        expect(text).toBe('note_title|file_line_count|line_matches\nBig|100|L1: x (+11 more)');
    });
});

describe('formatTagListTable', () => {
    it('maps tag/notesWithTag to tag/notes_with_tag', () => {
        const text = formatTagListTable([ { tag: 'project', notesWithTag: 3 } ]);
        expect(text).toBe('tag|notes_with_tag\nproject|3');
    });
});

describe('formatTagNotesTable', () => {
    it('maps noteTitle/fileLineCount to note_title/file_line_count', () => {
        const text = formatTagNotesTable([ { noteTitle: 'A', fileLineCount: 5 } ]);
        expect(text).toBe('note_title|file_line_count\nA|5');
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
