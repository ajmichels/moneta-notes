const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP_TOKENS = 77;

export function chunkText(body, tokenizeWithOffsets, options = {}) {
    const { chunkSize = DEFAULT_CHUNK_SIZE, overlapTokens = DEFAULT_OVERLAP_TOKENS } = options;
    const tokens = tokenizeWithOffsets(body);

    if (tokens.length === 0) {
        return [];
    }

    const chunks = [];
    const step = chunkSize - overlapTokens;
    let windowStart = 0;
    let chunkIndex = 0;

    while (windowStart < tokens.length) {
        const windowEnd = Math.min(windowStart + chunkSize, tokens.length);
        chunks.push({
            chunkIndex,
            charStart: tokens[windowStart].start,
            charEnd: tokens[windowEnd - 1].end,
            tokenCount: windowEnd - windowStart,
        });
        chunkIndex += 1;

        if (windowEnd >= tokens.length) {
            break;
        }
        windowStart += step;
    }

    return chunks;
}
