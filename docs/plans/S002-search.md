# S002 Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/core/search.js` — a single `search(db, options)` function answering
`fulltext`, `semantic`, and `hybrid` queries over the tables `S001-data-model` defines, per
`docs/specs/S002-search.md`.

**Architecture:** One exported async function, `search(db, { query, mode = 'hybrid', limit = 20,
embed, embeddingModel, embeddingVersion })`. Internally, two retrieval helpers —
`fulltextSearch(db, query, limit)` (BM25 via `notes_fts MATCH`) and `semanticSearch(db, query,
limit, opts)` (cosine KNN via `chunk_vectors MATCH`, best-chunk-wins collapse) — each return a
*rank-annotated, over-fetched* array (`min(limit × 5, 500)` rows, not yet truncated to `limit`).
`fulltext`/`semantic` mode truncate that array to `limit` directly; `hybrid` mode (the default)
feeds both full over-fetched arrays into `mergeHybrid`, which computes Reciprocal Rank Fusion
(`k = 60`) scores and truncates to `limit` only after merging. A small set of `toXOutput` functions
strip every internal field (`noteId`, `distance`, `score`, `mtime`) down to the public,
never-raw-scores output shape: `note_title`, `file_line_count`, and — hybrid mode only —
`fulltext_rank`/`semantic_rank`.

**Integration seams (not yet implemented elsewhere):**
- **`embed(text) -> Float32Array(1024) | Promise<Float32Array(1024)>`** — the real implementation is
  `indexer/embed.js` (S005), which doesn't exist yet. `search()` takes `embed` as an injected
  function argument rather than importing `indexer/embed.js` directly, so S002 has no build-order
  dependency on S005 and stays trivially unit-testable with a fake. `cli/`/`mcp/` (S006/S007) will be
  responsible for wiring the real `embed` in.
- **`embeddingModel` / `embeddingVersion`** — the currently-configured embedding model/version is a
  `config.toml` value (S009, not built yet). `search()` takes these as explicit params from the
  caller rather than reading config itself, per the same reasoning.
- **`limit`'s default (`20`) and max (`100`)**, the over-fetch multiplier (`5`) and cap (`500`), and
  RRF's `k` (`60`) are all `config.toml` values per the spec, flagged for S009. This plan hardcodes
  them as module-level constants — swapping them for config reads later is a mechanical change, not
  an architecture change.

**Tech Stack:** Node 24 built-in `node:sqlite` (via `openDb` from `src/core/db.js`, already built),
`sqlite-vec`'s KNN `MATCH` syntax on `chunk_vectors`, FTS5 `MATCH` + `bm25()` on `notes_fts`, Vitest
with a real in-memory `openDb(':memory:')` per test (no mocking `core/db.js`, per CLAUDE.md).

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `core/` takes plain arguments, returns plain data, throws on error — no CLI/MCP concerns
  (CLAUDE.md, S001, S002).
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md).
- Test file colocated: `src/core/search.js` → `src/core/search.test.js` (CLAUDE.md).
- Use a real in-memory SQLite DB (`openDb(':memory:')`) in tests, never mock `core/db.js` or
  `core/search.js` (CLAUDE.md).
- 4-space indentation, single quotes, trailing commas on multiline, spaced array brackets
  (`[ 'a', 'b' ]`) — matches `eslint.config.js`-enforced style used in S001's `src/core/db.js`.
- `func-style: declaration` — use `function foo() {}`, not `const foo = () => {}`, for named
  functions (arrow functions are fine for inline callbacks) — `eslint.config.js`.
- **Never expose raw BM25/cosine/RRF scores** — only rank position (`fulltext_rank`/`semantic_rank`)
  or, for single-mode results, array order (CLAUDE.md, S002 Output). Internal fields (`score`,
  `distance`, `mtime`) are stripped by dedicated `toXOutput` functions before anything returns from
  `search()` — never returned ad hoc inline.
- **Fail loudly** (CLAUDE.md): a missing `query`, an out-of-range `limit`, a missing `embed` function
  in `semantic`/`hybrid` mode, and malformed FTS5 syntax in `fulltext`/`hybrid` mode are all thrown
  errors with specific, descriptive messages — never a silent fallback or partial result.
- The fulltext side always passes `query` straight to `MATCH`, unmodified, in both `fulltext` and
  `hybrid` mode — one query-building code path (`fulltextSearch`), not two (S002 "Fulltext query
  building"). `hybrid` mode's malformed-query behavior therefore falls out of `fulltext`'s
  implementation for free — no separate hybrid-specific error handling needed.
- RRF: `score(note) = Σ 1 / (k + rank_i)`, `k = 60`, summed only over the list(s) a note appears in
  (no implicit zero-rank penalty term) — S002 "RRF merge".
- Tie-break: equal RRF score (hybrid) or equal native rank (single-mode) breaks by `notes.mtime`
  descending, in every mode — S002 "Tie-breaking".
- `note_title` is derived from `notes.path` by stripping the `.md` extension (path is already
  vault-root-relative per S001; no further stripping needed). S001 states this derivation belongs to
  `core/notes.js` (S003), which doesn't exist yet — S002's spec header states it depends only on
  S001, not S003, so this plan uses a small private `pathToTitle` helper local to `search.js` as a
  deliberate, temporary duplication. Flagged in Self-Review below for consolidation once S003 lands.
- Lint budget to keep in mind while structuring helpers: `max-lines-per-function: 50`,
  `max-statements: 30`, `max-depth: 2`, `max-nested-callbacks: 3`, `max-params: 5`
  (`eslint.config.js`) — every function in this plan stays well under these.

---

### Task 1: `fulltext` mode — BM25 ranking

**Files:**
- Create: `src/core/search.js`
- Create: `src/core/search.test.js`

**Interfaces:**
- Consumes: `openDb` from `src/core/db.js` (S001) — tests open `:memory:` DBs directly and hand-insert
  `notes`/`notes_fts` rows (no indexer exists yet to populate them).
- Produces: `search(db, { query, mode, limit = 20 }) -> Promise<Array<{ note_title, file_line_count
  }>>` for `mode: 'fulltext'`. Other modes throw "not yet implemented" — Tasks 2–3 fill them in.
  `pathToTitle`, `computeOverfetch`, `fulltextSearch`, `toFulltextOutput` are introduced here and
  reused unchanged (aside from tie-breaking added in Task 4) by every later task.

- [ ] **Step 1: Write the failing tests**

Create `src/core/search.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';
import { search } from './search.js';

function insertNote(db, { path, contentHash = 'hash', lineCount = 10, mtime = 1000 }) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, contentHash, lineCount, mtime, mtime);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function insertFtsRow(db, noteId, title, body) {
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

describe('search: fulltext mode', () => {
    it('returns note_title (derived from path) and file_line_count for a MATCH hit', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Projects/Moneta.md', lineCount: 42 });
        insertFtsRow(db, noteId, 'Moneta', 'notes about a personal knowledge graph');

        const results = await search(db, { query: 'knowledge graph', mode: 'fulltext', limit: 20 });

        expect(results).toEqual([
            { note_title: 'Projects/Moneta', file_line_count: 42 },
        ]);
        db.close();
    });

    it('ranks a note with more query-term occurrences above one with fewer', async () => {
        const { db } = openDb(':memory:');
        const strongId = insertNote(db, { path: 'Strong.md' });
        const weakId = insertNote(db, { path: 'Weak.md' });
        insertFtsRow(db, weakId, 'Weak', 'graph appears once here');
        insertFtsRow(db, strongId, 'Strong', 'graph graph graph graph everywhere, graph');

        const results = await search(db, { query: 'graph', mode: 'fulltext', limit: 20 });

        expect(results.map((r) => r.note_title)).toEqual([ 'Strong', 'Weak' ]);
        db.close();
    });

    it('truncates to limit after over-fetching', async () => {
        const { db } = openDb(':memory:');
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, { path: `Note${i}.md` });
            insertFtsRow(db, noteId, `Note${i}`, 'shared term');
        }

        const results = await search(db, { query: 'shared', mode: 'fulltext', limit: 2 });

        expect(results).toHaveLength(2);
        db.close();
    });

    it('throws when query is missing', async () => {
        const { db } = openDb(':memory:');
        await expect(search(db, { mode: 'fulltext', limit: 20 })).rejects.toThrow(/query/);
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/search.test.js`
Expected: FAIL — `src/core/search.js` doesn't exist yet (`Cannot find module './search.js'` or
similar).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/search.js`:

```js
const DEFAULT_LIMIT = 20;
const OVERFETCH_MULTIPLIER = 5;
const OVERFETCH_CAP = 500;

function pathToTitle(path) {
    return path.replace(/\.md$/, '');
}

function computeOverfetch(limit) {
    return Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
}

function validateQuery(query) {
    if (typeof query !== 'string' || query.length === 0) {
        throw new Error('search: query must be a non-empty string');
    }
}

function fulltextSearch(db, query, limit) {
    const rows = db.prepare(`
        SELECT n.id AS note_id, n.path, n.line_count AS file_line_count, n.mtime,
               bm25(notes_fts) AS score
        FROM notes_fts
        JOIN notes n ON n.id = notes_fts.rowid
        WHERE notes_fts MATCH ?
        ORDER BY bm25(notes_fts)
        LIMIT ?
    `).all(query, computeOverfetch(limit));

    return rows.map((row, index) => ({
        noteId: row.note_id,
        noteTitle: pathToTitle(row.path),
        fileLineCount: row.file_line_count,
        mtime: row.mtime,
        rank: index + 1,
    }));
}

function toFulltextOutput(results, limit) {
    return results.slice(0, limit).map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
    }));
}

export async function search(db, options = {}) {
    const { query, mode, limit = DEFAULT_LIMIT } = options;
    validateQuery(query);

    if (mode === 'fulltext') {
        return toFulltextOutput(fulltextSearch(db, query, limit), limit);
    }

    throw new Error(`search: mode "${mode}" is not yet implemented`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/search.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/search.js src/core/search.test.js
git commit -m "feat(search): implement fulltext search with BM25 ranking"
```

---

### Task 2: `semantic` mode — cosine KNN, best-chunk-wins collapse

**Files:**
- Modify: `src/core/search.js`
- Modify: `src/core/search.test.js`

**Interfaces:**
- Consumes: `chunks`/`chunk_vectors` tables (S001); an injected `embed(text)` function and
  `embeddingModel`/`embeddingVersion` strings from `options` (the S005/S009 integration seams
  described above — tests always supply a fake `embed`).
- Produces: `semanticSearch(db, query, limit, opts)` and the `semantic` branch of `search()`. Adds
  `vectorToBuffer`, `runSemanticQuery`, `collapseToBestChunkPerNote`, `hydrateNotes`, all private and
  reused by `hybrid` mode in Task 3 unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/search.test.js` (new imports and helpers near the top, alongside `insertNote`/
`insertFtsRow`):

```js
function insertChunkWithVector(db, noteId, {
    chunkIndex = 0,
    seed,
    embeddingModel = 'test-model',
    embeddingVersion = 'v1',
}) {
    db.prepare(`
        INSERT INTO chunks
            (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
        VALUES (?, ?, 0, 100, 50, ?, ?)
    `).run(noteId, chunkIndex, embeddingModel, embeddingVersion);

    const chunkId = db.prepare(
        'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
    ).get(noteId, chunkIndex).id;

    const vector = new Float32Array(1024).fill(seed);
    db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)').run(
        chunkId,
        Buffer.from(vector.buffer),
    );
    return chunkId;
}

function fakeEmbed(seed) {
    return async () => new Float32Array(1024).fill(seed);
}
```

Add a new `describe` block:

```js
describe('search: semantic mode', () => {
    it('returns the note whose chunk vector is closest to the query embedding', async () => {
        const { db } = openDb(':memory:');
        insertNote(db, { path: 'Close.md', lineCount: 5 });
        const closeId = insertNote(db, { path: 'Close.md', lineCount: 5 });
        const farId = insertNote(db, { path: 'Far.md', lineCount: 5 });
        insertChunkWithVector(db, closeId, { seed: 0.5 });
        insertChunkWithVector(db, farId, { seed: 0.9 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].note_title).toBe('Close');
        db.close();
    });

    it('collapses multiple chunk hits from the same note to one row (best chunk wins)', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Multi.md' });
        insertChunkWithVector(db, noteId, { chunkIndex: 0, seed: 0.9 });
        insertChunkWithVector(db, noteId, { chunkIndex: 1, seed: 0.5 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results).toHaveLength(1);
        expect(results[0].note_title).toBe('Multi');
        db.close();
    });

    it('excludes chunks from a stale embedding_model/version', async () => {
        const { db } = openDb(':memory:');
        const staleId = insertNote(db, { path: 'Stale.md' });
        insertChunkWithVector(db, staleId, {
            seed: 0.5,
            embeddingModel: 'old-model',
            embeddingVersion: 'v0',
        });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results).toHaveLength(0);
        db.close();
    });

    it('throws when no embed function is provided', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, {
                query: 'x',
                mode: 'semantic',
                limit: 20,
                embeddingModel: 'test-model',
                embeddingVersion: 'v1',
            }),
        ).rejects.toThrow(/embed/);
        db.close();
    });
});
```

(The stray extra `insertNote(db, { path: 'Close.md', lineCount: 5 })` call in the first test above is
a copy-paste slip to fix before running — remove it; `path` is `UNIQUE`, so leaving it in fails the
test with a constraint error, not the intended assertion. Only `closeId` should be inserted once.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/search.test.js`
Expected: FAIL — `mode "semantic" is not yet implemented`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/search.js` — add the following after `toFulltextOutput`, and update `search()`:

```js
function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer);
}

function runSemanticQuery(db, vector, fetchCount, embeddingModel, embeddingVersion) {
    // `k` is interpolated, not bound: node:sqlite binds every JS number as SQLite REAL, and vec0's
    // KNN `k` constraint wants an integer literal (the same numeric-binding quirk S001 documents for
    // chunk_vectors.rowid). `fetchCount` is always an internally computed, bounded integer
    // (computeOverfetch of a caller-supplied limit), never raw user input, so interpolating it here
    // carries no injection risk.
    return db.prepare(`
        SELECT c.note_id AS note_id, cv.distance AS distance
        FROM chunk_vectors cv
        JOIN chunks c ON c.id = cv.rowid
        WHERE cv.embedding MATCH ? AND k = ${fetchCount}
          AND c.embedding_model = ?
          AND c.embedding_version = ?
        ORDER BY cv.distance
    `).all(vectorToBuffer(vector), embeddingModel, embeddingVersion);
}

function collapseToBestChunkPerNote(rows) {
    const bestDistanceByNote = new Map();
    for (const row of rows) {
        if (!bestDistanceByNote.has(row.note_id)) {
            bestDistanceByNote.set(row.note_id, row.distance);
        }
    }
    return bestDistanceByNote;
}

function hydrateNotes(db, noteIds) {
    if (noteIds.length === 0) {
        return new Map();
    }
    const placeholders = noteIds.map(() => '?').join(', ');
    const rows = db.prepare(`
        SELECT id, path, line_count AS file_line_count, mtime
        FROM notes
        WHERE id IN (${placeholders})
    `).all(...noteIds);
    return new Map(rows.map((row) => [ row.id, row ]));
}

async function semanticSearch(db, query, limit, { embed, embeddingModel, embeddingVersion }) {
    if (typeof embed !== 'function') {
        throw new Error('search: semantic and hybrid modes require an `embed` function');
    }

    const vector = await embed(query);
    const rawRows = runSemanticQuery(db, vector, computeOverfetch(limit), embeddingModel, embeddingVersion);
    const bestDistanceByNote = collapseToBestChunkPerNote(rawRows);
    const notesById = hydrateNotes(db, [ ...bestDistanceByNote.keys() ]);

    return [ ...bestDistanceByNote.entries() ].map(([ noteId, distance ], index) => {
        const note = notesById.get(noteId);
        return {
            noteId,
            noteTitle: pathToTitle(note.path),
            fileLineCount: note.file_line_count,
            mtime: note.mtime,
            distance,
            rank: index + 1,
        };
    });
}

function toSemanticOutput(results, limit) {
    return results.slice(0, limit).map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
    }));
}

export async function search(db, options = {}) {
    const { query, mode, limit = DEFAULT_LIMIT } = options;
    validateQuery(query);

    if (mode === 'fulltext') {
        return toFulltextOutput(fulltextSearch(db, query, limit), limit);
    }
    if (mode === 'semantic') {
        return toSemanticOutput(await semanticSearch(db, query, limit, options), limit);
    }

    throw new Error(`search: mode "${mode}" is not yet implemented`);
}
```

Note: `[...bestDistanceByNote.entries()]` is already in ascending-best-distance order without an
explicit sort — `rawRows` comes back from SQL already ordered by `cv.distance ASC`, and a
`Map`'s insertion order is preserved, so the first (lowest-distance) occurrence of each `note_id`
lands in the map in overall ascending-distance order. Task 4 adds an explicit sort step once mtime
tie-breaking needs a secondary key that this implicit ordering can't express.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/search.test.js`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add src/core/search.js src/core/search.test.js
git commit -m "feat(search): implement semantic search with best-chunk-wins collapse"
```

---

### Task 3: `hybrid` mode (default) — RRF merge

**Files:**
- Modify: `src/core/search.js`
- Modify: `src/core/search.test.js`

**Interfaces:**
- Consumes: the full (not limit-truncated) arrays returned by `fulltextSearch` (Task 1) and
  `semanticSearch` (Task 2) — this is why those two helpers were written to over-fetch and defer
  truncation to their respective `toXOutput` callers rather than truncating internally.
- Produces: `mergeHybrid`, `computeRrfScore`, `toHybridOutput`, and `search()`'s `hybrid` branch.
  `mode` now defaults to `'hybrid'` — this is the first task where omitting `mode` is valid.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/search.test.js`:

```js
describe('search: hybrid mode', () => {
    it('defaults to hybrid mode when mode is omitted', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Both.md' });
        insertFtsRow(db, noteId, 'Both', 'graph search');
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const results = await search(db, {
            query: 'graph',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].note_title).toBe('Both');
        expect(results[0].fulltext_rank).toBe(1);
        expect(results[0].semantic_rank).toBe(1);
        db.close();
    });

    it('includes a note found by only one side, with the other rank null', async () => {
        const { db } = openDb(':memory:');
        const fulltextOnlyId = insertNote(db, { path: 'FulltextOnly.md' });
        insertFtsRow(db, fulltextOnlyId, 'FulltextOnly', 'graph search');
        // no chunk/vector row for this note — it can never appear on the semantic side

        const results = await search(db, {
            query: 'graph',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.1),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results[0].note_title).toBe('FulltextOnly');
        expect(results[0].fulltext_rank).toBe(1);
        expect(results[0].semantic_rank).toBeNull();
        db.close();
    });

    it('ranks a note appearing on both sides above one appearing on only one side', async () => {
        const { db } = openDb(':memory:');
        const bothId = insertNote(db, { path: 'Both.md', mtime: 1000 });
        const fulltextOnlyId = insertNote(db, { path: 'FulltextOnly.md', mtime: 1000 });
        insertFtsRow(db, bothId, 'Both', 'graph graph graph');
        insertFtsRow(db, fulltextOnlyId, 'FulltextOnly', 'graph graph graph graph graph');
        insertChunkWithVector(db, bothId, { seed: 0.5 });

        const results = await search(db, {
            query: 'graph',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        // fulltextOnlyId ranks #1 on the fulltext side alone (more term occurrences), but bothId
        // contributes RRF terms from *both* sides, which outweighs a single #1 vs. a #2 + a #1.
        expect(results[0].note_title).toBe('Both');
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/search.test.js`
Expected: FAIL — first test fails because `mode` defaults to `undefined`-handled-as-error (`mode
"undefined" is not yet implemented`); the other two fail with `mode "hybrid" is not yet implemented`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/search.js` — add after `toSemanticOutput`, and update `search()`:

```js
const RRF_K = 60;

function computeRrfScore(fulltextRank, semanticRank) {
    let score = 0;
    if (fulltextRank !== undefined) {
        score += 1 / (RRF_K + fulltextRank);
    }
    if (semanticRank !== undefined) {
        score += 1 / (RRF_K + semanticRank);
    }
    return score;
}

function mergeHybrid(fulltextResults, semanticResults, limit) {
    const fulltextRankById = new Map(fulltextResults.map((r) => [ r.noteId, r.rank ]));
    const semanticRankById = new Map(semanticResults.map((r) => [ r.noteId, r.rank ]));

    const byId = new Map();
    for (const r of [ ...fulltextResults, ...semanticResults ]) {
        if (!byId.has(r.noteId)) {
            byId.set(r.noteId, r);
        }
    }

    const merged = [ ...byId.values() ].map((r) => {
        const fulltextRank = fulltextRankById.get(r.noteId);
        const semanticRank = semanticRankById.get(r.noteId);
        return {
            noteTitle: r.noteTitle,
            fileLineCount: r.fileLineCount,
            mtime: r.mtime,
            fulltextRank: fulltextRank ?? null,
            semanticRank: semanticRank ?? null,
            score: computeRrfScore(fulltextRank, semanticRank),
        };
    });

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
}

function toHybridOutput(results) {
    return results.map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
        fulltext_rank: r.fulltextRank,
        semantic_rank: r.semanticRank,
    }));
}

export async function search(db, options = {}) {
    const { query, mode = 'hybrid', limit = DEFAULT_LIMIT } = options;
    validateQuery(query);

    if (mode === 'fulltext') {
        return toFulltextOutput(fulltextSearch(db, query, limit), limit);
    }
    if (mode === 'semantic') {
        return toSemanticOutput(await semanticSearch(db, query, limit, options), limit);
    }
    if (mode === 'hybrid') {
        const fulltextResults = fulltextSearch(db, query, limit);
        const semanticResults = await semanticSearch(db, query, limit, options);
        return toHybridOutput(mergeHybrid(fulltextResults, semanticResults, limit));
    }

    throw new Error(`search: unknown mode "${mode}"`);
}
```

Note the final `throw` message changes from "not yet implemented" to "unknown mode" — all three
documented modes are implemented as of this task, so an unrecognized `mode` string is now a genuine
caller error, not a placeholder.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/search.test.js`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add src/core/search.js src/core/search.test.js
git commit -m "feat(search): implement hybrid mode with RRF merge (default)"
```

---

### Task 4: `mtime` tie-breaking and `limit` validation

**Files:**
- Modify: `src/core/search.js`
- Modify: `src/core/search.test.js`

**Interfaces:**
- Consumes: `fulltextSearch`, `semanticSearch`, `mergeHybrid` (Tasks 1–3) — this task only changes
  their internal sort comparators and adds a validation call in `search()`, no new query shapes.
- Produces: every mode now breaks exact score/distance ties by `notes.mtime` descending (S002
  "Tie-breaking"); `limit` outside `[1, 100]` or non-integer now throws (S002 Input: `?limit<int>=20>`
  max `100`).

- [ ] **Step 1: Write the failing tests**

Add to `src/core/search.test.js`:

```js
describe('search: tie-breaking by mtime', () => {
    it('breaks an exact BM25 tie by mtime descending (fulltext mode)', async () => {
        const { db } = openDb(':memory:');
        const olderId = insertNote(db, { path: 'Older.md', mtime: 1000 });
        const newerId = insertNote(db, { path: 'Newer.md', mtime: 2000 });
        insertFtsRow(db, olderId, 'Older', 'shared term shared term');
        insertFtsRow(db, newerId, 'Newer', 'shared term shared term');

        const results = await search(db, { query: 'shared term', mode: 'fulltext', limit: 20 });

        expect(results.map((r) => r.note_title)).toEqual([ 'Newer', 'Older' ]);
        db.close();
    });

    it('breaks an exact cosine-distance tie by mtime descending (semantic mode)', async () => {
        const { db } = openDb(':memory:');
        const olderId = insertNote(db, { path: 'Older.md', mtime: 1000 });
        const newerId = insertNote(db, { path: 'Newer.md', mtime: 2000 });
        insertChunkWithVector(db, olderId, { seed: 0.5 });
        insertChunkWithVector(db, newerId, { seed: 0.5 });

        const results = await search(db, {
            query: 'anything',
            mode: 'semantic',
            limit: 20,
            embed: fakeEmbed(0.5),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results.map((r) => r.note_title)).toEqual([ 'Newer', 'Older' ]);
        db.close();
    });

    it('breaks an exact RRF score tie by mtime descending (hybrid mode)', async () => {
        const { db } = openDb(':memory:');
        const olderId = insertNote(db, { path: 'Older.md', mtime: 1000 });
        const newerId = insertNote(db, { path: 'Newer.md', mtime: 2000 });
        insertFtsRow(db, olderId, 'Older', 'shared term');
        insertFtsRow(db, newerId, 'Newer', 'shared term');

        const results = await search(db, {
            query: 'shared term',
            mode: 'hybrid',
            limit: 20,
            embed: fakeEmbed(0.1),
            embeddingModel: 'test-model',
            embeddingVersion: 'v1',
        });

        expect(results.map((r) => r.note_title)).toEqual([ 'Newer', 'Older' ]);
        db.close();
    });
});

describe('search: limit validation', () => {
    it.each([
        [ 0 ],
        [ -1 ],
        [ 101 ],
        [ 1.5 ],
    ])('rejects an out-of-range or non-integer limit (%j)', async (limit) => {
        const { db } = openDb(':memory:');
        await expect(search(db, { query: 'x', mode: 'fulltext', limit })).rejects.toThrow(/limit/);
        db.close();
    });

    it('accepts the boundary values 1 and 100', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md' });
        insertFtsRow(db, noteId, 'A', 'term');

        await expect(search(db, { query: 'term', mode: 'fulltext', limit: 1 })).resolves.not.toThrow();
        await expect(search(db, { query: 'term', mode: 'fulltext', limit: 100 })).resolves.not.toThrow();
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/search.test.js`
Expected: FAIL — the three tie-breaking tests fail because SQLite/vec0 return exact ties in an
unspecified (implementation-defined) order that this test suite doesn't control, so `Newer`/`Older`
ordering isn't guaranteed; the `limit validation` tests fail because out-of-range/non-integer `limit`
values are currently accepted without error.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/search.js`:

1. Add `MAX_LIMIT` and `validateLimit`, and call it from `search()`:

```js
const MAX_LIMIT = 100;

function validateLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`search: limit must be an integer between 1 and ${MAX_LIMIT}, got ${limit}`);
    }
}
```

In `search()`, add `validateLimit(limit);` immediately after `validateQuery(query);`.

2. In `fulltextSearch`, sort the rows before mapping (insert this line before the existing
   `return rows.map(...)`):

```js
    rows.sort((a, b) => a.score - b.score || b.mtime - a.mtime);
```

3. In `semanticSearch`, replace the tail (from `return [...bestDistanceByNote.entries()]...` onward)
   with:

```js
    const collapsed = [ ...bestDistanceByNote.entries() ].map(([ noteId, distance ]) => {
        const note = notesById.get(noteId);
        return {
            noteId,
            noteTitle: pathToTitle(note.path),
            fileLineCount: note.file_line_count,
            mtime: note.mtime,
            distance,
        };
    });

    collapsed.sort((a, b) => a.distance - b.distance || b.mtime - a.mtime);

    return collapsed.map((row, index) => ({ ...row, rank: index + 1 }));
```

4. In `mergeHybrid`, change the sort comparator:

```js
    merged.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/search.test.js`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add src/core/search.js src/core/search.test.js
git commit -m "feat(search): add mtime tie-breaking and limit validation"
```

---

### Task 5: Malformed FTS5 syntax is a hard error

**Files:**
- Modify: `src/core/search.js`
- Modify: `src/core/search.test.js`

**Interfaces:**
- Consumes: `fulltextSearch` (Task 1) — `hybrid` mode calls the same function, so wrapping its query
  in this task covers both `fulltext` and `hybrid` mode's malformed-query behavior with one change
  (S002 "A malformed FTS5 expression is a hard tool error in both fulltext and hybrid mode").
- Produces: a descriptive thrown error (not a raw `node:sqlite`/FTS5 error message) on invalid FTS5
  syntax, in both modes that touch `notes_fts`. `semantic` mode is unaffected — it never queries
  `notes_fts` at all.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/search.test.js`:

```js
describe('search: malformed FTS5 query', () => {
    it('throws a descriptive error for invalid FTS5 syntax in fulltext mode', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, { query: '"unterminated phrase', mode: 'fulltext', limit: 20 }),
        ).rejects.toThrow(/malformed/i);
        db.close();
    });

    it('throws the same descriptive error for invalid FTS5 syntax in hybrid mode', async () => {
        const { db } = openDb(':memory:');
        await expect(
            search(db, {
                query: '"unterminated phrase',
                mode: 'hybrid',
                limit: 20,
                embed: fakeEmbed(0.1),
                embeddingModel: 'test-model',
                embeddingVersion: 'v1',
            }),
        ).rejects.toThrow(/malformed/i);
        db.close();
    });

    it('does not raise a fulltext-syntax error in semantic mode (fts5 side unused)', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md' });
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        await expect(
            search(db, {
                query: '"unterminated phrase',
                mode: 'semantic',
                limit: 20,
                embed: fakeEmbed(0.5),
                embeddingModel: 'test-model',
                embeddingVersion: 'v1',
            }),
        ).resolves.not.toThrow();
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/search.test.js`
Expected: FAIL — the first two tests fail because the raw error propagating out of
`node:sqlite`/FTS5 (e.g. `fts5: syntax error near "..."`) does not match `/malformed/i`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/search.js` — wrap `fulltextSearch`'s query in a `try`/`catch`:

```js
function fulltextSearch(db, query, limit) {
    let rows;
    try {
        rows = db.prepare(`
            SELECT n.id AS note_id, n.path, n.line_count AS file_line_count, n.mtime,
                   bm25(notes_fts) AS score
            FROM notes_fts
            JOIN notes n ON n.id = notes_fts.rowid
            WHERE notes_fts MATCH ?
            ORDER BY bm25(notes_fts)
            LIMIT ?
        `).all(query, computeOverfetch(limit));
    } catch (err) {
        throw new Error(`search: malformed fulltext query "${query}": ${err.message}`);
    }

    rows.sort((a, b) => a.score - b.score || b.mtime - a.mtime);

    return rows.map((row, index) => ({
        noteId: row.note_id,
        noteTitle: pathToTitle(row.path),
        fileLineCount: row.file_line_count,
        mtime: row.mtime,
        rank: index + 1,
    }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/search.test.js`
Expected: PASS (full suite)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/search.js src/core/search.test.js
git commit -m "feat(search): fail loudly on malformed FTS5 syntax"
```

---

## Self-Review Notes

- **Spec coverage**: all three modes (`fulltext`, `semantic`, `hybrid`/default), the over-fetch rule
  (`min(limit × 5, 500)`) on both retrieval sides, best-chunk-wins collapse, `(embedding_model,
  embedding_version)` filtering (stale chunks silently excluded, not surfaced), RRF merge (`k = 60`,
  no implicit zero-rank term for an absent side), `notes.mtime` descending tie-break in every mode,
  the `note_title`/`file_line_count`/`fulltext_rank`/`semantic_rank` output shape, `limit` bounds
  (`1`–`100`, default `20`), and malformed-FTS5-as-hard-error in both modes touching `notes_fts` are
  each covered by a task and a test.
- **Explicitly out of scope** (per S002's own "Explicitly out of scope" section and this plan's
  framing): the chunking algorithm and embedding pipeline internals (S005 — `embed` is an injected
  fake here, never a real model call); the `--explain` CLI flag for surfacing raw scores (S006); MCP
  tool description text documenting mode-dependent FTS5 DSL availability (S007). This plan also does
  not touch `config.toml` — `limit` bounds, over-fetch tunables, and RRF `k` are hardcoded module
  constants pending S009, exactly as the spec flags them.
- **Known, deliberate duplication**: `pathToTitle` in `search.js` re-implements the
  path-to-title derivation S001 assigns to `core/notes.js` (S003), which isn't built yet. S002's spec
  header lists only S001 as a dependency, so this plan treats the duplication as acceptable for now —
  follow-up work (not part of this plan) should have S003 export the canonical version and update
  `search.js` to import it instead of keeping its own copy.
- **Placeholder scan**: no TODOs/TBDs left in any code block; every step has complete, runnable code
  (Task 2's test block calls out one intentional copy-paste slip to fix inline — a duplicate
  `insertNote` call — rather than silently "fixing" it, since catching that kind of mistake before
  running is part of the TDD step itself).
- **Type consistency**: `search(db, options) -> Promise<Array<object>>` is the same signature from
  Task 1 through Task 5; `options.mode` defaults to `undefined` (require explicit mode) through
  Task 2, then to `'hybrid'` starting Task 3, documented at the point it changes. Internal per-note
  result objects (`noteId`, `noteTitle`, `fileLineCount`, `mtime`, plus mode-specific `rank`/
  `distance`/`score`/`fulltextRank`/`semanticRank`) are consistently shaped across `fulltextSearch`,
  `semanticSearch`, and `mergeHybrid`'s output, and only ever narrowed to the public snake_case shape
  at the very end by a `toXOutput` function — never earlier, and never inline in `search()` itself.
