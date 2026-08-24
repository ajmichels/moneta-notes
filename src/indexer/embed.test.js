import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { getLogger, runWithLogger } from '../logger.js';
import {
    chunkText, loadTokenizer, tokenizeWithOffsets, createEmbedder, embed, embedQuery,
    buildQueryPrompt, buildChunkPrompt, defaultPipelineFactory, embedQueryOverSocket,
} from './embed.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

function fakePipelineFactory() {
    let calls = 0;
    async function factory() {
        calls += 1;
        return async (text) => new Float32Array(1024).fill(text.length);
    }
    factory.calls = () => calls;
    return factory;
}

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
            { chunkIndex: 0, charStart: 0, charEnd: body.length, lineStart: 1, lineEnd: 1, tokenCount: 5 },
        ]);
    });

    it('returns one chunk when token count exactly equals chunkSize', () => {
        const body = Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ');
        const tokens = fakeTokenizeWithOffsets(body);

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        expect(chunks).toEqual([
            {
                chunkIndex: 0, charStart: tokens[0].start, charEnd: tokens[9].end,
                lineStart: 1, lineEnd: 1, tokenCount: 10,
            },
        ]);
    });

    it('returns one chunk spanning multiple lines, lineEnd matching the last line', () => {
        const body = 'the quick brown\nfox jumps over\nthe lazy dog';

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        expect(chunks).toEqual([
            { chunkIndex: 0, charStart: 0, charEnd: body.length, lineStart: 1, lineEnd: 3, tokenCount: 9 },
        ]);
    });

    it('returns an empty array for an empty body', () => {
        expect(chunkText('', fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 })).toEqual([]);
    });
});

describe('chunkText: long body (sliding window with overlap)', () => {
    it('produces overlapping chunks with a shorter final chunk for the remainder', () => {
        const body = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ');
        const tokens = fakeTokenizeWithOffsets(body);

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        expect(chunks.map((c) => c.chunkIndex)).toEqual([ 0, 1, 2, 3 ]);
        expect(chunks.map((c) => c.tokenCount)).toEqual([ 10, 10, 10, 4 ]);
        expect(chunks[0]).toEqual({
            chunkIndex: 0, charStart: tokens[0].start, charEnd: tokens[9].end,
            lineStart: 1, lineEnd: 1, tokenCount: 10,
        });
        expect(chunks[1]).toEqual({
            chunkIndex: 1, charStart: tokens[7].start, charEnd: tokens[16].end,
            lineStart: 1, lineEnd: 1, tokenCount: 10,
        });
        expect(chunks[3]).toEqual({
            chunkIndex: 3, charStart: tokens[21].start, charEnd: tokens[24].end,
            lineStart: 1, lineEnd: 1, tokenCount: 4,
        });
    });

    it('never produces a chunk with zero tokens', () => {
        const body = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        for (const chunk of chunks) {
            expect(chunk.tokenCount).toBeGreaterThan(0);
        }
    });

    it('assigns each chunk its correct line span across a multi-line body', () => {
        const words = Array.from({ length: 25 }, (_, i) => `w${i}`);
        const lines = Array.from({ length: 5 }, (_, i) => words.slice(i * 5, i * 5 + 5).join(' '));
        const body = lines.join('\n');
        const tokens = fakeTokenizeWithOffsets(body);

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        // tokens 0-4 on line 1, 5-9 on line 2, 10-14 on line 3, 15-19 on line 4, 20-24 on line 5.
        expect(chunks[0]).toEqual({
            chunkIndex: 0, charStart: tokens[0].start, charEnd: tokens[9].end,
            lineStart: 1, lineEnd: 2, tokenCount: 10,
        });
        expect(chunks[1]).toEqual({
            chunkIndex: 1, charStart: tokens[7].start, charEnd: tokens[16].end,
            lineStart: 2, lineEnd: 4, tokenCount: 10,
        });
        // Chunk 2's charStart (token 14, line 3) falls *before* chunk 1's charEnd (token 16, line
        // 4) due to overlap — regression check for a line-finder cursor that doesn't rewind
        // between chunks and would otherwise carry chunk 1's line-4 position into this lookup.
        expect(chunks[2]).toEqual({
            chunkIndex: 2, charStart: tokens[14].start, charEnd: tokens[23].end,
            lineStart: 3, lineEnd: 5, tokenCount: 10,
        });
        expect(chunks[3]).toEqual({
            chunkIndex: 3, charStart: tokens[21].start, charEnd: tokens[24].end,
            lineStart: 5, lineEnd: 5, tokenCount: 4,
        });
    });

    it('assigns the line containing the character immediately before a newline chunk boundary', () => {
        // Each line is exactly one token, so chunk boundaries land right at line boundaries.
        const body = 'w0\nw1\nw2\nw3';
        const tokens = fakeTokenizeWithOffsets(body);

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 2, overlapTokens: 0 });

        expect(chunks).toEqual([
            {
                chunkIndex: 0, charStart: tokens[0].start, charEnd: tokens[1].end,
                lineStart: 1, lineEnd: 2, tokenCount: 2,
            },
            {
                chunkIndex: 1, charStart: tokens[2].start, charEnd: tokens[3].end,
                lineStart: 3, lineEnd: 4, tokenCount: 2,
            },
        ]);
    });
});

describe('tokenizeWithOffsets: real Qwen3 tokenizer (slow, network on first run)', () => {
    it('produces char-offset token spans that round-trip against the source text', async () => {
        const tokenizer = await loadTokenizer();
        const text = 'The quick brown fox jumps over the lazy dog.';

        const tokens = tokenizeWithOffsets(tokenizer, text);

        expect(tokens.length).toBeGreaterThan(0);
        for (const { start, end } of tokens) {
            expect(end).toBeGreaterThan(start);
            expect(text.slice(start, end).length).toBeGreaterThan(0);
        }
        expect(tokens[0].start).toBeGreaterThanOrEqual(0);
        expect(tokens[tokens.length - 1].end).toBeLessThanOrEqual(text.length);
    }, 120000);

    it('round-trips offsets for text with unicode, tabs, newlines, and double spaces', async () => {
        const tokenizer = await loadTokenizer();
        const text = 'Hello, world!\n\nThis has  double  spaces, a tab\t, unicode: café \u{1F389}, and\nnewlines.';

        const tokens = tokenizeWithOffsets(tokenizer, text);

        for (const { start, end } of tokens) {
            expect(text.slice(start, end).length).toBeGreaterThan(0);
        }
        expect(tokens[tokens.length - 1].end).toBe(text.length);
    }, 120000);
});

describe('createEmbedder: lazy load', () => {
    it('does not create the pipeline until the first embed() call', () => {
        const factory = fakePipelineFactory();
        createEmbedder({ pipelineFactory: factory });

        expect(factory.calls()).toBe(0);
    });

    it('loads once and reuses the pipeline across multiple embed() calls', async () => {
        const factory = fakePipelineFactory();
        const embedder = createEmbedder({ pipelineFactory: factory });

        const first = await embedder.embed('hello');
        const second = await embedder.embed('world');

        expect(factory.calls()).toBe(1);
        expect(embedder.isLoaded()).toBe(true);
        expect(first).toBeInstanceOf(Float32Array);
        expect(second).toBeInstanceOf(Float32Array);
    });

    it('unload() drops the pipeline, forcing a reload on next embed()', async () => {
        const factory = fakePipelineFactory();
        const embedder = createEmbedder({ pipelineFactory: factory });
        await embedder.embed('hello');

        embedder.unload();

        expect(embedder.isLoaded()).toBe(false);
        await embedder.embed('again');
        expect(factory.calls()).toBe(2);
    });

    it('logs an info line via the context logger when the pipeline first loads', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-embed-test-log-'));
        const logger = getLogger('indexer', logDir);
        const factory = fakePipelineFactory();
        const embedder = createEmbedder({ pipelineFactory: factory, dtype: 'q8' });

        await runWithLogger(logger, () => embedder.embed('hello'));

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
            expect(line).toContain('INFO  [indexer] embedding pipeline loaded');
            expect(line).toContain('dtype="q8"');
        });
        await cleanupTempDir(logDir);
    });
});

describe('createEmbedder: idle unload', () => {
    it('unloads after idleTimeoutMs of inactivity and reloads transparently on next use', async () => {
        const factory = fakePipelineFactory();
        let scheduled = null;
        const embedder = createEmbedder({
            pipelineFactory: factory,
            idleTimeoutMs: 1000,
            scheduleUnload: (fn, ms) => { scheduled = { fn, ms }; return 'timer'; },
            cancelUnload: () => {},
        });

        await embedder.embed('hello');
        expect(embedder.isLoaded()).toBe(true);
        expect(scheduled.ms).toBe(1000);

        scheduled.fn(); // simulate the idle timer firing
        expect(embedder.isLoaded()).toBe(false);

        await embedder.embed('world again');
        expect(factory.calls()).toBe(2);
    });

    it('cancels the previous idle timer on every embed() call', async () => {
        const factory = fakePipelineFactory();
        const cancelled = [];
        let timerCount = 0;
        const embedder = createEmbedder({
            pipelineFactory: factory,
            scheduleUnload: () => { timerCount += 1; return `timer-${timerCount}`; },
            cancelUnload: (id) => cancelled.push(id),
        });

        await embedder.embed('a');
        await embedder.embed('b');

        expect(cancelled).toEqual([ 'timer-1' ]);
    });
});

describe('defaultPipelineFactory: pooling and normalization', () => {
    it('invokes the extractor with last_token pooling and normalize enabled', async () => {
        const output = { data: Float32Array.from([ 0.1, 0.2, 0.3 ]) };
        const extractor = vi.fn().mockResolvedValue(output);
        const pipelineMock = vi.fn().mockResolvedValue(extractor);

        vi.resetModules();
        vi.doMock('@huggingface/transformers', async (importOriginal) => {
            const actual = await importOriginal();
            return { ...actual, pipeline: pipelineMock };
        });

        try {
            const { defaultPipelineFactory: isolatedFactory } = await import('./embed.js');
            const embedFn = await isolatedFactory('some-model-id', { dtype: 'q8' });
            const vector = await embedFn('hello world');

            expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'some-model-id', { dtype: 'q8' });
            expect(extractor).toHaveBeenCalledWith('hello world', { pooling: 'last_token', normalize: true });
            expect(vector).toEqual(Float32Array.from([ 0.1, 0.2, 0.3 ]));
        } finally {
            vi.doUnmock('@huggingface/transformers');
            vi.resetModules();
        }
    });

    it('is the pipeline factory actually used by the shared embedder', () => {
        expect(typeof defaultPipelineFactory).toBe('function');
    });
});

describe('buildQueryPrompt', () => {
    it('wraps query text in the Qwen3 "Instruct: ...\\nQuery: ..." format', () => {
        expect(buildQueryPrompt('book recommendations')).toBe(
            'Instruct: Given a query, retrieve relevant notes from a notes vault that answer or '
            + 'relate to the query\nQuery: book recommendations',
        );
    });
});

describe('buildChunkPrompt', () => {
    it('prepends the note title, blank-line separated, ahead of the chunk body', () => {
        expect(buildChunkPrompt('Weekly Notes/2026-W32', 'Shipped the reindex fix.')).toBe(
            'Weekly Notes/2026-W32\n\nShipped the reindex fix.',
        );
    });
});

describe('embed: real pipeline (slow, network on first run)', () => {
    it('returns a normalized 1024-dim Float32Array for real text', async () => {
        const vector = await embed('hello world');

        expect(vector).toBeInstanceOf(Float32Array);
        expect(vector.length).toBe(1024);
    }, 120000);
});

describe('embedQuery: real pipeline (slow, network on first run)', () => {
    it('embeds the instruction-prefixed query text, distinct from a plain embed() of the same text', async () => {
        const queryVector = await embedQuery('hello world');
        const docVector = await embed('hello world');

        expect(queryVector).toBeInstanceOf(Float32Array);
        expect(queryVector.length).toBe(1024);
        expect(queryVector).not.toEqual(docVector);
    }, 120000);
});

describe('embedQueryOverSocket', () => {
    function makeSocketPath() {
        return join(mkdtempSync(join(tmpdir(), 'mnotes-embed-socket-test-')), 'daemon.sock');
    }

    function fakeDaemon(socketPath, respond) {
        const server = createServer((socket) => {
            let buffer = '';
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) {
                    return;
                }
                const request = JSON.parse(buffer.slice(0, newlineIndex));
                socket.end(`${JSON.stringify(respond(request))}\n`);
            });
        });
        return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
    }

    it('resolves a Float32Array from the daemon\'s { vector } response', async () => {
        const socketPath = makeSocketPath();
        const server = await fakeDaemon(socketPath, (request) => {
            expect(request).toEqual({ action: 'embed', text: 'hello world' });
            return { vector: [ 0.1, 0.2, 0.3 ] };
        });

        const vector = await embedQueryOverSocket(socketPath, 'hello world');

        expect(vector).toBeInstanceOf(Float32Array);
        expect(Array.from(vector)).toEqual([
            Math.fround(0.1), Math.fround(0.2), Math.fround(0.3),
        ]);
        server.close();
    });

    it('rejects with an actionable error when nothing is listening on the socket', async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), 'mnotes-embed-socket-test-')), 'nobody.sock');

        await expect(embedQueryOverSocket(socketPath, 'hello')).rejects.toThrow(
            /could not connect to the daemon/,
        );
    });

    it('rejects with the daemon\'s error message on a { error } response', async () => {
        const socketPath = makeSocketPath();
        const server = await fakeDaemon(socketPath, () => ({ error: 'model failed to load' }));

        await expect(embedQueryOverSocket(socketPath, 'hello')).rejects.toThrow(/model failed to load/);
        server.close();
    });
});
