import { describe, it, expect } from 'vitest';
import { formatJson, formatTable } from './format.js';

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
