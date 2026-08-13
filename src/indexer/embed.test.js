import { describe, it, expect } from 'vitest';
import { chunkText } from './embed.js';

function fakeTokenizeWithOffsets(text) {
    const tokens = [];
    const pattern = /\S+/g;
    let match = pattern.exec(text);
    while (match !== null) {
        tokens.push({ start: match.index, end: match.index + match[0].length });
        match = pattern.exec(text);
    }
    return tokens;
}

describe('chunkText: short body (single chunk)', () => {
    it('returns one chunk spanning the whole body when token count is at or below chunkSize', () => {
        const body = 'the quick brown fox jumps';

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        expect(chunks).toEqual([
            { chunkIndex: 0, charStart: 0, charEnd: body.length, tokenCount: 5 },
        ]);
    });

    it('returns one chunk when token count exactly equals chunkSize', () => {
        const body = Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ');
        const tokens = fakeTokenizeWithOffsets(body);

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        expect(chunks).toEqual([
            { chunkIndex: 0, charStart: tokens[0].start, charEnd: tokens[9].end, tokenCount: 10 },
        ]);
    });

    it('returns an empty array for an empty body', () => {
        expect(chunkText('', fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 })).toEqual([]);
    });
});
