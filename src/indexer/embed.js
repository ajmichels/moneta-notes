import { createConnection } from 'node:net';
import { AutoTokenizer, pipeline } from '@huggingface/transformers';
import { getContextLogger } from '../logger.js';

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP_TOKENS = 77;

// Finds the 1-indexed line number containing `charOffset`, given `newlineOffsets` (the char index
// of every '\n' in the body, ascending) and a forward-only cursor into that list. Only safe to call
// with a non-decreasing sequence of `charOffset`s — the cursor never rewinds. `chunkText` below
// satisfies this with two separate finders (one fed only chunks' charStart, one only charEnd):
// windowStart, and therefore windowEnd, both increase monotonically chunk-to-chunk (the sliding
// window's overlap only makes a *later* chunk's charStart fall before an *earlier* chunk's charEnd
// — a single finder fed both interleaved would see a decreasing sequence and undercount).
function makeLineFinder(newlineOffsets) {
    let cursor = 0;
    return (charOffset) => {
        while (cursor < newlineOffsets.length && newlineOffsets[cursor] < charOffset) {
            cursor += 1;
        }
        return cursor + 1;
    };
}

export function chunkText(body, tokenizeWithOffsets, options = {}) {
    const { chunkSize = DEFAULT_CHUNK_SIZE, overlapTokens = DEFAULT_OVERLAP_TOKENS } = options;
    const tokens = tokenizeWithOffsets(body);

    if (tokens.length === 0) {
        return [];
    }

    const newlineOffsets = [ ...body.matchAll(/\n/g) ].map((m) => m.index);
    const lineAtStart = makeLineFinder(newlineOffsets);
    const lineAtEnd = makeLineFinder(newlineOffsets);

    const chunks = [];
    const step = chunkSize - overlapTokens;
    let windowStart = 0;
    let chunkIndex = 0;

    while (windowStart < tokens.length) {
        const windowEnd = Math.min(windowStart + chunkSize, tokens.length);
        const charStart = tokens[windowStart].start;
        const charEnd = tokens[windowEnd - 1].end;
        chunks.push({
            chunkIndex,
            charStart,
            charEnd,
            lineStart: lineAtStart(charStart),
            lineEnd: lineAtEnd(charEnd - 1),
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

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DTYPE = 'q8';

export function createEmbedder(options = {}) {
    const {
        modelId = DEFAULT_MODEL_ID,
        dtype = DEFAULT_DTYPE,
        idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
        pipelineFactory,
        scheduleUnload = setTimeout,
        cancelUnload = clearTimeout,
    } = options;

    let extractor = null;
    let unloadTimer = null;

    async function ensureLoaded() {
        if (extractor === null) {
            extractor = await pipelineFactory(modelId, { dtype });
            getContextLogger().info('embedding pipeline loaded', { dtype });
        }
        return extractor;
    }

    function resetIdleTimer() {
        if (unloadTimer !== null) {
            cancelUnload(unloadTimer);
        }
        unloadTimer = scheduleUnload(() => {
            extractor = null;
            unloadTimer = null;
            getContextLogger().info('embedding pipeline unloaded', { idle_minutes: idleTimeoutMs / (60 * 1000) });
        }, idleTimeoutMs);
        // Don't let this timer alone keep a short-lived process (e.g. the CLI) alive for up to
        // idleTimeoutMs after it would otherwise have exited. Guarded because test doubles for
        // scheduleUnload return plain values without a real Timer's .unref().
        if (typeof unloadTimer?.unref === 'function') {
            unloadTimer.unref();
        }
    }

    async function embed(text) {
        const fn = await ensureLoaded();
        resetIdleTimer();
        return fn(text);
    }

    function isLoaded() {
        return extractor !== null;
    }

    function unload() {
        if (unloadTimer !== null) {
            cancelUnload(unloadTimer);
            unloadTimer = null;
        }
        extractor = null;
    }

    return { embed, isLoaded, unload };
}

// Qwen3-Embedding is a causal decoder-only model trained for last-token pooling, not mean pooling
// — under causal attention only the final token has attended to the whole input, so mean-pooling
// drags in under-contextualized early-token states (this was the S005 pooling bug: it collapsed
// short notes toward a generic embedding-space "hub" that scored artificially high against nearly
// any query).
export async function defaultPipelineFactory(modelId, { dtype }) {
    const extractor = await pipeline('feature-extraction', modelId, { dtype });
    return async (text) => {
        const output = await extractor(text, { pooling: 'last_token', normalize: true });
        return Float32Array.from(output.data);
    };
}

let sharedEmbedder = null;
let sharedEmbedderOptions = {};

// Entry points (daemon/cli/mcp `main()`s) call this once at startup with config.toml-backed
// dtype/idle-unload values before the first real `embed()` call — `getSharedEmbedder()` only
// reads `sharedEmbedderOptions` at lazy-creation time, so a call here after the singleton already
// exists has no effect (never happens in practice: every entry point configures before using).
export function configureEmbedder(options) {
    sharedEmbedderOptions = options;
}

export function getSharedEmbedder() {
    if (sharedEmbedder === null) {
        sharedEmbedder = createEmbedder({ ...sharedEmbedderOptions, pipelineFactory: defaultPipelineFactory });
    }
    return sharedEmbedder;
}

export async function embed(text) {
    return getSharedEmbedder().embed(text);
}

// Qwen3-Embedding's documented usage applies this instruction prefix on the query side only, never
// on the document/chunk side — it's how the model was trained to discriminate a search query from
// the passages it's being matched against (S005).
export const QUERY_INSTRUCTION = 'Given a query, retrieve relevant notes from a notes vault that '
    + 'answer or relate to the query';

export function buildQueryPrompt(text) {
    return `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${text}`;
}

export async function embedQuery(text) {
    return getSharedEmbedder().embed(buildQueryPrompt(text));
}

// CLI/MCP-side counterpart to embedQuery — instead of loading the pipeline in this process, asks
// the daemon (the only process that ever loads it, S005) to embed the query over its IPC socket.
// Request/response, not a stream: one `{ action: "embed", text }` line out, one `{ vector }` or
// `{ error }` line back, then the daemon closes the connection.
export function embedQueryOverSocket(socketPath, text) {
    return new Promise((resolve, reject) => {
        const client = createConnection(socketPath);
        let buffer = '';

        client.on('connect', () => {
            client.write(`${JSON.stringify({ action: 'embed', text })}\n`);
        });
        client.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
        });
        client.on('end', () => {
            const response = JSON.parse(buffer);
            if (response.error) {
                reject(new Error(`mnotes: embedding request failed: ${response.error}`));
                return;
            }
            resolve(Float32Array.from(response.vector));
        });
        client.on('error', (err) => {
            reject(new Error(
                `mnotes: could not connect to the daemon at "${socketPath}" to embed a query — is it `
                + `running? (${err.message})`,
                { cause: err },
            ));
        });
    });
}
