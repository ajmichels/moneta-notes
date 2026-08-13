import { AutoTokenizer } from '@huggingface/transformers';

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

export const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';

export async function loadTokenizer(modelId = DEFAULT_MODEL_ID) {
    return AutoTokenizer.from_pretrained(modelId);
}

// @huggingface/transformers has no `return_offsets_mapping` option (unlike Python's HF
// tokenizers) — Qwen3's tokenizer is byte-level BPE (GPT-2 style), so each token's visible
// characters map 1:1 to raw bytes via the standard bytes-to-unicode table. Decoding the token
// stream back to UTF-8 bytes and re-decoding incrementally recovers exact character offsets
// into the original text without needing library-internal APIs.
const UNICODE_TO_BYTE = buildUnicodeToByteMap();

function buildUnicodeToByteMap() {
    const bytes = [];
    for (let i = 33; i <= 126; i += 1) bytes.push(i);
    for (let i = 161; i <= 172; i += 1) bytes.push(i);
    for (let i = 174; i <= 255; i += 1) bytes.push(i);

    const codePoints = bytes.slice();
    let extra = 0;
    for (let byte = 0; byte < 256; byte += 1) {
        if (!bytes.includes(byte)) {
            bytes.push(byte);
            codePoints.push(256 + extra);
            extra += 1;
        }
    }

    const map = new Map();
    for (let i = 0; i < bytes.length; i += 1) {
        map.set(String.fromCharCode(codePoints[i]), bytes[i]);
    }
    return map;
}

function tokenToBytes(token) {
    return Uint8Array.from([ ...token ].map((char) => UNICODE_TO_BYTE.get(char)));
}

export function tokenizeWithOffsets(tokenizer, text) {
    const tokens = tokenizer.tokenize(text);
    const decoder = new TextDecoder('utf-8');
    let cursor = 0;
    const spans = [];

    for (const token of tokens) {
        const piece = decoder.decode(tokenToBytes(token), { stream: true });
        if (piece.length > 0) {
            spans.push({ start: cursor, end: cursor + piece.length });
            cursor += piece.length;
        }
    }

    return spans;
}
