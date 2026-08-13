# S005 Indexing Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/indexer/embed.js` (token-based chunking + the `@huggingface/transformers`
embedding pipeline lifecycle) and `src/indexer/daemon.js` (fswatch-driven live indexing, the
SQLite-backed `index_queue` drainer with retry/backoff, startup catch-up, and the Unix-socket
CLI↔daemon IPC) per `docs/specs/S005-indexing-daemon.md`.

**Architecture:**

`src/indexer/embed.js` splits into two independently-testable halves:

- **Chunking** (`chunkText`) is a pure function over `(body, tokenizeWithOffsets, options)` — it never
  touches the model. `tokenizeWithOffsets(text) -> Array<{ start, end }>` is injected, mirroring
  `S002-search`'s `embed` injection pattern, so the sliding-window/overlap arithmetic is fully unit
  -testable with a cheap fake tokenizer (one token per whitespace-separated word) before the real
  Qwen3 tokenizer is wired in. `loadTokenizer`/`tokenizeWithOffsets` (real) adapt
  `@huggingface/transformers`'s `AutoTokenizer` to that same `{ start, end }` shape.
- **Embedding** (`createEmbedder`) wraps the `feature-extraction` pipeline's lazy-load/idle-unload
  lifecycle behind an injectable `pipelineFactory`, `scheduleUnload`/`cancelUnload`, exactly the same
  dependency-injection shape `S002-search` established for testing async, expensive external calls
  without mocking `@huggingface/transformers` itself. `getSharedEmbedder()`/`embed(text)` are the
  module-level singleton and convenience export `daemon.js` (and eventually `S006`'s CLI) actually
  call — this `embed(text) -> Promise<Float32Array(1024)>` signature is exactly what `S002-search`'s
  `search()` expects to receive as its injected `embed` option, closing that integration seam.

`src/indexer/daemon.js` is built bottom-up from small, directly-testable pieces before they're wired
into a long-running process:

- `enqueuePath`/`dequeueNextPath` — thin wrappers over `index_queue`'s dedupe-on-conflict and
  backoff-respecting ordering (S001).
- `processPath` — the single-file pipeline (skip-unchanged check, hash compare, chunk+embed, upsert
  `notes`/delete-reinsert `chunks`/`chunk_vectors`/`notes_fts`, tag sync). It reuses
  `core/notes.js`'s `noteRead` (S003) for hashing and frontmatter parsing and `core/tags.js`'s
  `extractTags`/`syncNoteTags` (S004) for tag bookkeeping — nothing here reimplements either.
  `processPath` is callable directly, with no daemon loop running, exactly per the task brief.
- `recordFailure` — retry/backoff bookkeeping against `index_queue.attempts`/`next_attempt_at`.
- `drainQueueOnce` — wires the above into one full pass over currently-eligible queue rows.
- `watermarkCatchup`/`existenceCheck` — the two startup-catch-up passes S005 specifies.
- `createDebouncer` — the unified per-path debounce timer, tested with an injected fake
  clock/scheduler rather than real 15-second waits.
- `assertFswatchAvailable`/`spawnFswatch` — real-binary wiring, same posture `S004-grep-tags` took
  toward `rg`: trust the system tool, give a clear error if it's missing, test against the real
  process for the one thing that matters (it detects a real file change).
- `runReindex` — the IPC-triggered reindex's business logic (enqueue, drain, stream per-path outcomes
  via a plain callback), deliberately socket-free so it's testable without opening a real connection.
- `createIpcServer` — the thin newline-delimited-JSON socket wrapper around `runReindex`, tested over a
  real Unix domain socket (an OS primitive available in the test sandbox, not a mock).
- `startDaemon` — ties every piece above into the full startup sequence, with the real `fswatch`
  spawn and real embedding pipeline swappable for fast injected fakes in its own test, since both are
  already covered by dedicated real-binary/real-model tests elsewhere in this plan.

**Tech Stack:** `@huggingface/transformers` (already a `package.json` dependency — `pipeline`/
`AutoTokenizer`), Node built-ins (`node:child_process`, `node:net`, `node:readline`, `node:fs`,
`node:path`), `src/logger.js` (S008, already planned) for daemon lifecycle/error logging, `core/db.js`
(S001), `core/notes.js` (S003), `core/tags.js` (S004), Vitest with real temp vault directories, real
temp-file SQLite DBs, real Unix sockets, and vitest's fake-timer utilities for debounce testing (never
`vi.mock()` against `child_process`, the DB, or the filesystem, per CLAUDE.md) — the embedding model
and the real `fswatch`/tokenizer calls get a small number of genuinely slow, real, cached-after-first
-run integration tests rather than being mocked away entirely, matching this project's "real, not
mocked" philosophy while keeping the bulk of the suite fast via injected fakes at the same seams
`S002-search` already established for `embed`.

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md).
- Test files colocated: `src/indexer/embed.js` → `src/indexer/embed.test.js`,
  `src/indexer/daemon.js` → `src/indexer/daemon.test.js` (CLAUDE.md).
- 4-space indentation, single quotes, trailing commas on multiline, spaced array brackets
  (`[ 'a', 'b' ]`), `func-style: declaration` — matches `eslint.config.js` and every prior plan's
  style.
- **No Python anywhere** (CLAUDE.md) — the embedding pipeline and its tokenizer both run in-process
  via `@huggingface/transformers`; no sidecar process, no IPC to a second language runtime.
- **`notes reindex` idempotency** (CLAUDE.md): running `processPath` twice against an unchanged file
  must leave `chunks`/`chunk_vectors`/`notes_fts`/`note_tags` byte-identical, not doubled — Task 10 is
  a dedicated test for exactly this, and every mutation in `processPath` follows S001's
  delete-then-reinsert idempotent-reindex procedure verbatim.
- **Fail loudly** (CLAUDE.md): `processPath` throws on genuine processing errors (propagated to
  `recordFailure`'s retry bookkeeping, never swallowed); `assertFswatchAvailable` throws a clear,
  actionable error instead of a raw `ENOENT`, matching `S004-grep-tags`'s `assertRipgrepAvailable`.
- **Real, not mocked, wherever practical** (CLAUDE.md's testing philosophy, `S001`/`S002`/`S004`'s
  established precedent): real temp SQLite DBs via `openDb`, real temp vault directories, a real Unix
  socket, and — for the two seams that are expensive rather than merely inconvenient (the embedding
  model's weights, the Qwen3 tokenizer's real subword behavior) — a small number of dedicated,
  long-timeout, first-run-downloads-then-caches integration tests, rather than mocking
  `@huggingface/transformers` outright. Everywhere else that would touch the real model (chunking
  math, the embedder's lazy-load/idle-unload lifecycle, every `processPath`/`drainQueueOnce` test),
  this plan uses **dependency injection** — an explicit function parameter standing in for `embed`/
  `tokenizeWithOffsets`/`pipelineFactory`/`scheduleUnload` — the same pattern `S002-search` already
  used for `embed`, not `vi.mock()` against the library. This is a deliberate, spec-consistent
  interpretation flagged here rather than silently assumed; see Self-Review Notes.
- `index_queue.path` and `notes.path` are always vault-relative, forward-slash-joined strings with a
  `.md` extension (matches S001's `notes.path` convention) — never an absolute filesystem path.
  `toVaultRelativePath`/`walkVaultForMarkdown`, introduced once in Task 14, are reused by every later
  task that needs to convert between an absolute filesystem path and this stored form.
- `now` is always a plain epoch-millisecond number, defaulted via `now = Date.now()` — never an
  injected function — for every daemon.js function that needs the current time, keeping call sites
  simple and tests deterministic by passing an explicit number.
- Lint budget in mind while structuring helpers: `max-lines-per-function: 50`, `max-statements: 30`,
  `max-depth: 2`, `max-nested-callbacks: 3`, `max-params: 5` (`eslint.config.js`) — multi-field
  dependencies are always passed as a single `deps`/`options` object, mirroring `S002`/`S003`'s
  pattern.

---

### Task 1: `chunkText` — single chunk for a short body

**Files:**
- Create: `src/indexer/embed.js`
- Create: `src/indexer/embed.test.js`

**Interfaces:**
- Produces: `chunkText(body, tokenizeWithOffsets, options = {}) -> Array<{ chunkIndex, charStart,
  charEnd, tokenCount }>`, where `tokenizeWithOffsets(text) -> Array<{ start, end }>` is injected.
  `options` is `{ chunkSize = 512, overlapTokens = 77 }`. A body whose token count is at or below
  `chunkSize` produces exactly one chunk spanning the whole body; an empty body produces `[]`.

- [ ] **Step 1: Write the failing tests**

Create `src/indexer/embed.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: FAIL — `src/indexer/embed.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/indexer/embed.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/embed.js src/indexer/embed.test.js
git commit -m "feat(indexer): add chunkText single-chunk case for short bodies"
```

---

### Task 2: `chunkText` — sliding-window overlap for a long body

**Files:**
- Modify: `src/indexer/embed.js`
- Modify: `src/indexer/embed.test.js`

**Interfaces:**
- Produces: `chunkText`'s multi-chunk behavior — a body longer than `chunkSize` tokens produces
  multiple chunks, each after the first starting `chunkSize - overlapTokens` tokens into the previous
  one's window, with the final chunk covering whatever remains (possibly shorter than `chunkSize`).
  No implementation change is needed here beyond Task 1's — this task is purely about proving the
  already-general sliding-window loop handles the multi-chunk case correctly.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/embed.test.js`:

```js
describe('chunkText: long body (sliding window with overlap)', () => {
    it('produces overlapping chunks with a shorter final chunk for the remainder', () => {
        const body = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ');
        const tokens = fakeTokenizeWithOffsets(body);

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        expect(chunks.map((c) => c.chunkIndex)).toEqual([ 0, 1, 2, 3 ]);
        expect(chunks.map((c) => c.tokenCount)).toEqual([ 10, 10, 10, 4 ]);
        expect(chunks[0]).toEqual({
            chunkIndex: 0, charStart: tokens[0].start, charEnd: tokens[9].end, tokenCount: 10,
        });
        expect(chunks[1]).toEqual({
            chunkIndex: 1, charStart: tokens[7].start, charEnd: tokens[16].end, tokenCount: 10,
        });
        expect(chunks[3]).toEqual({
            chunkIndex: 3, charStart: tokens[21].start, charEnd: tokens[24].end, tokenCount: 4,
        });
    });

    it('never produces a chunk with zero tokens', () => {
        const body = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');

        const chunks = chunkText(body, fakeTokenizeWithOffsets, { chunkSize: 10, overlapTokens: 3 });

        for (const chunk of chunks) {
            expect(chunk.tokenCount).toBeGreaterThan(0);
        }
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: PASS — Task 1's implementation already generalizes to the multi-chunk case; this task exists
to lock that behavior in with an explicit test rather than leaving it implicitly covered.

- [ ] **Step 3: Commit**

```bash
git add src/indexer/embed.test.js
git commit -m "test(indexer): cover chunkText's multi-chunk sliding-window overlap case"
```

---

### Task 3: Real Qwen3 tokenizer adapter

**Files:**
- Modify: `src/indexer/embed.js`
- Modify: `src/indexer/embed.test.js`

**Interfaces:**
- Produces: `DEFAULT_MODEL_ID` (`'onnx-community/Qwen3-Embedding-0.6B-ONNX'`), `loadTokenizer(modelId
  = DEFAULT_MODEL_ID) -> Promise<Tokenizer>` (via `@huggingface/transformers`'s `AutoTokenizer`), and
  `tokenizeWithOffsets(tokenizer, text) -> Array<{ start, end }>` — the real implementation of the
  interface `chunkText` has depended on abstractly since Task 1. This is the one real, slow (network
  on first run, cached under `@huggingface/transformers`'s cache directory thereafter),
  network-dependent test in this plan's embed.js half.

- [ ] **Step 1: Write the failing test**

Add to `src/indexer/embed.test.js` (new import at top):

```js
import { loadTokenizer, tokenizeWithOffsets } from './embed.js';
```

```js
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: FAIL — `loadTokenizer`/`tokenizeWithOffsets` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/embed.js` — add the import and both functions:

```js
import { AutoTokenizer } from '@huggingface/transformers';

export const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';

export async function loadTokenizer(modelId = DEFAULT_MODEL_ID) {
    return AutoTokenizer.from_pretrained(modelId);
}

export function tokenizeWithOffsets(tokenizer, text) {
    const encoded = tokenizer(text, { return_offsets_mapping: true });
    return Array.from(encoded.offset_mapping)
        .map(([ start, end ]) => ({ start: Number(start), end: Number(end) }))
        .filter(({ start, end }) => end > start);
}
```

Note: `return_offsets_mapping`'s exact option name and `encoded.offset_mapping`'s exact shape should
be confirmed against the installed `@huggingface/transformers` version's tokenizer API during
implementation — flagged in Self-Review, same posture `S003`'s plan took toward `gray-matter`'s exact
API surface. The `filter` step drops zero-width spans (special tokens like `[CLS]`/`[SEP]` some
tokenizers report as `[0, 0]`), which would otherwise produce a bogus zero-length "token" at chunk
boundaries.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: PASS (first run downloads and caches the tokenizer's vocab/config files; subsequent runs are
fast).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/embed.js src/indexer/embed.test.js
git commit -m "feat(indexer): wire the real Qwen3 tokenizer for offset-mapped tokenization"
```

---

### Task 4: `createEmbedder` — lazy singleton load

**Files:**
- Modify: `src/indexer/embed.js`
- Modify: `src/indexer/embed.test.js`

**Interfaces:**
- Produces: `createEmbedder(options = {}) -> { embed(text), isLoaded(), unload() }`. `options.
  pipelineFactory(modelId, { dtype }) -> Promise<(text) -> Promise<Float32Array>>` is injected — the
  pipeline is not created until the first `embed()` call, and is reused (not reloaded) across
  subsequent calls.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/embed.test.js` (new import):

```js
import { createEmbedder } from './embed.js';

function fakePipelineFactory() {
    let calls = 0;
    async function factory() {
        calls += 1;
        return async (text) => new Float32Array(1024).fill(text.length);
    }
    factory.calls = () => calls;
    return factory;
}
```

```js
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: FAIL — `createEmbedder` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/embed.js` — add:

```js
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
        }, idleTimeoutMs);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/embed.js src/indexer/embed.test.js
git commit -m "feat(indexer): add createEmbedder with lazy pipeline load"
```

---

### Task 5: `createEmbedder` — idle-unload and reload

**Files:**
- Modify: `src/indexer/embed.js`
- Modify: `src/indexer/embed.test.js`

**Interfaces:**
- Consumes: `createEmbedder` from Task 4 — no implementation change needed, this task exercises the
  idle-timer wiring already built via injected `scheduleUnload`/`cancelUnload` fakes instead of real
  10-minute waits.
- Produces: test coverage proving the pipeline auto-unloads after `idleTimeoutMs` of inactivity and
  transparently reloads on the next `embed()` call, and that every `embed()` call resets (cancels +
  reschedules) the idle timer rather than letting the original one fire regardless of recent activity.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/embed.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: PASS — Task 4's implementation already wires `resetIdleTimer` on every `embed()` call; this
task locks the behavior in with dedicated tests.

- [ ] **Step 3: Commit**

```bash
git add src/indexer/embed.test.js
git commit -m "test(indexer): cover createEmbedder idle-unload and timer-reset behavior"
```

---

### Task 6: Real embedding pipeline wiring, shared singleton `embed()`

**Files:**
- Modify: `src/indexer/embed.js`
- Modify: `src/indexer/embed.test.js`

**Interfaces:**
- Produces: `defaultPipelineFactory(modelId, { dtype }) -> Promise<(text) -> Promise<Float32Array>>`
  (real `@huggingface/transformers` `pipeline('feature-extraction', ...)` wiring, mean-pooled and
  normalized per the model's conventional sentence-embedding usage), `getSharedEmbedder()` (module
  -level singleton using real defaults), and `embed(text) -> Promise<Float32Array(1024)>` — the
  concrete implementation of the `embed` function `S002-search`'s `search()` expects as an injected
  argument. This is the second and last genuinely slow/network-on-first-run test in embed.js.

- [ ] **Step 1: Write the failing test**

Add to `src/indexer/embed.test.js` (new import):

```js
import { embed } from './embed.js';
```

```js
describe('embed: real pipeline (slow, network on first run)', () => {
    it('returns a normalized 1024-dim Float32Array for real text', async () => {
        const vector = await embed('hello world');

        expect(vector).toBeInstanceOf(Float32Array);
        expect(vector.length).toBe(1024);
    }, 120000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: FAIL — `embed` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/embed.js` — add:

```js
import { AutoTokenizer, pipeline } from '@huggingface/transformers';

async function defaultPipelineFactory(modelId, { dtype }) {
    const extractor = await pipeline('feature-extraction', modelId, { dtype });
    return async (text) => {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        return Float32Array.from(output.data);
    };
}

let sharedEmbedder = null;

export function getSharedEmbedder() {
    if (sharedEmbedder === null) {
        sharedEmbedder = createEmbedder({ pipelineFactory: defaultPipelineFactory });
    }
    return sharedEmbedder;
}

export async function embed(text) {
    return getSharedEmbedder().embed(text);
}
```

(Update the existing `import { AutoTokenizer } from '@huggingface/transformers';` line from Task 3 to
also import `pipeline`, as shown above, rather than adding a second import statement.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/indexer/embed.test.js`
Expected: PASS (first run downloads and caches the q8 model weights; subsequent runs reuse the cache).

- [ ] **Step 5: Run the full embed.js suite and lint**

Run: `pnpm vitest run src/indexer/embed.test.js && pnpm lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/embed.js src/indexer/embed.test.js
git commit -m "feat(indexer): wire the real embedding pipeline, add shared embed() singleton"
```

---

### Task 7: `index_queue` enqueue/dequeue helpers

**Files:**
- Create: `src/indexer/daemon.js`
- Create: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `openDb` from `src/core/db.js` (S001).
- Produces: `enqueuePath(db, path, now = Date.now()) -> void` (dedupes via `index_queue`'s
  `ON CONFLICT(path) DO NOTHING`, preserving the existing row's position) and `dequeueNextPath(db, now
  = Date.now()) -> string | null` (the earliest eligible path — `next_attempt_at <= now`, ordered by
  `next_attempt_at` then `enqueued_at` — without removing it from the table; removal is a separate,
  later step once processing outcome is known).

- [ ] **Step 1: Write the failing tests**

Create `src/indexer/daemon.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { enqueuePath, dequeueNextPath } from './daemon.js';

const tempDirs = [];

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('enqueuePath / dequeueNextPath', () => {
    it('dedupes a re-enqueued path, preserving its original enqueued_at', () => {
        const db = makeTestDb();

        enqueuePath(db, 'A.md', 1000);
        enqueuePath(db, 'A.md', 2000);

        const row = db.prepare('SELECT * FROM index_queue WHERE path = ?').get('A.md');
        expect(row.enqueued_at).toBe(1000);
    });

    it('dequeues the earliest-eligible path by next_attempt_at then enqueued_at', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Second.md', 2000);
        enqueuePath(db, 'First.md', 1000);

        expect(dequeueNextPath(db, 3000)).toBe('First.md');
    });

    it('skips a path whose next_attempt_at is still in the future', () => {
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)',
        ).run('Future.md', 1000, 999999);
        enqueuePath(db, 'Ready.md', 1000);

        expect(dequeueNextPath(db, 2000)).toBe('Ready.md');
    });

    it('returns null when nothing is eligible', () => {
        const db = makeTestDb();
        expect(dequeueNextPath(db, 1000)).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `src/indexer/daemon.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/indexer/daemon.js`:

```js
export function enqueuePath(db, path, now = Date.now()) {
    db.prepare(`
        INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO NOTHING
    `).run(path, now, now);
}

export function dequeueNextPath(db, now = Date.now()) {
    const row = db.prepare(`
        SELECT path FROM index_queue
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at, enqueued_at
        LIMIT 1
    `).get(now);
    return row ? row.path : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add index_queue enqueue/dequeue helpers"
```

---

### Task 8: `processPath` — skip-unchanged (mtime match)

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `noteRead` from `src/core/notes.js` (S003, reused for hashing/frontmatter parsing — not
  reimplemented here).
- Produces: `processPath(vaultRoot, db, path, deps) -> Promise<{ status: 'unchanged' | 'reindexed' |
  'deleted' }>`. This task only implements the mtime-match short-circuit (S005 step 1's first branch):
  if a `notes` row already exists for `path` and its stored `mtime` equals the file's current mtime,
  return `{ status: 'unchanged' }` without reading file content at all. Every other branch throws "not
  yet implemented" — filled in by Tasks 9 and 11.

- [ ] **Step 1: Write the failing test**

Add to `src/indexer/daemon.test.js` (new imports and a helper):

```js
import { writeFileSync, utimesSync } from 'node:fs';
import { processPath } from './daemon.js';

function writeNote(vaultRoot, relativePath, content, mtimeSec) {
    const filePath = join(vaultRoot, relativePath);
    writeFileSync(filePath, content, 'utf8');
    if (mtimeSec !== undefined) {
        utimesSync(filePath, mtimeSec, mtimeSec);
    }
    return filePath;
}

function fakeChunkText(body) {
    return body.length === 0 ? [] : [ { chunkIndex: 0, charStart: 0, charEnd: body.length, tokenCount: 1 } ];
}

async function fakeEmbed() {
    return new Float32Array(1024).fill(0.1);
}

function baseDeps() {
    return {
        chunkText: fakeChunkText,
        embed: fakeEmbed,
        embeddingModel: 'test-model',
        embeddingVersion: 'v1',
    };
}
```

```js
describe('processPath: skip-unchanged', () => {
    it('returns unchanged without reading the file when mtime matches the stored value', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'irrelevant-hash', 1, 1000, 1000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `processPath is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add imports and `processPath`:

```js
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { noteRead } from '../core/notes.js';

export async function processPath(vaultRoot, db, path, deps) {
    const absPath = join(vaultRoot, path);
    const stats = statSync(absPath);
    const currentMtime = Math.floor(stats.mtimeMs / 1000);

    const existing = db.prepare('SELECT id, mtime, content_hash FROM notes WHERE path = ?').get(path);
    if (existing && existing.mtime === currentMtime) {
        return { status: 'unchanged' };
    }

    throw new Error('processPath: content-changed branch not yet implemented');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add processPath skip-unchanged mtime short-circuit"
```

---

### Task 9: `processPath` — content changed: full idempotent reindex

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `noteRead` (S003), `extractTags`/`syncNoteTags` (S004), `deps.chunkText`/`deps.embed` (a
  fully-bound chunker and the injected embed function — mirrors `S002-search`'s injection pattern).
- Produces: `processPath`'s content-changed branch — hash comparison (mtime-only update when content
  is byte-identical despite a changed mtime, e.g. a `touch`), and, when the hash actually changed,
  S001's idempotent-reindex procedure in full: `notes` upsert, delete+reinsert `chunks`/
  `chunk_vectors`, delete+reinsert the `notes_fts` row, and `syncNoteTags`. Introduces the private
  helpers `upsertNoteRow`, `replaceChunks`, `replaceFtsRow`.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js`:

```js
describe('processPath: content changed', () => {
    it('updates mtime only when the hash is unchanged despite a newer mtime (e.g. touch)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'stable body', 1000);
        const raw = 'stable body';
        const { hashContent } = await import('../core/notes.js');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', hashContent(raw), 1, 500, 500);
        utimesSync(join(vaultRoot, 'A.md'), 2000, 2000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
        const row = db.prepare('SELECT mtime FROM notes WHERE path = ?').get('A.md');
        expect(row.mtime).toBe(2000);
    });

    it('reindexes a brand-new note: notes row, chunks, chunk_vectors, notes_fts, tags', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'New Note.md', '---\ntags:\n  - project\n---\nhello world', 1000);

        const result = await processPath(vaultRoot, db, 'New Note.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });

        const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('New Note.md');
        expect(note.mtime).toBe(1000);

        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const vectorRow = db.prepare('SELECT rowid FROM chunk_vectors WHERE rowid = ?').get(chunkRows[0].id);
        expect(vectorRow).toBeDefined();

        const ftsHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").get();
        expect(ftsHit.rowid).toBe(note.id);

        const tagRow = db.prepare(`
            SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ?
        `).get(note.id);
        expect(tagRow.name).toBe('project');
    });

    it('replaces stale chunks/fts/tags rather than appending on a content change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Changing.md', 'original body', 1000);
        await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        writeNote(vaultRoot, 'Changing.md', 'replaced body entirely', 2000);
        const result = await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Changing.md');
        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const staleHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'original'").get();
        expect(staleHit).toBeUndefined();
        const freshHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'replaced'").get();
        expect(freshHit.rowid).toBe(note.id);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — the content-changed branch currently throws "not yet implemented".

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js`:

```js
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { noteRead } from '../core/notes.js';
import { extractTags, syncNoteTags } from '../core/tags.js';

function upsertNoteRow(db, path, contentHash, lineCount, mtime, updatedAt) {
    db.prepare(`
        INSERT INTO notes (path, content_hash, line_count, mtime, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            line_count = excluded.line_count,
            mtime = excluded.mtime,
            updated_at = excluded.updated_at
    `).run(path, contentHash, lineCount, mtime, updatedAt);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion) {
    const staleChunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(noteId).map((r) => r.id);
    for (const chunkId of staleChunkIds) {
        db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?').run(chunkId);
    }
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);

    const insertChunk = db.prepare(`
        INSERT INTO chunks (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVector = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)');

    for (const chunk of embeddedChunks) {
        insertChunk.run(
            noteId, chunk.chunkIndex, chunk.charStart, chunk.charEnd, chunk.tokenCount,
            embeddingModel, embeddingVersion,
        );
        const chunkId = db.prepare(
            'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
        ).get(noteId, chunk.chunkIndex).id;
        insertVector.run(chunkId, Buffer.from(chunk.vector.buffer));
    }
}

function replaceFtsRow(db, noteId, title, body) {
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(noteId);
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

export async function processPath(vaultRoot, db, path, deps) {
    const { chunkText, embed, embeddingModel, embeddingVersion, now = Date.now() } = deps;
    const absPath = join(vaultRoot, path);
    const stats = statSync(absPath);
    const currentMtime = Math.floor(stats.mtimeMs / 1000);

    const existing = db.prepare('SELECT id, mtime, content_hash FROM notes WHERE path = ?').get(path);
    if (existing && existing.mtime === currentMtime) {
        return { status: 'unchanged' };
    }

    const title = path.replace(/\.md$/, '');
    const read = noteRead(vaultRoot, title);

    if (existing && existing.content_hash === read.content_hash) {
        db.prepare('UPDATE notes SET mtime = ?, updated_at = ? WHERE id = ?').run(currentMtime, Math.floor(now / 1000), existing.id);
        return { status: 'unchanged' };
    }

    const chunkDescriptors = chunkText(read.content);
    const embeddedChunks = [];
    for (const descriptor of chunkDescriptors) {
        const chunkBody = read.content.slice(descriptor.charStart, descriptor.charEnd);
        const vector = await embed(chunkBody);
        embeddedChunks.push({ ...descriptor, vector });
    }

    const noteId = upsertNoteRow(db, path, read.content_hash, read.total_lines, currentMtime, Math.floor(now / 1000));
    replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion);
    replaceFtsRow(db, noteId, title, read.content);
    syncNoteTags(db, noteId, extractTags(read.content, read.metadata));

    return { status: 'reindexed' };
}
```

Note `deps.chunkText` here is a single-argument function `(body) -> Array<{...}>` — the real caller
(Task 19's `startDaemon`) binds the tokenizer into it via a closure
(`(body) => chunkText(body, boundTokenizeWithOffsets)`), so `processPath` itself never needs to know
about tokenizers at all.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): implement processPath full reindex per S001's idempotent-reindex procedure"
```

---

### Task 10: `processPath` — idempotent reprocessing

**Files:**
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `processPath` from Task 9 — no implementation change expected. This task is the
  dedicated proof of CLAUDE.md's "`notes reindex` must be idempotent" requirement at the
  single-file-processing level: running `processPath` twice against the same unchanged file produces
  byte-identical `chunks`/`chunk_vectors`/`notes_fts` state, not doubled rows.

- [ ] **Step 1: Write the failing test**

Add to `src/indexer/daemon.test.js`:

```js
describe('processPath: idempotent reprocessing', () => {
    it('produces no duplicate chunks/vectors/fts rows when run twice with no file change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Stable.md', 'a stable note body', 1000);

        const first = await processPath(vaultRoot, db, 'Stable.md', baseDeps());
        expect(first.status).toBe('reindexed');

        // Force a re-check by bumping mtime without changing content — the daemon's real trigger for
        // this path (an editor rewriting identical bytes) but exercised directly here since this test
        // is about processPath's idempotency, not the debounce/fswatch layer that would normally cause it.
        utimesSync(join(vaultRoot, 'Stable.md'), 2000, 2000);
        const second = await processPath(vaultRoot, db, 'Stable.md', baseDeps());
        expect(second.status).toBe('unchanged');

        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Stable.md');
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE note_id = ?').get(note.id).count;
        expect(chunkCount).toBe(1);

        const vectorCount = db.prepare('SELECT COUNT(*) AS count FROM chunk_vectors').get().count;
        expect(vectorCount).toBe(1);

        const ftsCount = db.prepare("SELECT COUNT(*) AS count FROM notes_fts WHERE notes_fts MATCH 'stable'").get().count;
        expect(ftsCount).toBe(1);
    });

    it('produces no duplicate rows when the content genuinely changes twice in a row to the same text', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Repeat.md', 'first version', 1000);
        await processPath(vaultRoot, db, 'Repeat.md', baseDeps());

        writeNote(vaultRoot, 'Repeat.md', 'second version', 2000);
        await processPath(vaultRoot, db, 'Repeat.md', baseDeps());

        writeNote(vaultRoot, 'Repeat.md', 'second version', 3000); // rewritten with identical bytes
        const result = await processPath(vaultRoot, db, 'Repeat.md', baseDeps());

        expect(result.status).toBe('unchanged');
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Repeat.md');
        const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE note_id = ?').get(note.id).count;
        expect(chunkCount).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS — Task 9's delete-then-reinsert implementation already satisfies idempotency; this task
exists to make that guarantee an explicit, permanent regression test rather than an implicit property.

- [ ] **Step 3: Commit**

```bash
git add src/indexer/daemon.test.js
git commit -m "test(indexer): prove processPath idempotency across repeated unchanged reprocessing"
```

---

### Task 11: `processPath` — missing file mid-process is a deletion, not a failure

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Produces: `processPath`'s final branch — if the file has vanished by the time `processPath` runs
  (a race between enqueue and drain, or a stale queue entry for an already-deleted file), it cleans up
  any existing `notes`/`chunks`/`chunk_vectors`/`notes_fts`/`note_tags` rows for that path and returns
  `{ status: 'deleted' }` rather than throwing — a missing file is not a processing *error* to retry.
  Introduces the exported `deleteNoteByPath(db, path) -> void`, reused unchanged by Task 14's
  `existenceCheck`.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { rmSync as removeFile } from 'node:fs';
import { deleteNoteByPath } from './daemon.js';
```

```js
describe('processPath: missing file', () => {
    it('cleans up an existing notes row and returns deleted when the file is gone', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Gone.md', 'will be deleted', 1000);
        await processPath(vaultRoot, db, 'Gone.md', baseDeps());
        removeFile(join(vaultRoot, 'Gone.md'));

        const result = await processPath(vaultRoot, db, 'Gone.md', baseDeps());

        expect(result).toEqual({ status: 'deleted' });
        expect(db.prepare('SELECT id FROM notes WHERE path = ?').get('Gone.md')).toBeUndefined();
    });

    it('returns deleted (no-op) for a stale queue entry with no matching notes row at all', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();

        const result = await processPath(vaultRoot, db, 'NeverExisted.md', baseDeps());

        expect(result).toEqual({ status: 'deleted' });
    });
});

describe('deleteNoteByPath', () => {
    it('removes chunks, chunk_vectors, notes_fts, and note_tags for the note', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Full.md', '#project note body', 1000);
        await processPath(vaultRoot, db, 'Full.md', baseDeps());
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Full.md');

        deleteNoteByPath(db, 'Full.md');

        expect(db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id)).toBeUndefined();
        expect(db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id)).toHaveLength(0);
        expect(db.prepare('SELECT * FROM chunk_vectors').all()).toHaveLength(0);
        expect(db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'project'").get()).toBeUndefined();
        expect(db.prepare('SELECT * FROM note_tags WHERE note_id = ?').all(note.id)).toHaveLength(0);
    });

    it('is a safe no-op for a path with no matching notes row', () => {
        const db = makeTestDb();
        expect(() => deleteNoteByPath(db, 'NoSuchNote.md')).not.toThrow();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `deleteNoteByPath` is not exported; `processPath` currently throws `ENOENT` from
`statSync` instead of returning `{ status: 'deleted' }`.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js`:

```js
export function deleteNoteByPath(db, path) {
    const note = db.prepare('SELECT id FROM notes WHERE path = ?').get(path);
    if (!note) {
        return;
    }
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(note.id).map((r) => r.id);
    for (const chunkId of chunkIds) {
        db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?').run(chunkId);
    }
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(note.id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id); // cascades chunks, note_tags (S001 FKs)
}

export async function processPath(vaultRoot, db, path, deps) {
    const { chunkText, embed, embeddingModel, embeddingVersion, now = Date.now() } = deps;
    const absPath = join(vaultRoot, path);

    let stats;
    try {
        stats = statSync(absPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            deleteNoteByPath(db, path);
            return { status: 'deleted' };
        }
        throw err;
    }

    const currentMtime = Math.floor(stats.mtimeMs / 1000);
    const existing = db.prepare('SELECT id, mtime, content_hash FROM notes WHERE path = ?').get(path);
    if (existing && existing.mtime === currentMtime) {
        return { status: 'unchanged' };
    }

    const title = path.replace(/\.md$/, '');
    let read;
    try {
        read = noteRead(vaultRoot, title);
    } catch (err) {
        if (/not found/i.test(err.message)) {
            deleteNoteByPath(db, path);
            return { status: 'deleted' };
        }
        throw err;
    }

    if (existing && existing.content_hash === read.content_hash) {
        db.prepare('UPDATE notes SET mtime = ?, updated_at = ? WHERE id = ?').run(currentMtime, Math.floor(now / 1000), existing.id);
        return { status: 'unchanged' };
    }

    const chunkDescriptors = chunkText(read.content);
    const embeddedChunks = [];
    for (const descriptor of chunkDescriptors) {
        const chunkBody = read.content.slice(descriptor.charStart, descriptor.charEnd);
        const vector = await embed(chunkBody);
        embeddedChunks.push({ ...descriptor, vector });
    }

    const noteId = upsertNoteRow(db, path, read.content_hash, read.total_lines, currentMtime, Math.floor(now / 1000));
    replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion);
    replaceFtsRow(db, noteId, title, read.content);
    syncNoteTags(db, noteId, extractTags(read.content, read.metadata));

    return { status: 'reindexed' };
}
```

Note the deliberate divergence from S005's prose ("cascading to `chunks`/`chunk_vectors`/`note_tags`
per S001's `ON DELETE CASCADE`") — S001's own schema section states plainly that `vec0` doesn't
support `ON DELETE CASCADE` and that `chunk_vectors` cleanup is explicit application code, and
`notes_fts` (a virtual table with no real foreign key at all) was never cascade-capable either. This
plan follows S001's precise mechanics, not S005's looser summary — see Self-Review Notes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS (full suite so far)

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): treat a missing file in processPath as deletion, add deleteNoteByPath"
```

---

### Task 12: `recordFailure` — retry/backoff schedule and exhaustion

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Produces: `DEFAULT_BACKOFF_SCHEDULE_MS` (`[30_000, 120_000, 600_000]` — 30s/2m/10m) and
  `recordFailure(db, path, now = Date.now(), backoffSchedule = DEFAULT_BACKOFF_SCHEDULE_MS) -> {
  permanentlyFailed: boolean, attempts: number }`. Each call increments `index_queue.attempts` and
  sets `next_attempt_at` per the schedule; once `attempts` reaches `backoffSchedule.length + 1` (4
  total attempts — the initial try plus 3 scheduled retries, per S005), the row is removed from
  `index_queue` entirely and `permanentlyFailed: true` is returned so the caller can log a
  permanent-failure entry.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { recordFailure } from './daemon.js';
```

```js
describe('recordFailure', () => {
    it('schedules the first retry 30s out and increments attempts to 1', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Flaky.md', 1000);

        const result = recordFailure(db, 'Flaky.md', 1000);

        expect(result).toEqual({ permanentlyFailed: false, attempts: 1 });
        const row = db.prepare('SELECT * FROM index_queue WHERE path = ?').get('Flaky.md');
        expect(row.attempts).toBe(1);
        expect(row.next_attempt_at).toBe(Math.floor((1000 + 30000) / 1000));
    });

    it('follows the full 30s/2m/10m schedule across three consecutive failures', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Flaky.md', 0);

        recordFailure(db, 'Flaky.md', 0);
        const second = recordFailure(db, 'Flaky.md', 0);
        expect(second.attempts).toBe(2);
        let row = db.prepare('SELECT next_attempt_at FROM index_queue WHERE path = ?').get('Flaky.md');
        expect(row.next_attempt_at).toBe(Math.floor(120000 / 1000));

        const third = recordFailure(db, 'Flaky.md', 0);
        expect(third.attempts).toBe(3);
        row = db.prepare('SELECT next_attempt_at FROM index_queue WHERE path = ?').get('Flaky.md');
        expect(row.next_attempt_at).toBe(Math.floor(600000 / 1000));
    });

    it('removes the row and reports permanentlyFailed after the 4th attempt', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Flaky.md', 0);

        recordFailure(db, 'Flaky.md', 0);
        recordFailure(db, 'Flaky.md', 0);
        recordFailure(db, 'Flaky.md', 0);
        const fourth = recordFailure(db, 'Flaky.md', 0);

        expect(fourth).toEqual({ permanentlyFailed: true, attempts: 4 });
        expect(db.prepare('SELECT * FROM index_queue WHERE path = ?').get('Flaky.md')).toBeUndefined();
    });

    it('is a safe no-op for a path with no matching queue row', () => {
        const db = makeTestDb();
        expect(recordFailure(db, 'NotQueued.md', 0)).toEqual({ permanentlyFailed: false, attempts: 0 });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `recordFailure` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add:

```js
export const DEFAULT_BACKOFF_SCHEDULE_MS = [ 30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000 ];

export function recordFailure(db, path, now = Date.now(), backoffSchedule = DEFAULT_BACKOFF_SCHEDULE_MS) {
    const row = db.prepare('SELECT attempts FROM index_queue WHERE path = ?').get(path);
    if (!row) {
        return { permanentlyFailed: false, attempts: 0 };
    }

    const attempts = row.attempts + 1;
    const maxAttempts = backoffSchedule.length + 1;

    if (attempts >= maxAttempts) {
        db.prepare('DELETE FROM index_queue WHERE path = ?').run(path);
        return { permanentlyFailed: true, attempts };
    }

    const nextAttemptAt = Math.floor((now + backoffSchedule[attempts - 1]) / 1000);
    db.prepare('UPDATE index_queue SET attempts = ?, next_attempt_at = ? WHERE path = ?').run(attempts, nextAttemptAt, path);
    return { permanentlyFailed: false, attempts };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add recordFailure with 30s/2m/10m backoff and exhaustion"
```

---

### Task 13: `drainQueueOnce` — full drain loop wiring

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `dequeueNextPath`, `processPath`, `recordFailure` from prior tasks; an optional injected
  `logger` (matching `src/logger.js`'s `pino`-style `.info()`/`.warn()`/`.error()` interface from S008
  — defaults to a no-op object so earlier-style callers don't need one).
- Produces: `drainQueueOnce(vaultRoot, db, deps) -> Promise<{ reindexed, skipped, failed }>` — dequeues
  and processes every currently-eligible `index_queue` row exactly once each (rows still in backoff
  are left for a later pass), removing a row on success and deferring to `recordFailure` on a thrown
  error. A path that resolves to `{ status: 'deleted' }` counts toward `skipped` (no re-embedding work
  happened, matching the spirit of S005's "unchanged files are still cheap" framing for the
  full-vault reindex summary, which only defines three buckets) — see Self-Review Notes.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { drainQueueOnce } from './daemon.js';

function fakeLogger() {
    const calls = { info: [], warn: [], error: [] };
    return {
        info: (...args) => calls.info.push(args),
        warn: (...args) => calls.warn.push(args),
        error: (...args) => calls.error.push(args),
        calls,
    };
}
```

```js
describe('drainQueueOnce', () => {
    it('processes every eligible path once, removing successes from the queue', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'note a', 1000);
        writeNote(vaultRoot, 'B.md', 'note b', 1000);
        enqueuePath(db, 'A.md', 0);
        enqueuePath(db, 'B.md', 0);

        const summary = await drainQueueOnce(vaultRoot, db, { ...baseDeps(), now: 0 });

        expect(summary).toEqual({ reindexed: 2, skipped: 0, failed: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM index_queue').get().count).toBe(0);
    });

    it('leaves a permanently-failed path out of the queue and logs an error', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Broken.md', 'body', 1000);
        enqueuePath(db, 'Broken.md', 0);
        const brokenDeps = {
            ...baseDeps(),
            embed: async () => { throw new Error('embedding failed'); },
            now: 0,
        };
        const logger = fakeLogger();

        // Exhaust all 4 attempts across 4 drain passes (each pass processes eligible rows once;
        // backoff means a failed row isn't eligible again until its next_attempt_at, so this test
        // drives recordFailure directly to reach exhaustion deterministically within one pass).
        for (let i = 0; i < 4; i += 1) {
            db.prepare('UPDATE index_queue SET next_attempt_at = 0').run();
            await drainQueueOnce(vaultRoot, db, { ...brokenDeps, logger });
        }

        expect(db.prepare('SELECT * FROM index_queue WHERE path = ?').get('Broken.md')).toBeUndefined();
        expect(logger.calls.error.length).toBeGreaterThan(0);
    });

    it('returns zero counts when the queue is empty', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();

        const summary = await drainQueueOnce(vaultRoot, db, baseDeps());

        expect(summary).toEqual({ reindexed: 0, skipped: 0, failed: 0 });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `drainQueueOnce` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add:

```js
const noopLogger = { info() {}, warn() {}, error() {} };

export async function drainQueueOnce(vaultRoot, db, deps) {
    const { now = Date.now(), logger = noopLogger } = deps;
    let reindexed = 0;
    let skipped = 0;
    let failed = 0;

    let path = dequeueNextPath(db, now);
    while (path !== null) {
        try {
            const result = await processPath(vaultRoot, db, path, deps);
            db.prepare('DELETE FROM index_queue WHERE path = ?').run(path);
            if (result.status === 'reindexed') {
                reindexed += 1;
                logger.info({ path, outcome: 'reindexed' });
            } else {
                skipped += 1;
                logger.info({ path, outcome: result.status });
            }
        } catch (err) {
            const { permanentlyFailed, attempts } = recordFailure(db, path, now, deps.backoffSchedule);
            if (permanentlyFailed) {
                failed += 1;
                logger.error({ path, attempts, error: err.message, outcome: 'permanent-failure' });
            } else {
                logger.warn({ path, attempts, error: err.message, outcome: 'retry-scheduled' });
            }
        }
        path = dequeueNextPath(db, now);
    }

    return { reindexed, skipped, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add drainQueueOnce wiring dequeue, processPath, and retry/backoff"
```

---

### Task 14: Startup catch-up — `watermarkCatchup` + `existenceCheck`

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Produces: `toVaultRelativePath(vaultRoot, absPath) -> string` and `walkVaultForMarkdown(vaultRoot) ->
  string[]` (private helpers reused by later tasks), `watermarkCatchup(db, vaultRoot, now = Date.now())
  -> number` (enqueues every `.md` file whose mtime is newer than `MAX(notes.updated_at)`, returns the
  count enqueued — `0` watermark on an empty `notes` table naturally indexes the whole vault on first
  run, per S005), and `existenceCheck(db, vaultRoot) -> number` (deletes, via `deleteNoteByPath`, any
  `notes` row whose file no longer exists on disk; returns the count deleted).

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { mkdirSync } from 'node:fs';
import { watermarkCatchup, existenceCheck } from './daemon.js';
```

```js
describe('watermarkCatchup', () => {
    it('enqueues every .md file when notes is empty (0 watermark = full first-run index)', () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'a', 1000);
        mkdirSync(join(vaultRoot, 'Weekly Notes'));
        writeNote(vaultRoot, 'Weekly Notes/2026-W32.md', 'w', 1000);
        const db = makeTestDb();

        const count = watermarkCatchup(db, vaultRoot, 2000);

        expect(count).toBe(2);
        const queued = db.prepare('SELECT path FROM index_queue ORDER BY path').all().map((r) => r.path);
        expect(queued).toEqual([ 'A.md', 'Weekly Notes/2026-W32.md' ]);
    });

    it('only enqueues files newer than the current MAX(notes.updated_at) watermark', () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Old.md', 'old', 500);
        writeNote(vaultRoot, 'New.md', 'new', 1500);
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Old.md', 'hash', 1, 500, 1000);

        const count = watermarkCatchup(db, vaultRoot, 2000);

        expect(count).toBe(1);
        expect(db.prepare('SELECT path FROM index_queue').get().path).toBe('New.md');
    });

    it('ignores non-.md files', () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'attachment.png'), 'binary');
        const db = makeTestDb();

        expect(watermarkCatchup(db, vaultRoot, 2000)).toBe(0);
    });
});

describe('existenceCheck', () => {
    it('deletes notes rows whose file no longer exists on disk', () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Gone.md', 'hash', 1, 1000, 1000);
        writeNote(vaultRoot, 'Still Here.md', 'body', 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Still Here.md', 'hash', 1, 1000, 1000);

        const count = existenceCheck(db, vaultRoot);

        expect(count).toBe(1);
        expect(db.prepare('SELECT path FROM notes').get().path).toBe('Still Here.md');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `watermarkCatchup`/`existenceCheck` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add imports and the four functions:

```js
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function toVaultRelativePath(vaultRoot, absPath) {
    return relative(vaultRoot, absPath).split(sep).join('/');
}

function walkVaultForMarkdown(vaultRoot) {
    const results = [];
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(full);
            }
        }
    }
    walk(vaultRoot);
    return results;
}

export function watermarkCatchup(db, vaultRoot, now = Date.now()) {
    const row = db.prepare('SELECT MAX(updated_at) AS watermark FROM notes').get();
    const watermark = row.watermark ?? 0;

    let enqueuedCount = 0;
    for (const absPath of walkVaultForMarkdown(vaultRoot)) {
        const mtimeSec = Math.floor(statSync(absPath).mtimeMs / 1000);
        if (mtimeSec > watermark) {
            enqueuePath(db, toVaultRelativePath(vaultRoot, absPath), now);
            enqueuedCount += 1;
        }
    }
    return enqueuedCount;
}

export function existenceCheck(db, vaultRoot) {
    let deletedCount = 0;
    for (const row of db.prepare('SELECT path FROM notes').all()) {
        if (!existsSync(join(vaultRoot, row.path))) {
            deleteNoteByPath(db, row.path);
            deletedCount += 1;
        }
    }
    return deletedCount;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add startup watermark catch-up and existence-check cleanup"
```

---

### Task 15: `createDebouncer` — unified per-path debounce timer

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Produces: `createDebouncer(onSettle, options = {}) -> { notify(path), cancelAll() }`. `options` is
  `{ debounceMs = 15000, scheduleFn = setTimeout, cancelFn = clearTimeout }`. Every `notify(path)` call
  resets that path's timer; `onSettle(path)` fires once `debounceMs` has elapsed with no further
  `notify(path)` calls for that same path — the "unified per-path debounce" S005 specifies for create/
  modify/delete/rename events alike. Tested with injected fake scheduler functions, not real 15-second
  waits.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { createDebouncer } from './daemon.js';
```

```js
describe('createDebouncer', () => {
    it('fires onSettle once after debounceMs of quiet for a path', () => {
        let scheduled = null;
        const settled = [];
        const debouncer = createDebouncer((path) => settled.push(path), {
            debounceMs: 15000,
            scheduleFn: (fn, ms) => { scheduled = { fn, ms }; return 'timer'; },
            cancelFn: () => {},
        });

        debouncer.notify('A.md');

        expect(scheduled.ms).toBe(15000);
        expect(settled).toEqual([]);
        scheduled.fn();
        expect(settled).toEqual([ 'A.md' ]);
    });

    it('resets the timer on repeated notify() calls for the same path, cancelling the previous one', () => {
        const cancelled = [];
        let timerCount = 0;
        const debouncer = createDebouncer(() => {}, {
            scheduleFn: () => { timerCount += 1; return `timer-${timerCount}`; },
            cancelFn: (id) => cancelled.push(id),
        });

        debouncer.notify('A.md');
        debouncer.notify('A.md');
        debouncer.notify('A.md');

        expect(cancelled).toEqual([ 'timer-1', 'timer-2' ]);
    });

    it('tracks independent timers per path', () => {
        const scheduledFns = {};
        const settled = [];
        const debouncer = createDebouncer((path) => settled.push(path), {
            scheduleFn: (fn) => { scheduledFns[fn.name || Math.random()] = fn; return fn; },
            cancelFn: () => {},
        });

        debouncer.notify('A.md');
        debouncer.notify('B.md');

        for (const fn of Object.values(scheduledFns)) {
            fn();
        }
        expect(settled.sort()).toEqual([ 'A.md', 'B.md' ]);
    });

    it('cancelAll() cancels every pending timer', () => {
        const cancelled = [];
        const debouncer = createDebouncer(() => {}, {
            scheduleFn: () => 'timer',
            cancelFn: (id) => cancelled.push(id),
        });

        debouncer.notify('A.md');
        debouncer.notify('B.md');
        debouncer.cancelAll();

        expect(cancelled).toEqual([ 'timer', 'timer' ]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `createDebouncer` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add:

```js
const DEFAULT_DEBOUNCE_MS = 15000;

export function createDebouncer(onSettle, options = {}) {
    const { debounceMs = DEFAULT_DEBOUNCE_MS, scheduleFn = setTimeout, cancelFn = clearTimeout } = options;
    const timers = new Map();

    function notify(path) {
        if (timers.has(path)) {
            cancelFn(timers.get(path));
        }
        const timer = scheduleFn(() => {
            timers.delete(path);
            onSettle(path);
        }, debounceMs);
        timers.set(path, timer);
    }

    function cancelAll() {
        for (const timer of timers.values()) {
            cancelFn(timer);
        }
        timers.clear();
    }

    return { notify, cancelAll };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add createDebouncer for unified per-path fswatch debounce"
```

---

### Task 16: `assertFswatchAvailable` + `spawnFswatch`

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Produces: `assertFswatchAvailable(env = process.env) -> void` (throws a clear, actionable error if
  `fswatch` isn't on `PATH` — mirrors `S004-grep-tags`'s `assertRipgrepAvailable`) and
  `spawnFswatch(vaultRoot, onPath) -> ChildProcess` (spawns the real system `fswatch -r <vaultRoot>`
  binary, streaming each emitted path — one per line — to `onPath`). The one real-binary integration
  test here proves it detects an actual file write; it does not test debounce (Task 15) or the
  recheck-after-settle logic (Task 19), which are independently covered elsewhere.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new imports):

```js
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { assertFswatchAvailable, spawnFswatch } from './daemon.js';
```

```js
describe('assertFswatchAvailable', () => {
    it('does not throw when fswatch is resolvable on PATH', () => {
        expect(() => assertFswatchAvailable()).not.toThrow();
    });

    it('throws an actionable error when fswatch is not on PATH', () => {
        expect(() => assertFswatchAvailable({ PATH: '' })).toThrow(/fswatch not found/);
    });
});

describe('spawnFswatch (real binary)', () => {
    it('reports a path when a file changes under the watched directory', async () => {
        const vaultRoot = makeTempVault();

        const seenPaths = await new Promise((resolve, reject) => {
            const found = [];
            const child = spawnFswatch(vaultRoot, (path) => {
                found.push(path);
                child.kill();
                resolve(found);
            });
            child.on('error', reject);
            setTimeout(() => writeNote(vaultRoot, 'Triggered.md', 'content', undefined), 300);
            setTimeout(() => { child.kill(); resolve(found); }, 5000);
        });

        expect(seenPaths.length).toBeGreaterThan(0);
    }, 10000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `assertFswatchAvailable`/`spawnFswatch` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add imports and both functions:

```js
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function assertFswatchAvailable(env = process.env) {
    try {
        execFileSync('fswatch', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('fswatch not found — install via `brew install fswatch`');
        }
        throw error;
    }
}

export function spawnFswatch(vaultRoot, onPath) {
    assertFswatchAvailable();
    const child = spawn('fswatch', [ '-r', vaultRoot ]);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
        const path = line.trim();
        if (path.length > 0) {
            onPath(path);
        }
    });
    return child;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add assertFswatchAvailable and spawnFswatch"
```

---

### Task 17: `runReindex` — IPC-triggered reindex business logic

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `enqueuePath`, `processPath`, `recordFailure`, `walkVaultForMarkdown`,
  `toVaultRelativePath` from prior tasks.
- Produces: `runReindex(vaultRoot, db, deps, options = {}, onMessage = () => {}) -> Promise<void>`,
  where `options` is `{ noteTitle = null }`. With no `noteTitle`, walks the whole vault and enqueues
  every `.md` path (S005: "not just changed ones"); with a `noteTitle`, scopes to that one path. Each
  path is driven through `processPath`/`recordFailure` until it reaches a final state (success or
  retries exhausted), calling `onMessage` once per attempt outcome and once more with a final
  `{ summary: { reindexed, skipped, failed } }`. Deliberately socket-free — `onMessage` is a plain
  callback, so this is testable without opening a real connection; Task 18 wires a real socket around
  it.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { runReindex } from './daemon.js';
```

```js
describe('runReindex', () => {
    it('enqueues and reindexes every .md file in the vault when noteTitle is omitted', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'note a', 1000);
        writeNote(vaultRoot, 'B.md', 'note b', 1000);
        const db = makeTestDb();
        const messages = [];

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 0 }, {}, (msg) => messages.push(msg));

        const summaryMsg = messages.find((m) => m.summary);
        expect(summaryMsg.summary).toEqual({ reindexed: 2, skipped: 0, failed: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count).toBe(2);
    });

    it('scopes to a single path when noteTitle is given', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Only.md', 'note', 1000);
        writeNote(vaultRoot, 'Ignored.md', 'note', 1000);
        const db = makeTestDb();
        const messages = [];

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 0 }, { noteTitle: 'Only' }, (msg) => messages.push(msg));

        expect(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count).toBe(1);
        expect(db.prepare('SELECT path FROM notes').get().path).toBe('Only.md');
    });

    it('streams a message per attempt and retries in place until success or exhaustion', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Flaky.md', 'note', 1000);
        const db = makeTestDb();
        let attemptCount = 0;
        const flakyDeps = {
            ...baseDeps(),
            embed: async (text) => {
                attemptCount += 1;
                if (attemptCount < 4) {
                    throw new Error('transient failure');
                }
                return new Float32Array(1024).fill(0.1);
            },
            now: 0,
        };
        const messages = [];

        await runReindex(vaultRoot, db, flakyDeps, { noteTitle: 'Flaky' }, (msg) => messages.push(msg));

        const finalOutcome = messages.find((m) => m.path === 'Flaky.md' && m.outcome === 'reindexed');
        expect(finalOutcome).toBeDefined();
        expect(messages.filter((m) => m.outcome === 'attempt_failed')).toHaveLength(3);
    });

    it('reports failed in the summary once retries are exhausted', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'AlwaysBroken.md', 'note', 1000);
        const db = makeTestDb();
        const brokenDeps = {
            ...baseDeps(),
            embed: async () => { throw new Error('always fails'); },
            now: 0,
        };
        const messages = [];

        await runReindex(vaultRoot, db, brokenDeps, { noteTitle: 'AlwaysBroken' }, (msg) => messages.push(msg));

        const summaryMsg = messages.find((m) => m.summary);
        expect(summaryMsg.summary).toEqual({ reindexed: 0, skipped: 0, failed: 1 });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `runReindex` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add:

```js
export async function runReindex(vaultRoot, db, deps, options = {}, onMessage = () => {}) {
    const { noteTitle = null } = options;
    const now = deps.now ?? Date.now();

    const paths = noteTitle !== null
        ? [ `${noteTitle}.md` ]
        : walkVaultForMarkdown(vaultRoot).map((absPath) => toVaultRelativePath(vaultRoot, absPath));

    for (const path of paths) {
        enqueuePath(db, path, now);
    }

    let reindexed = 0;
    let skipped = 0;
    let failed = 0;

    for (const path of paths) {
        let outcome = null;
        for (;;) {
            try {
                const result = await processPath(vaultRoot, db, path, deps);
                db.prepare('DELETE FROM index_queue WHERE path = ?').run(path);
                outcome = result.status === 'reindexed' ? 'reindexed' : 'skipped';
                onMessage({ path, outcome });
                break;
            } catch (err) {
                const { permanentlyFailed, attempts } = recordFailure(db, path, now, deps.backoffSchedule);
                onMessage({ path, outcome: 'attempt_failed', attempts, error: err.message });
                if (permanentlyFailed) {
                    outcome = 'failed';
                    onMessage({ path, outcome: 'failed' });
                    break;
                }
                // An IPC-triggered reindex retries immediately rather than waiting out the real backoff
                // delay, since a caller is actively blocked on this connection watching it happen.
            }
        }
        if (outcome === 'reindexed') {
            reindexed += 1;
        } else if (outcome === 'failed') {
            failed += 1;
        } else {
            skipped += 1;
        }
    }

    onMessage({ summary: { reindexed, skipped, failed } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add runReindex IPC business logic with in-place retry streaming"
```

---

### Task 18: Unix socket IPC server

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `runReindex` from Task 17.
- Produces: `defaultSocketPath() -> string` (`~/Library/Application Support/mnotes/daemon.sock`, per
  S005), `createIpcServer(socketPath, vaultRoot, db, deps) -> net.Server` — accepts connections,
  parses newline-delimited JSON requests (`{ action: 'reindex', noteTitle?: string }`), and streams
  `runReindex`'s messages back over the same connection as newline-delimited JSON, closing the
  connection after the summary. Tested over a real Unix domain socket in a temp directory — an OS
  primitive, not a mock.

- [ ] **Step 1: Write the failing test**

Add to `src/indexer/daemon.test.js` (new imports):

```js
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { createIpcServer, defaultSocketPath } from './daemon.js';
```

```js
describe('defaultSocketPath', () => {
    it('points at ~/Library/Application Support/mnotes/daemon.sock', () => {
        expect(defaultSocketPath()).toBe(
            join(homedir(), 'Library', 'Application Support', 'mnotes', 'daemon.sock'),
        );
    });
});

describe('createIpcServer', () => {
    it('streams per-path outcomes and a final summary for a reindex request', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Socketed.md', 'note body', 1000);
        const db = makeTestDb();
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        const server = createIpcServer(socketPath, vaultRoot, db, { ...baseDeps(), now: 0 });

        const messages = await new Promise((resolve, reject) => {
            const received = [];
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'reindex' })}\n`);
            });
            let buffer = '';
            client.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    received.push(JSON.parse(buffer.slice(0, newlineIndex)));
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf('\n');
                }
            });
            client.on('end', () => resolve(received));
            client.on('error', reject);
        });

        server.close();
        expect(messages.some((m) => m.path === 'Socketed.md')).toBe(true);
        expect(messages.find((m) => m.summary).summary).toEqual({ reindexed: 1, skipped: 0, failed: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `createIpcServer`/`defaultSocketPath` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add imports and both functions:

```js
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { existsSync as pathExists, rmSync } from 'node:fs';

export function defaultSocketPath() {
    return join(homedir(), 'Library', 'Application Support', 'mnotes', 'daemon.sock');
}

export function createIpcServer(socketPath, vaultRoot, db, deps) {
    if (pathExists(socketPath)) {
        rmSync(socketPath);
    }

    const server = createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf('\n');
                handleRequest(line, socket);
            }
        });
    });

    async function handleRequest(line, socket) {
        const request = JSON.parse(line);
        if (request.action !== 'reindex') {
            socket.end(`${JSON.stringify({ error: `unknown action "${request.action}"` })}\n`);
            return;
        }
        await runReindex(
            vaultRoot, db, deps, { noteTitle: request.noteTitle ?? null },
            (msg) => socket.write(`${JSON.stringify(msg)}\n`),
        );
        socket.end();
    }

    server.listen(socketPath);
    return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): add Unix socket IPC server for the reindex protocol"
```

---

### Task 19: `startDaemon` — full startup sequence

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: every prior task's exports, plus `openDb` (S001), `getLogger`/`defaultLogDir` (S008),
  `chunkText`/`loadTokenizer`/`tokenizeWithOffsets`/`embed` (this plan's `embed.js`, Tasks 1–6).
- Produces: `startDaemon(options = {}) -> Promise<{ stop() }>`, wiring S005's full startup sequence in
  order: open the DB (schema check/rebuild via `openDb`'s `reindexRequired`), run `watermarkCatchup` +
  `existenceCheck`, start the fswatch watcher (debouncer + recheck-on-settle: file exists → enqueue,
  file gone → `deleteNoteByPath` immediately, no queue), start a repeating queue-drain loop, and start
  the IPC server. Real `fswatch`/tokenizer/model wiring is the default, but every dependency is
  injectable — this task's own test substitutes fast fakes for the watcher and the embed/chunk
  functions (both already covered by dedicated real-binary/real-model tests in Tasks 3, 6, and 16), so
  the test stays fast and deterministic while still exercising real startup-catchup, real queue
  draining, and a real IPC round-trip end to end.

- [ ] **Step 1: Write the failing test**

Add to `src/indexer/daemon.test.js` (new import):

```js
import { startDaemon } from './daemon.js';
```

```js
describe('startDaemon', () => {
    it('indexes the pre-existing vault on startup and serves a reindex request over IPC', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Preexisting.md', 'already on disk', 1000);
        const socketDir = makeTempVault();
        const socketPath = join(socketDir, 'daemon.sock');

        const daemon = await startDaemon({
            vaultRoot,
            dbPath: ':memory:',
            socketPath,
            createWatcher: () => ({ stop() {} }), // fswatch itself is covered by Task 16's real-binary test
            chunkText: fakeChunkText,
            embed: fakeEmbed,
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
            drainIntervalMs: null, // this test drives one drain pass manually instead of on a timer
        });

        expect(daemon.db.prepare('SELECT path FROM notes').get().path).toBe('Preexisting.md');

        const messages = await new Promise((resolve, reject) => {
            const received = [];
            const client = createConnection(socketPath, () => {
                client.write(`${JSON.stringify({ action: 'reindex' })}\n`);
            });
            let buffer = '';
            client.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    received.push(JSON.parse(buffer.slice(0, newlineIndex)));
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf('\n');
                }
            });
            client.on('end', () => resolve(received));
            client.on('error', reject);
        });

        expect(messages.find((m) => m.summary)).toBeDefined();

        await daemon.stop();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `startDaemon` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add imports and `startDaemon`:

```js
import { openDb } from '../core/db.js';
import { getLogger, defaultLogDir } from '../logger.js';
import { chunkText as realChunkText, loadTokenizer, tokenizeWithOffsets as realTokenizeWithOffsets, embed as realEmbed } from './embed.js';

const DEFAULT_EMBEDDING_MODEL = 'Qwen3-Embedding-0.6B';
const DEFAULT_EMBEDDING_VERSION = 'q8-v1';
const DEFAULT_DRAIN_INTERVAL_MS = 2000;

export async function startDaemon(options = {}) {
    const {
        vaultRoot,
        dbPath,
        socketPath = defaultSocketPath(),
        logDir = defaultLogDir(),
        embeddingModel = DEFAULT_EMBEDDING_MODEL,
        embeddingVersion = DEFAULT_EMBEDDING_VERSION,
        embed = realEmbed,
        createWatcher = null,
        drainIntervalMs = DEFAULT_DRAIN_INTERVAL_MS,
    } = options;

    const logger = getLogger('indexer', logDir);
    const { db, reindexRequired } = openDb(dbPath);

    let chunkText = options.chunkText;
    if (!chunkText) {
        const tokenizer = await loadTokenizer();
        chunkText = (body) => realChunkText(body, (text) => realTokenizeWithOffsets(tokenizer, text));
    }

    const deps = { chunkText, embed, embeddingModel, embeddingVersion, logger };

    if (reindexRequired) {
        logger.info({ msg: 'schema rebuilt, running full catch-up' });
        watermarkCatchup(db, vaultRoot);
    } else {
        watermarkCatchup(db, vaultRoot);
        existenceCheck(db, vaultRoot);
    }

    const watcher = (createWatcher ?? defaultCreateWatcher)(vaultRoot, db);

    let drainTimer = null;
    if (drainIntervalMs !== null) {
        drainTimer = setInterval(() => {
            drainQueueOnce(vaultRoot, db, deps).catch((err) => logger.error({ error: err.message }));
        }, drainIntervalMs);
    } else {
        await drainQueueOnce(vaultRoot, db, deps);
    }

    const ipcServer = createIpcServer(socketPath, vaultRoot, db, deps);

    async function stop() {
        if (drainTimer !== null) {
            clearInterval(drainTimer);
        }
        watcher.stop();
        await new Promise((resolve) => ipcServer.close(resolve));
        db.close();
    }

    return { db, stop };
}

function defaultCreateWatcher(vaultRoot, db) {
    const debouncer = createDebouncer((path) => {
        const absPath = join(vaultRoot, path);
        if (existsSync(absPath)) {
            enqueuePath(db, path);
        } else {
            deleteNoteByPath(db, path);
        }
    });

    const child = spawnFswatch(vaultRoot, (absPath) => {
        debouncer.notify(toVaultRelativePath(vaultRoot, absPath));
    });

    return {
        stop() {
            debouncer.cancelAll();
            child.kill();
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass (`src/indexer/embed.test.js` and `src/indexer/daemon.test.js`, plus every
prior module's suite unaffected), no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): wire startDaemon's full startup sequence"
```

---

## Self-Review Notes

- **Spec coverage**: the startup sequence (schema check via `openDb`'s existing `reindexRequired`,
  watermark catch-up, existence check, watcher start, drainer start, IPC start — Task 19), the unified
  15-second per-path debounce with a single post-debounce existence recheck rather than per-event-type
  branching (Tasks 15, 19), the queue drainer's skip-unchanged/hash-compare/full-reindex branches and
  ordering by `next_attempt_at` then `enqueued_at` (Tasks 7–11, 13), retry/backoff with the exact
  30s/2m/10m schedule and 4-total-attempts exhaustion (Task 12), token-based chunking with ~512
  tokens/~15% overlap against the model's own tokenizer (Tasks 1–3), the lazy-load/10-minute-idle
  -unload/q8-dtype embedding pipeline lifecycle (Tasks 4–6), and the newline-delimited-JSON Unix socket
  protocol for both the no-title (full vault, streamed per-path, final summary) and title-scoped
  (blocks through the retry cycle on the same connection) `reindex` requests (Tasks 17–18) each have a
  dedicated task and passing tests.
- **Task count exceeds the initial 12–18 estimate** (19 tasks: 6 in `embed.js`, 13 in `daemon.js`) —
  flagged deliberately rather than force-fit into the original range. S005 is explicitly the largest,
  most cross-cutting spec (the only one touching every other table in S001, plus two real external
  processes — `fswatch` and the embedding model — that neither `S001`–`S004` had to deal with), and
  splitting `processPath` and `runReindex` each into several small, single-behavior tasks (rather than
  one large task per function) keeps every individual TDD step small and each failing test
  meaningfully different from the last, consistent with how `S004-grep-tags`'s 15-task plan handled a
  comparably多-branch `grep()`/`extractTags()`.
- **Dependency-injection over mocking, as the resolution of a real tension in CLAUDE.md's testing
  guidance**: CLAUDE.md says prefer real fixtures over mocking for anything touching `core/db.js`/
  `core/search.js`, but says nothing about the indexer's two genuinely expensive external dependencies
  — a multi-hundred-MB model download and a real 15-second-default debounce window. This plan's
  resolution, consistent with `S002-search`'s own precedent of taking `embed` as an injected argument
  specifically because `indexer/embed.js` "doesn't exist yet" and is expensive to call: every
  daemon.js/embed.js function that would otherwise need the real model, the real tokenizer, or a real
  wall-clock wait takes that behavior as an injected function parameter (`pipelineFactory`,
  `tokenizeWithOffsets`, `chunkText`, `embed`, `scheduleFn`/`cancelFn`, `scheduleUnload`/`cancelUnload`)
  with a real default implementation supplied only at the outermost `startDaemon`/`getSharedEmbedder`
  layer. This is dependency injection at explicit function boundaries — the same shape `search()`
  already uses for `embed` — not `vi.mock()` against `@huggingface/transformers`, `child_process`, or
  timers. A small number of tests (Tasks 3, 6, 16) deliberately exercise the real, slow, cached
  -after-first-run path end to end, so the real integration is still proven somewhere, not merely
  assumed correct because the fakes pass.
- **Correction against S005's own prose**: S005's "Startup sequence" step 3 describes existence-check
  deletions as "cascading to `chunks`/`chunk_vectors`/`note_tags` per S001's `ON DELETE CASCADE`."
  S001's own schema section is more precise and states plainly that `chunk_vectors` (a `vec0` virtual
  table) does **not** support `ON DELETE CASCADE` and requires explicit application-code cleanup, and
  `notes_fts` (contentless FTS5, no real foreign key at all) was never cascade-capable either — only
  `chunks` and `note_tags` actually cascade via a real SQL foreign key. `deleteNoteByPath` (Task 11)
  follows S001's precise mechanics: it explicitly deletes `chunk_vectors` and `notes_fts` rows before
  deleting the `notes` row, letting the real FK cascade handle only `chunks`/`note_tags`. Flagged here
  per CLAUDE.md's "if anything here conflicts with a spec, the spec wins" — S001 is the more specific,
  more authoritative source on its own table mechanics.
- **`drainQueueOnce`'s summary folds a mid-drain deletion into `skipped`**: S005's `reindex` IPC
  response shape is fixed at exactly `{ reindexed, skipped, failed }` — it has no `deleted` bucket.
  A `processPath` result of `{ status: 'deleted' }` only arises from a race (a file vanishing between
  enqueue and drain) since the live debounce path handles deletions directly without ever touching the
  queue (S005's "File doesn't exist → delete the corresponding notes row immediately (no queue
  needed)"). This plan folds that rare case into `skipped` (no re-embedding work happened, which is the
  bucket's meaning for every other no-op outcome) rather than inventing a fourth summary field the spec
  doesn't define. Flagged as a judgment call, not a spec requirement.
- **Tokenizer/pipeline API surface assumptions**: `tokenizer(text, { return_offsets_mapping: true })`
  returning `{ offset_mapping }`, and `extractor(text, { pooling: 'mean', normalize: true })` returning
  `{ data }`, are reasonable, commonly-used shapes for `@huggingface/transformers`'s tokenizer/
  feature-extraction pipeline APIs but are not verified against the exact installed `^4.2.0` version's
  API in this plan — flagged for confirmation during implementation (Tasks 3 and 6's real tests are
  exactly where a shape mismatch would surface immediately as a failing test, not a silent bug).
- **Explicitly out of scope here, per S005's own "Explicitly out of scope" section and cross-references
  to other specs**: `mnotes reindex`'s CLI flag parsing and how it opens/talks to the daemon's socket
  from the CLI side (`S006-cli`); the exact `config.toml` keys for the debounce window, idle-unload
  timeout, embedding precision, and retry schedule — this plan hardcodes each as a default parameter
  value (`DEFAULT_DEBOUNCE_MS`, `DEFAULT_IDLE_TIMEOUT_MS`, `DEFAULT_DTYPE`,
  `DEFAULT_BACKOFF_SCHEDULE_MS`), all overridable, none read from config (`S009-config-and-install`);
  the `launchd` plist that actually keeps this daemon running and restarts it on crash (`S009`);
  `mnotes stats`'s "notes pending re-embedding" query, which reads `chunks.embedding_model`/
  `embedding_version` against the currently-configured model but is specified and owned by `S006`, not
  built here.
- **Placeholder scan**: no TODOs/TBDs left unresolved; every step has complete, runnable code. Task 8's
  "not yet implemented" stub for `processPath`'s content-changed branch is explicitly closed out by
  Task 9, mirroring the same pattern `S001`'s Task 9→10 and `S003`'s Task 3→4 already established in
  this project's plans for landing one branch of a function per task.
- **Type/signature consistency**: `processPath(vaultRoot, db, path, deps) -> Promise<{ status }>` is
  unchanged in shape from Task 8 through Task 19 (`status` grows from `'unchanged'` to include
  `'reindexed'`/`'deleted'` across Tasks 9 and 11, but the return shape itself never changes).
  `enqueuePath`/`dequeueNextPath`/`recordFailure`/`drainQueueOnce`/`runReindex` are each introduced once
  (Tasks 7, 12, 13, 17) and never change signature afterward. `embed(text) -> Promise<Float32Array
  (1024)>` (embed.js Task 6) matches exactly the shape `S002-search`'s plan already documented as its
  injected-`embed` integration seam, closing that dependency cleanly.
