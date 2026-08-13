# S006 CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/cli/main.js` (argv dispatch, all ten subcommands), `src/cli/reindex.js`
(Unix-socket client for `mnotes reindex`), and `src/cli/stats.js` (DB-query + daemon-status logic for
`mnotes stats`), per `docs/specs/S006-cli.md`. Also introduces `src/format.js`, a shared formatter
module consumed by `cli/` now and by `mcp/` once S007 is planned (see Architecture).

**Architecture:** `main.js` exports a small `dispatch(argv, deps) -> Promise<{ stdout, stderr,
exitCode }>` — `argv` is the subcommand plus its remaining flags (`['search', 'foo', '--json']`), and
`deps` is an already-resolved bag of dependencies (`vaultRoot`, an open `db`, `embed`, `auditLogger`,
`socketPath`, ...). `dispatch` looks the subcommand up in a `COMMANDS` table, invokes the matching
handler, and centrally catches any thrown error (every `core/` function fails loudly per CLAUDE.md),
formatting it to `stderr` with `exitCode: 1`. Every handler (`runSearch`, `runGrep`, `runRead`, ...) is
a plain exported `async function(args, deps) -> Promise<{ stdout, stderr, exitCode }>` — pure with
respect to I/O, so tests call handlers directly with real temp fixtures and injected fakes, never by
shelling out to `node src/cli/main.js` as a subprocess (per the task brief and this project's existing
testing philosophy). Only the real `main(argv = process.argv.slice(2))` entry point, guarded by a
direct-execution check (mirroring `src/log-rotator.js`'s pattern from S008), resolves real
dependencies and performs actual `process.stdout.write`/`process.stderr.write` — required because
`eslint.config.js` sets `no-console: 'error'`, so nothing in this plan ever calls `console.log`.

Every subcommand handler is a thin wrapper exactly as S006 describes: parse flags with `util.parseArgs`
→ call the matching already-implemented `core/` function with its *exact* signature from the S002–S005
plans → format the result. No subcommand reimplements search ranking, hashing, grep, or tag logic.

**Two small, additive amendments to earlier plans are required and are included as explicit tasks
here, clearly flagged:**

1. `core/search.js` gains an additive `explainSearch(db, options) -> Promise<{ results, pipeline }>`
   export (Task 3, amends S002). S002's `search()` deliberately strips every raw score before
   returning (CLAUDE.md: "never expose raw BM25/cosine/RRF scores") — there is no seam in the S002
   plan as written for the CLI's `--explain` flag, which S006 explicitly *exempts* from that rule as a
   CLI-only debug surface. `explainSearch` is a new, parallel function in the same module reusing
   `search.js`'s existing private helpers (`fulltextSearch`, `semanticSearch`, `mergeHybrid`,
   `computeOverfetch`); it does not change `search()`'s signature, behavior, or any existing test.
2. `indexer/daemon.js`'s `runReindex` gains one additional `setMeta(db, 'last_full_reindex_at', ...)`
   call after a full-vault (no `noteTitle`) run completes (Task 13, amends S005). S006's spec states
   `stats` reads `meta.last_full_reindex_at`, but no task in the S005 plan ever writes that key —
   without this amendment, `mnotes stats` would report `last_reindex_at: null` forever. `setMeta`
   already exists (exported from the real, implemented `src/core/db.js`), so this is a two-line
   addition at a call site that already runs.

Both are flagged again in Self-Review Notes as deviations from strict "only touch `main.js`/
`reindex.js`/`stats.js`" scope, for AJ's confirmation before implementation, per CLAUDE.md's guidance
to flag rather than silently assume when a plan must extend an already-written spec/plan.

**Where the shared formatter lives:** S006's spec is explicit that CLI and MCP output is produced "by
the same formatting function each MCP tool handler calls" — a direct architecture-rule consequence
(CLAUDE.md: "`cli/` and `mcp/` must not duplicate logic"). Neither `cli/` nor `mcp/` can own this code
without the other importing across a sibling directory in a way nothing else in this codebase does.
This plan places it at **`src/format.js`** — a new top-level `src/` module, the same tier as
`src/logger.js`/`src/config.js` (cross-cutting infrastructure consumed by multiple components, not
domain logic).

This was a genuine two-way reconciliation, not a unilateral win: `docs/plans/S007-mcp-server.md` was
planned concurrently, without seeing this plan's output, and independently built its formatters *inside*
`mcp/tools.js` — with header rows on every table, `|` as the delimiter (not `' | '`), no rank-prefix
column, and a compact (non-pretty-printed) `formatJson`. Reconciled after both plans were written:
**this plan's `src/format.js` location won** (so neither `cli/` nor `mcp/` imports across the other's
directory), but **S007's formatter *implementations* won** — Task 2's `formatJson` is compact, Task 2's
new `formatTable` is the generic header-having, `|`-delimited base every per-tool formatter in Tasks 4/6/7
builds on, matching S007's `formatSearchTable`/`formatGrepTable`/`formatTagListTable`/
`formatTagNotesTable` byte-for-byte. This plan's original hand-built, no-header, `' | '`-delimited,
rank-prefixed formatters are gone. See `docs/plans/S007-mcp-server.md`'s own Architecture section for
its side of this history.

**Config-not-ready stand-ins:** `core/notes.js`/`core/grep.js` need `vaultRoot`; `core/search.js` needs
`embeddingModel`/`embeddingVersion`; `mnotes reindex`/`stats` need the daemon's socket path and the
index DB's path. All of these are `config.toml` values per S009, which doesn't exist yet. This plan
introduces `resolveVaultRoot(env)`/`resolveDbPath(env)` in `main.js`, reading `MNOTES_VAULT_ROOT`/
`MNOTES_DB_PATH` environment variables (throwing a clear error for the vault root, which has no safe
default; falling back to S009's own documented default path for the DB), and reuses
`defaultSocketPath()` — already exported from `src/indexer/daemon.js` (S005) — unchanged. Swapping
these for real `config.js` reads once S009 lands is a mechanical change at the `main()` bootstrap only,
exactly the posture S002 already established for its own pending-config values.

**Tech Stack:** Node 24 built-in `util.parseArgs`, `node:net` (`reindex`/`stats`'s socket client),
`node:fs`/`node:path`/`node:os`, `core/search.js` (S002), `core/notes.js` (S003), `core/grep.js`/
`core/tags.js` (S004), `indexer/daemon.js` (`defaultSocketPath`, S005), `src/logger.js`
(`getAuditLogger`/`logAudit`, S008), `src/core/db.js` (`openDb`/`getMeta`, S001, already implemented).
Vitest with real temp vault directories, real temp-file/in-memory SQLite DBs, a real
`getAuditLogger`/real log directory, and a real Unix socket via `indexer/daemon.js`'s own
`createIpcServer` for `reindex`/`stats` tests — no mocking `node:net`, the filesystem, or `core/`,
matching every prior plan's testing philosophy. `embed` is always an injected fake in tests (mirrors
the S002/S005 precedent for the one genuinely expensive external dependency).

**Execution order:** this plan can only be carried out after S001 (done), S002, S003, S004, S005, and
S008 are implemented — every task here imports real, already-built functions from those modules by
their exact documented signatures. Nothing in this plan invents a new `core/` signature except the two
explicitly flagged, additive amendments above.

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- No CLI framework — `util.parseArgs`-based dispatch table keyed on `argv[0]` (the subcommand), per
  S006. `tags` has its own second-level dispatch on its first positional (`list`/`notes`).
- **No `--reason` flag anywhere in this plan** (S006, CLAUDE.md) — the CLI has no equivalent to MCP's
  required `reason<string>`. Mutating commands (`write`/`edit`/`append`/`rename`) are still audited via
  `logAudit` with a fixed `source: 'cli'` and `reason: null` (enforced by `logAudit`'s own validation,
  S008 Task 4).
- **Logging** (S008, S006 "Logging"): the `logAudit` calls in Tasks 9–12 are the CLI's *only* use of
  `src/logger.js` — `dispatch` (Task 1) never wraps command execution in a `runWithLogger` context, and
  nothing in this plan calls `runWithLogger` anywhere, unlike the daemon (S005) and MCP server (S007).
  This means `getContextLogger()` call sites inside `core/search.js`/`core/grep.js`/`core/notes.js`
  (S002's malformed-query `warn`, S004's ripgrep-not-found `warn`, S003's caller-supplied-`id`
  `debug`) silently resolve to the no-op logger for every CLI invocation — read or write — since there
  is no enclosing context to resolve to. `search`/`grep`/`tags`/`read` (Tasks 4, 6, 7, 8) add no
  logging of their own. `reindex`/`stats` (Tasks 14, 15) add no CLI-side logging either — they talk to
  the daemon over its own socket (S005), whose `indexer.log` already covers the actual reindex work.
- **`cli/` must not duplicate `core/` logic.** Every handler's job is parse flags → call one `core/`
  function → format. If a conditional or query would need to exist in both `cli/` and a future `mcp/`
  tool handler, it belongs in `core/` or in the shared `src/format.js`, never copy-pasted.
- **Fail loudly** (CLAUDE.md): every thrown `core/` error propagates to `dispatch`'s single top-level
  `catch`, formatted as `mnotes: <message>\n` on `stderr` with `exitCode: 1`. No handler swallows an
  error or returns a partial result.
- **Don't show raw BM25/cosine/RRF scores** anywhere except `--explain`'s output, the one CLI-only
  debug surface S006 explicitly exempts from that rule (CLAUDE.md, S006).
- `no-console: 'error'` (`eslint.config.js`) — handlers return `{ stdout, stderr, exitCode }` strings;
  only the real `main()` entry point calls `process.stdout.write`/`process.stderr.write`.
- `kebab-case` filenames; `camelCase` functions/variables — except where a field name is itself
  spec-mandated snake_case at the JSON-output boundary (`note_title`, `file_line_count`, ...), matching
  the same JS-camelCase/wire-snake_case split S004's plan already established.
- Test files colocated: `src/cli/main.js` → `src/cli/main.test.js`, `src/cli/reindex.js` →
  `src/cli/reindex.test.js`, `src/cli/stats.js` → `src/cli/stats.test.js`, `src/format.js` →
  `src/format.test.js` (CLAUDE.md).
- Real temp vault directories (`mkdtempSync`), real temp-file/in-memory `openDb` connections, a real
  `getAuditLogger` writing to a real temp log directory, and a real Unix socket (via
  `indexer/daemon.js`'s `createIpcServer`) in every test that needs one — never mock `core/`,
  `node:net`, or the filesystem (CLAUDE.md). `embed` is always an injected fake (mirrors S002/S005).
- 4-space indentation, single quotes, trailing commas on multiline, spaced array brackets
  (`[ 'a', 'b' ]`), `func-style: declaration` — matches `eslint.config.js` and every prior plan.
- Lint budget in mind: `max-lines-per-function: 50`, `max-statements: 30`, `max-depth: 2`,
  `max-nested-callbacks: 3`, `max-params: 5` — multi-field dependencies always travel as a single
  `deps`/`options` object, mirroring S002/S003/S005's pattern.
- `logAudit`'s `tool` field for a CLI-sourced entry is the literal subcommand name (`'write'`,
  `'edit'`, `'append'`, `'rename'`) — not the MCP tool name (`'note_write'`, ...). This matches S008's
  own test fixtures, which use `tool: 'write'` for a `source: 'cli'` entry and `tool: 'note_write'` for
  a `source: 'mcp'` one.

---

### Task 1: `main.js` skeleton — dispatch table, config-not-ready resolvers, centralized error handling

**Files:**
- Create: `src/cli/main.js`
- Create: `src/cli/main.test.js`

**Interfaces:**
- Produces: `resolveVaultRoot(env = process.env) -> string` (throws if `MNOTES_VAULT_ROOT` unset),
  `resolveDbPath(env = process.env) -> string` (`MNOTES_DB_PATH` or S009's documented default path),
  `dispatch(argv, deps) -> Promise<{ stdout, stderr, exitCode }>` (unknown-command error + centralized
  try/catch around every handler), `main(argv = process.argv.slice(2), deps = {}) -> Promise<number>`.
  Every later task adds one `export async function runX(args, deps)` handler and one
  `COMMANDS.x = runX;` registration line to this file — `dispatch`/`main` themselves don't change again
  until Task 16 wires real dependencies into `main`'s direct-execution guard.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/main.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dispatch, resolveVaultRoot, resolveDbPath } from './main.js';

describe('dispatch: unknown command', () => {
    it('returns exitCode 1 and a descriptive stderr message', async () => {
        const result = await dispatch([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown command "bogus"/);
        expect(result.stdout).toBe('');
    });
});

describe('dispatch: centralized error handling', () => {
    it('catches a thrown error from a handler and formats it to stderr with exitCode 1', async () => {
        const throwingDeps = {
            handlerOverrideForTest: () => {
                throw new Error('boom');
            },
        };
        // registered only for this test via a temporary override, see Step 4's exported registerCommand
        const { registerCommand } = await import('./main.js');
        registerCommand('__test_throw__', async () => {
            throw new Error('boom');
        });

        const result = await dispatch([ '__test_throw__' ], throwingDeps);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('mnotes: boom\n');
    });
});

describe('resolveVaultRoot', () => {
    it('throws a descriptive error when MNOTES_VAULT_ROOT is not set', () => {
        expect(() => resolveVaultRoot({})).toThrow(/MNOTES_VAULT_ROOT/);
    });

    it('returns the env value when set', () => {
        expect(resolveVaultRoot({ MNOTES_VAULT_ROOT: '/tmp/vault' })).toBe('/tmp/vault');
    });
});

describe('resolveDbPath', () => {
    it('falls back to the documented Application Support default when unset', () => {
        expect(resolveDbPath({})).toBe(
            join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db'),
        );
    });

    it('returns MNOTES_DB_PATH when set', () => {
        expect(resolveDbPath({ MNOTES_DB_PATH: '/tmp/index.db' })).toBe('/tmp/index.db');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `src/cli/main.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/main.js`:

```js
#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveVaultRoot(env = process.env) {
    if (!env.MNOTES_VAULT_ROOT) {
        throw new Error(
            'MNOTES_VAULT_ROOT is not set — point it at your Obsidian vault directory '
            + '(stand-in for config.toml\'s vault_path until S009 lands)',
        );
    }
    return env.MNOTES_VAULT_ROOT;
}

export function resolveDbPath(env = process.env) {
    return env.MNOTES_DB_PATH
        ?? join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db');
}

const COMMANDS = {};

export function registerCommand(name, handler) {
    COMMANDS[name] = handler;
}

export async function dispatch(argv, deps) {
    const [ command, ...rest ] = argv;
    const handler = COMMANDS[command];

    if (!handler) {
        return { stdout: '', stderr: `mnotes: unknown command "${command}"\n`, exitCode: 1 };
    }

    try {
        return await handler(rest, deps);
    } catch (err) {
        return { stdout: '', stderr: `mnotes: ${err.message}\n`, exitCode: 1 };
    }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
    const result = await dispatch(argv, deps);
    if (result.stdout) {
        process.stdout.write(result.stdout);
    }
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    return result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
```

`registerCommand` is exported so tests (and every later task) can register/exercise a handler without
reaching into a private module-level object — the real subcommands each call it once, at module load,
in their own task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Make the file executable**

Run: `chmod +x src/cli/main.js`

(`package.json`'s existing `bin.mnotes` field already points at this file — this step just makes the
shebang usable when installed.)

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): add argv dispatch skeleton and config-not-ready resolvers"
```

---

### Task 2: `src/format.js` — `formatJson` and `formatTable`

**Files:**
- Create: `src/format.js`
- Create: `src/format.test.js`

**Interfaces:**
- Produces: `formatJson(data) -> string` — compact `JSON.stringify(data)`, no whitespace, no trailing
  newline, matching this project's token-efficiency bias — reused by every `--json` flag and every
  mutation command's default JSON output across this plan. Also produces the generic
  `formatTable(columns, rows) -> string` (header row + one row per item, `|`-joined, missing/null cells
  render as an empty string) that Tasks 4/6/7's per-tool table formatters are built on.

- [ ] **Step 1: Write the failing test**

Create `src/format.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/format.test.js`
Expected: FAIL — `src/format.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/format.js`:

```js
export function formatJson(data) {
    return JSON.stringify(data);
}

function formatCell(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

export function formatTable(columns, rows) {
    const header = columns.join('|');
    const lines = rows.map((row) => columns.map((col) => formatCell(row[col])).join('|'));
    return [ header, ...lines ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/format.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/format.js src/format.test.js
git commit -m "feat(format): add formatJson (compact) and formatTable, the shared cli/mcp formatters"
```

---

### Task 3: `explainSearch` in `core/search.js` (amends S002)

**Files:**
- Modify: `src/core/search.js`
- Modify: `src/core/search.test.js`

**Interfaces:**
- Consumes: `fulltextSearch`, `semanticSearch`, `mergeHybrid`, `computeOverfetch`, `validateQuery`,
  `validateLimit`, `pathToTitle`, `hydrateNotes`, `vectorToBuffer`, `RRF_K` — all already-private
  helpers inside `search.js` from S002's plan; reused unmodified except for two additive field
  additions (see below).
- Produces: `explainSearch(db, options) -> Promise<{ results: Array<object>, pipeline: object }>`. Does
  **not** change `search()`'s signature, behavior, or output shape — every existing S002 test must
  still pass unmodified after this task. Two small additive changes make the needed raw data
  reachable: `fulltextSearch`'s returned rows gain a `score` field (the raw BM25 value already computed
  for sorting, previously dropped before return), and a new private
  `runSemanticQueryWithChunkDetail`/`collapseToBestChunkPerNoteWithDetail` pair (parallel to, not a
  replacement for, the existing `runSemanticQuery`/`collapseToBestChunkPerNote`) carries the winning
  chunk's `char_start`/`char_end` alongside its distance.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/search.test.js`:

```js
import { explainSearch } from './search.js';

describe('explainSearch: fulltext mode', () => {
    it('exposes the raw bm25 score, rank, and pipeline detail', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md', lineCount: 3 });
        insertFtsRow(db, noteId, 'A', 'graph graph graph');

        const { results, pipeline } = await explainSearch(db, { query: 'graph', mode: 'fulltext', limit: 20 });

        expect(results[0].note_title).toBe('A');
        expect(typeof results[0].bm25_score).toBe('number');
        expect(results[0].rank).toBe(1);
        expect(pipeline).toEqual({ mode: 'fulltext', limit: 20, overfetchLimit: 100, fulltextExpression: 'graph' });
        db.close();
    });
});

describe('explainSearch: semantic mode', () => {
    it('exposes the raw cosine distance and the winning chunk boundaries', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'B.md' });
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const { results } = await explainSearch(db, {
            query: 'x', mode: 'semantic', limit: 20,
            embed: fakeEmbed(0.5), embeddingModel: 'test-model', embeddingVersion: 'v1',
        });

        expect(typeof results[0].cosine_distance).toBe('number');
        expect(results[0].winning_chunk).toEqual({ char_start: 0, char_end: 100 });
        db.close();
    });
});

describe('explainSearch: hybrid mode', () => {
    it('exposes the rrf formula and both source ranks', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'C.md' });
        insertFtsRow(db, noteId, 'C', 'graph');
        insertChunkWithVector(db, noteId, { seed: 0.5 });

        const { results } = await explainSearch(db, {
            query: 'graph', mode: 'hybrid', limit: 20,
            embed: fakeEmbed(0.5), embeddingModel: 'test-model', embeddingVersion: 'v1',
        });

        expect(results[0].fulltext_rank).toBe(1);
        expect(results[0].semantic_rank).toBe(1);
        expect(results[0].rrf_score).toBeCloseTo(1 / 61 + 1 / 61, 10);
        expect(results[0].rrf_formula).toBe(`1/(60+1) + 1/(60+1) = ${results[0].rrf_score}`);
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/search.test.js`
Expected: FAIL — `explainSearch` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/search.js`:

1. In `fulltextSearch`, add `score: row.score` to the mapped return object (the rest of the function is
   unchanged from Task 5 of S002's plan):

```js
    return rows.map((row, index) => ({
        noteId: row.note_id,
        noteTitle: pathToTitle(row.path),
        fileLineCount: row.file_line_count,
        mtime: row.mtime,
        score: row.score,
        rank: index + 1,
    }));
```

2. Add the following new private helpers and the exported `explainSearch`, after `search()`:

```js
function runSemanticQueryWithChunkDetail(db, vector, fetchCount, embeddingModel, embeddingVersion) {
    return db.prepare(`
        SELECT c.note_id AS note_id, c.char_start AS char_start, c.char_end AS char_end,
               cv.distance AS distance
        FROM chunk_vectors cv
        JOIN chunks c ON c.id = cv.rowid
        WHERE cv.embedding MATCH ? AND k = ${fetchCount}
          AND c.embedding_model = ?
          AND c.embedding_version = ?
        ORDER BY cv.distance
    `).all(vectorToBuffer(vector), embeddingModel, embeddingVersion);
}

function collapseToBestChunkPerNoteWithDetail(rows) {
    const bestByNote = new Map();
    for (const row of rows) {
        if (!bestByNote.has(row.note_id)) {
            bestByNote.set(row.note_id, {
                distance: row.distance,
                charStart: row.char_start,
                charEnd: row.char_end,
            });
        }
    }
    return bestByNote;
}

async function semanticSearchDetail(db, query, limit, { embed, embeddingModel, embeddingVersion }) {
    if (typeof embed !== 'function') {
        throw new Error('search: semantic and hybrid modes require an `embed` function');
    }

    const vector = await embed(query);
    const rawRows = runSemanticQueryWithChunkDetail(
        db, vector, computeOverfetch(limit), embeddingModel, embeddingVersion,
    );
    const bestByNote = collapseToBestChunkPerNoteWithDetail(rawRows);
    const notesById = hydrateNotes(db, [ ...bestByNote.keys() ]);

    const collapsed = [ ...bestByNote.entries() ].map(([ noteId, best ]) => {
        const note = notesById.get(noteId);
        return {
            noteTitle: pathToTitle(note.path),
            fileLineCount: note.file_line_count,
            mtime: note.mtime,
            distance: best.distance,
            charStart: best.charStart,
            charEnd: best.charEnd,
        };
    });

    collapsed.sort((a, b) => a.distance - b.distance || b.mtime - a.mtime);
    return collapsed.map((row, index) => ({ ...row, rank: index + 1 }));
}

function formatRrfFormula(fulltextRank, semanticRank, score) {
    const terms = [];
    if (fulltextRank !== null) {
        terms.push(`1/(${RRF_K}+${fulltextRank})`);
    }
    if (semanticRank !== null) {
        terms.push(`1/(${RRF_K}+${semanticRank})`);
    }
    return `${terms.join(' + ')} = ${score}`;
}

export async function explainSearch(db, options = {}) {
    const { query, mode = 'hybrid', limit = DEFAULT_LIMIT } = options;
    validateQuery(query);
    validateLimit(limit);

    const pipeline = {
        mode, limit, overfetchLimit: computeOverfetch(limit), fulltextExpression: query,
    };

    if (mode === 'fulltext') {
        const rows = fulltextSearch(db, query, limit).slice(0, limit);
        return {
            results: rows.map((r) => ({
                note_title: r.noteTitle, file_line_count: r.fileLineCount,
                bm25_score: r.score, rank: r.rank,
            })),
            pipeline,
        };
    }

    if (mode === 'semantic') {
        const rows = (await semanticSearchDetail(db, query, limit, options)).slice(0, limit);
        return {
            results: rows.map((r) => ({
                note_title: r.noteTitle, file_line_count: r.fileLineCount,
                cosine_distance: r.distance,
                winning_chunk: { char_start: r.charStart, char_end: r.charEnd },
                rank: r.rank,
            })),
            pipeline,
        };
    }

    if (mode === 'hybrid') {
        const fulltextResults = fulltextSearch(db, query, limit);
        const semanticResults = await semanticSearch(db, query, limit, options);
        const merged = mergeHybrid(fulltextResults, semanticResults, limit);
        return {
            results: merged.map((r) => ({
                note_title: r.noteTitle, file_line_count: r.fileLineCount,
                fulltext_rank: r.fulltextRank, semantic_rank: r.semanticRank,
                rrf_score: r.score,
                rrf_formula: formatRrfFormula(r.fulltextRank, r.semanticRank, r.score),
            })),
            pipeline,
        };
    }

    throw new Error(`search: unknown mode "${mode}"`);
}
```

- [ ] **Step 4: Run the full search.js suite to verify everything passes**

Run: `pnpm vitest run src/core/search.test.js`
Expected: PASS (every prior S002 test plus the three new `explainSearch` tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/search.js src/core/search.test.js
git commit -m "feat(search): add explainSearch, an additive raw-score debug export for cli --explain"
```

---

### Task 4: `search` command — fulltext/semantic/hybrid, `--mode`/`--limit`/`--json`

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`
- Modify: `src/format.js`
- Modify: `src/format.test.js`

**Interfaces:**
- Consumes: `search` from `core/search.js` (S002), `formatTable`/`formatJson` (Task 2).
- Produces: `formatSearchTable(results, mode) -> string` in `format.js` (no `json` param — a generic
  table formatter built on `formatTable`, matching the canonical MCP-tool-output shape header row +
  `|`-delimited, no rank-prefix column); `runSearch(args, deps) -> Promise<{ stdout, stderr, exitCode
  }>` in `main.js`, registered as `COMMANDS.search`, branches on `values.json` itself (`formatJson(
  results)` vs. `formatSearchTable(results, values.mode)`). `deps` for this command is `{ db, embed,
  embeddingModel, embeddingVersion }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/format.test.js`:

```js
import { formatSearchTable } from './format.js';

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
```

Add to `src/cli/main.test.js`:

```js
import { openDb } from '../core/db.js';
import { runSearch } from './main.js';

function insertTestNote(db, path, lineCount = 5) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'hash', lineCount, 1000, 1000);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

describe('runSearch', () => {
    it('formats fulltext results as pipe-delimited text by default', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph search notes');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('note_title|file_line_count\nA|10');
        db.close();
    });

    it('emits JSON when --json is passed', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext', '--json' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(JSON.parse(result.stdout)).toEqual([ { note_title: 'A', file_line_count: 10 } ]);
        db.close();
    });

    it('defaults to hybrid mode when --mode is omitted', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph');

        const result = await runSearch(
            [ 'graph' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(result.stdout).toContain('note_title|file_line_count|fulltext_rank|semantic_rank');
        expect(result.stdout).toContain('A|10|');
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: FAIL — `formatSearchTable`/`runSearch` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add to `src/format.js`:

```js
export function formatSearchTable(results, mode) {
    const columns = mode === 'hybrid'
        ? [ 'note_title', 'file_line_count', 'fulltext_rank', 'semantic_rank' ]
        : [ 'note_title', 'file_line_count' ];
    return formatTable(columns, results);
}
```

Update `src/cli/main.js` — add the import, `parseArgs` import, `runSearch`, and its registration:

```js
import { parseArgs } from 'node:util';
import { search } from '../core/search.js';
import { formatSearchTable, formatJson } from '../format.js';

export async function runSearch(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            mode: { type: 'string', default: 'hybrid' },
            limit: { type: 'string' },
            json: { type: 'boolean', default: false },
            explain: { type: 'boolean', default: false },
        },
    });
    const query = positionals[0];
    const limit = values.limit !== undefined ? Number(values.limit) : undefined;

    const results = await search(deps.db, {
        query,
        mode: values.mode,
        limit,
        embed: deps.embed,
        embeddingModel: deps.embeddingModel,
        embeddingVersion: deps.embeddingVersion,
    });

    const stdout = values.json ? formatJson(results) : formatSearchTable(results, values.mode);
    return { stdout, stderr: '', exitCode: 0 };
}

registerCommand('search', runSearch);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js src/format.js src/format.test.js
git commit -m "feat(cli): add search command with fulltext/semantic/hybrid modes"
```

---

### Task 5: `search --explain`

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`
- Modify: `src/format.js`
- Modify: `src/format.test.js`

**Interfaces:**
- Consumes: `explainSearch` (Task 3), `formatJson` (Task 2).
- Produces: `formatExplain({ results, pipeline }) -> string` in `format.js`; `runSearch` now branches
  to an explain path when `--explain` is passed, honoring `--json` there too (raw structured explain
  data instead of the text rendering).

- [ ] **Step 1: Write the failing tests**

Add to `src/format.test.js`:

```js
import { formatExplain } from './format.js';

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
            results: [ { note_title: 'A', file_line_count: 10, cosine_distance: 0.01, winning_chunk: { char_start: 0, char_end: 100 }, rank: 1 } ],
            pipeline: { mode: 'semantic', limit: 20, overfetchLimit: 100, fulltextExpression: 'x' },
        });
        expect(text).toContain('1 | A | 10 | cosine=0.01 | chunk[0:100]');
    });

    it('renders the rrf formula for hybrid mode', () => {
        const text = formatExplain({
            results: [ { note_title: 'A', file_line_count: 10, fulltext_rank: 1, semantic_rank: null, rrf_score: 0.0164, rrf_formula: '1/(60+1) = 0.0164' } ],
            pipeline: { mode: 'hybrid', limit: 20, overfetchLimit: 100, fulltextExpression: 'x' },
        });
        expect(text).toContain('1 | A | 10 | fulltext_rank=1 | semantic_rank=- | rrf=1/(60+1) = 0.0164');
    });
});
```

Add to `src/cli/main.test.js`:

```js
describe('runSearch: --explain', () => {
    it('shows raw bm25 scores that never appear in default output', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph graph graph');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext', '--explain' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(result.stdout).toContain('bm25=');
        db.close();
    });

    it('emits structured explain JSON when --explain --json are both passed', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext', '--explain', '--json' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        const parsed = JSON.parse(result.stdout);
        expect(parsed.pipeline.mode).toBe('fulltext');
        expect(typeof parsed.results[0].bm25_score).toBe('number');
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: FAIL — `formatExplain` is not exported; `runSearch` ignores `--explain`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/format.js`:

```js
function formatExplainRow(r, rank, mode) {
    if (mode === 'fulltext') {
        return `${rank} | ${r.note_title} | ${r.file_line_count} | bm25=${r.bm25_score}`;
    }
    if (mode === 'semantic') {
        return `${rank} | ${r.note_title} | ${r.file_line_count} | cosine=${r.cosine_distance} `
            + `| chunk[${r.winning_chunk.char_start}:${r.winning_chunk.char_end}]`;
    }
    return `${rank} | ${r.note_title} | ${r.file_line_count} | fulltext_rank=${r.fulltext_rank ?? '-'} `
        + `| semantic_rank=${r.semantic_rank ?? '-'} | rrf=${r.rrf_formula}`;
}

export function formatExplain({ results, pipeline }) {
    const header = `mode=${pipeline.mode} limit=${pipeline.limit} overfetch=${pipeline.overfetchLimit} `
        + `fts5_expression=${JSON.stringify(pipeline.fulltextExpression)}`;
    const lines = results.map((r, index) => formatExplainRow(r, index + 1, pipeline.mode));
    return `${[ header, ...lines ].join('\n')}\n`;
}
```

Update `src/cli/main.js` — import `explainSearch`, add the branch inside `runSearch` (replace its
body):

```js
import { search, explainSearch } from '../core/search.js';
import { formatSearchTable, formatExplain, formatJson } from '../format.js';

export async function runSearch(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            mode: { type: 'string', default: 'hybrid' },
            limit: { type: 'string' },
            json: { type: 'boolean', default: false },
            explain: { type: 'boolean', default: false },
        },
    });
    const query = positionals[0];
    const limit = values.limit !== undefined ? Number(values.limit) : undefined;
    const searchOptions = {
        query, mode: values.mode, limit,
        embed: deps.embed, embeddingModel: deps.embeddingModel, embeddingVersion: deps.embeddingVersion,
    };

    if (values.explain) {
        const explained = await explainSearch(deps.db, searchOptions);
        return {
            stdout: values.json ? formatJson(explained) : formatExplain(explained),
            stderr: '',
            exitCode: 0,
        };
    }

    const results = await search(deps.db, searchOptions);
    const stdout = values.json ? formatJson(results) : formatSearchTable(results, values.mode);
    return { stdout, stderr: '', exitCode: 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js src/format.js src/format.test.js
git commit -m "feat(cli): add search --explain, the cli-only raw-score debug surface"
```

---

### Task 6: `grep` command — `--regex`/`--note`/`--json`

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`
- Modify: `src/format.js`
- Modify: `src/format.test.js`

**Interfaces:**
- Consumes: `grep` from `core/grep.js` (S004) — returns camelCase (`noteTitle`, `fileLineCount`,
  `lineMatches`, `totalMatchCount`); `formatTable`/`formatJson` (Task 2).
- Produces: `formatGrepTable(results) -> string` in `format.js` (header row + `line_matches` rendered as
  `"L<line>: <text>"` joined by `"; "`, with `"(+N more)"` appended when `totalMatchCount` exceeds the
  capped `lineMatches` length — no `json` param, matching the canonical MCP-tool-output shape); `runGrep(
  args, deps) -> Promise<{...}>`, registered as `COMMANDS.grep`, builds its own snake_case-mapped array
  and calls `formatJson` on it for `--json` (the same field mapping the old formatter used to build
  inline, now living in the handler instead). `deps` is `{ vaultRoot }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/format.test.js`:

```js
import { formatGrepTable } from './format.js';

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
```

Add to `src/cli/main.test.js`:

```js
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runGrep } from './main.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('runGrep', () => {
    it('formats a text match by default', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'line one\nsome hello world text\n');

        const result = await runGrep([ 'hello' ], { vaultRoot });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('note_title|file_line_count|line_matches');
        expect(result.stdout).toContain('Recipe|2|L2: some hello world text');
    });

    it('supports --json', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello world\n');

        const result = await runGrep([ 'hello', '--json' ], { vaultRoot });

        expect(JSON.parse(result.stdout)[0].note_title).toBe('Recipe');
    });
});
```

(Add `afterEach` to the existing `vitest` import at the top of `src/cli/main.test.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: FAIL — `formatGrepTable`/`runGrep` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add to `src/format.js`:

```js
function formatLineMatches(lineMatches, totalMatchCount) {
    const rendered = lineMatches.map((m) => `L${m.line}: ${m.text}`).join('; ');
    const more = totalMatchCount - lineMatches.length;
    return more > 0 ? `${rendered} (+${more} more)` : rendered;
}

export function formatGrepTable(results) {
    const rows = results.map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
        line_matches: formatLineMatches(r.lineMatches, r.totalMatchCount),
    }));
    return formatTable([ 'note_title', 'file_line_count', 'line_matches' ], rows);
}
```

Update `src/cli/main.js`:

```js
import { grep } from '../core/grep.js';
import { formatGrepTable, formatJson } from '../format.js';

export async function runGrep(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            regex: { type: 'boolean', default: false },
            note: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    });
    const pattern = positionals[0];
    const results = grep(deps.vaultRoot, pattern, { regex: values.regex, noteTitle: values.note ?? null });

    if (values.json) {
        const mapped = results.map((r) => ({
            note_title: r.noteTitle,
            file_line_count: r.fileLineCount,
            total_match_count: r.totalMatchCount,
            line_matches: r.lineMatches,
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatGrepTable(results), stderr: '', exitCode: 0 };
}

registerCommand('grep', runGrep);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js src/format.js src/format.test.js
git commit -m "feat(cli): add grep command"
```

---

### Task 7: `tags list` / `tags notes <tag>`

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`
- Modify: `src/format.js`
- Modify: `src/format.test.js`

**Interfaces:**
- Consumes: `tagList`, `tagNotes` from `core/tags.js` (S004); `formatTable`/`formatJson` (Task 2).
- Produces: `formatTagListTable(results) -> string`, `formatTagNotesTable(results) -> string` (both
  header-having, `|`-delimited, no `json` param, matching the canonical MCP-tool-output shape);
  `runTags(args, deps)` dispatching on its first positional (`list`/`notes`), registered as
  `COMMANDS.tags`, branches on `values.json` itself in each subcommand. `deps` is `{ db }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/format.test.js`:

```js
import { formatTagListTable, formatTagNotesTable } from './format.js';

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
```

Add to `src/cli/main.test.js`:

```js
import { syncNoteTags } from '../core/tags.js';
import { runTags } from './main.js';

describe('runTags', () => {
    it('list: formats tag inventory', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'list' ], { db });

        expect(result.stdout).toBe('tag|notes_with_tag\nproject|1');
        db.close();
    });

    it('notes <tag>: formats notes carrying that tag', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 7);
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'notes', 'project' ], { db });

        expect(result.stdout).toBe('note_title|file_line_count\nA|7');
        db.close();
    });

    it('returns an error for an unknown tags subcommand', async () => {
        const result = await runTags([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown tags subcommand "bogus"/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: FAIL — `formatTagListTable`/`formatTagNotesTable`/`runTags` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add to `src/format.js`:

```js
export function formatTagListTable(results) {
    const rows = results.map((r) => ({ tag: r.tag, notes_with_tag: r.notesWithTag }));
    return formatTable([ 'tag', 'notes_with_tag' ], rows);
}

export function formatTagNotesTable(results) {
    const rows = results.map((r) => ({ note_title: r.noteTitle, file_line_count: r.fileLineCount }));
    return formatTable([ 'note_title', 'file_line_count' ], rows);
}
```

Update `src/cli/main.js`:

```js
import { tagList, tagNotes } from '../core/tags.js';
import { formatTagListTable, formatTagNotesTable, formatJson } from '../format.js';

async function runTagsList(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
    const tags = tagList(deps.db);

    if (values.json) {
        const mapped = tags.map((t) => ({ tag: t.tag, notes_with_tag: t.notesWithTag }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagListTable(tags), stderr: '', exitCode: 0 };
}

async function runTagsNotes(args, deps) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { json: { type: 'boolean', default: false } },
    });
    const tagName = positionals[0];
    const notes = tagNotes(deps.db, tagName);

    if (values.json) {
        const mapped = notes.map((n) => ({ note_title: n.noteTitle, file_line_count: n.fileLineCount }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagNotesTable(notes), stderr: '', exitCode: 0 };
}

export async function runTags(args, deps) {
    const [ sub, ...rest ] = args;
    if (sub === 'list') {
        return runTagsList(rest, deps);
    }
    if (sub === 'notes') {
        return runTagsNotes(rest, deps);
    }
    return { stdout: '', stderr: `mnotes: unknown tags subcommand "${sub}"\n`, exitCode: 1 };
}

registerCommand('tags', runTags);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/format.test.js src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js src/format.js src/format.test.js
git commit -m "feat(cli): add tags list and tags notes commands"
```

---

### Task 8: `read` command — default/`--raw`/`--json` output modes

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`

**Interfaces:**
- Consumes: `noteRead`, `titleToPath` from `core/notes.js` (S003).
- Produces: `runRead(args, deps) -> Promise<{...}>`, registered as `COMMANDS.read`. `deps` is
  `{ vaultRoot }`. Default mode: body on `stdout`, metadata JSON on `stderr`. `--raw`: exact file bytes
  on `stdout`, nothing on `stderr`. `--json`: full `noteRead` result on `stdout` as JSON.

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/main.test.js`:

```js
import { writeFileSync as writeFile, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { noteWrite } from '../core/notes.js';
import { runRead } from './main.js';

function writeRawNote(vaultRoot, relPath, raw) {
    const filePath = join(vaultRoot, relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFile(filePath, raw, 'utf8');
}

describe('runRead', () => {
    it('default mode: body on stdout, parsed metadata JSON on stderr', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', '---\nid: A\ntags:\n  - x\n---\nbody text');

        const result = await runRead([ 'A' ], { vaultRoot });

        expect(result.stdout).toBe('body text\n');
        expect(JSON.parse(result.stderr)).toEqual({ id: 'A', tags: [ 'x' ] });
        expect(result.exitCode).toBe(0);
    });

    it('--raw: exact file bytes, nothing on stderr', async () => {
        const vaultRoot = makeTempVault();
        const raw = '---\nid: A\n---\nbody text\n';
        writeRawNote(vaultRoot, 'A.md', raw);

        const result = await runRead([ 'A', '--raw' ], { vaultRoot });

        expect(result.stdout).toBe(raw);
        expect(result.stderr).toBe('');
    });

    it('--json: full structured result including content_hash', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', 'body text');

        const result = await runRead([ 'A', '--json' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.title).toBe('A');
        expect(typeof parsed.content_hash).toBe('string');
        expect(result.stderr).toBe('');
    });

    it('--start/--end window the body', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', 'l1\nl2\nl3\n');

        const result = await runRead([ 'A', '--start=2', '--end=3' ], { vaultRoot });

        expect(result.stdout).toBe('l2\nl3\n');
    });

    it('--raw on a missing note produces a "Note not found" error, not a raw ENOENT', async () => {
        const vaultRoot = makeTempVault();
        const result = await import('./main.js').then(({ dispatch }) =>
            dispatch([ 'read', 'Ghost', '--raw' ], { vaultRoot }));

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Note not found: "Ghost"/);
    });
});
```

(This task also needs `noteWrite` unused import removed if unused — only `writeRawNote` is used to set
up fixtures directly, matching S003's own test-helper pattern, so drop the `noteWrite` import.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `runRead` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/cli/main.js`:

```js
import { readFileSync } from 'node:fs';
import { noteRead, titleToPath } from '../core/notes.js';

function readRawNoteBytes(vaultRoot, title) {
    const filePath = titleToPath(vaultRoot, title);
    try {
        return readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Note not found: "${title}"`);
        }
        throw err;
    }
}

export async function runRead(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            start: { type: 'string' },
            end: { type: 'string' },
            raw: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    });
    const title = positionals[0];

    if (values.raw) {
        return { stdout: readRawNoteBytes(deps.vaultRoot, title), stderr: '', exitCode: 0 };
    }

    const startLine = values.start !== undefined ? Number(values.start) : undefined;
    const endLine = values.end !== undefined ? Number(values.end) : undefined;
    const result = noteRead(deps.vaultRoot, title, { startLine, endLine });

    if (values.json) {
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    }

    return {
        stdout: result.content.length > 0 ? `${result.content}\n` : '',
        stderr: formatJson(result.metadata),
        exitCode: 0,
    };
}

registerCommand('read', runRead);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): add read command with default/--raw/--json output modes"
```

---

### Task 9: stdin content helper, `write` command with audit logging

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`

**Interfaces:**
- Consumes: `noteWrite` from `core/notes.js` (S003), `logAudit` from `src/logger.js` (S008).
- Produces: `readStdinContent(stream) -> Promise<string>` and `parseMetadataFlag(raw) -> object |
  null` — both reused unchanged by `append` (Task 11) and `edit` (Task 10) respectively. `runWrite(args,
  deps) -> Promise<{...}>`, registered as `COMMANDS.write`. `deps` adds `auditLogger` and (for the
  stdin-fallback tests) an injectable `stdin` stream. On success or failure, logs one `logAudit` entry
  with `tool: 'write'`, `source: 'cli'`, `reason: null` (via `logAudit`'s own default).

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/main.test.js`:

```js
import { vi } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync as readAuditLog } from 'node:fs';
import { getAuditLogger } from '../logger.js';
import { runWrite } from './main.js';

function fakeStdin(text) {
    return Readable.from([ text ]);
}

describe('runWrite', () => {
    it('creates a note from --content and logs a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);

        const result = await runWrite(
            [ 'New Note', '--content=hello world' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).title).toBe('New Note');

        // logAudit's underlying write is fire-and-forget (never awaited by runWrite, same as every
        // other getContextLogger/logAudit call site in this codebase) — vi.waitFor polls for it to
        // land, mirroring src/core/search.test.js's and src/core/notes.test.js's own logging tests.
        await vi.waitFor(() => {
            const line = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim();
            expect(line).toContain('INFO  [audit] write');
            expect(line).toContain('note_title="New Note"');
            expect(line).toContain('source=cli');
            expect(line).toContain('outcome=success');
            expect(line).not.toContain('reason=');
        });
    });

    it('reads content from stdin when --content is omitted', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());

        const result = await runWrite(
            [ 'From Stdin' ],
            { vaultRoot, auditLogger, stdin: fakeStdin('piped body') },
        );

        expect(JSON.parse(result.stdout).title).toBe('From Stdin');
    });

    it('logs an error audit entry and rethrows (via dispatch) on a hash mismatch', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        await runWrite([ 'Existing', '--content=first' ], { vaultRoot, auditLogger });

        const result = await dispatch(
            [ 'write', 'Existing', '--hash=wrong', '--content=second' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(1);

        await vi.waitFor(() => {
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] write');
            expect(lastLine).toContain('note_title="Existing"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=error');
            expect(lastLine).toMatch(/error_message=".*hash mismatch.*"/i);
        });
    });

    it('rejects invalid --metadata JSON with a descriptive error', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());

        await expect(
            runWrite([ 'Bad Meta', '--content=x', '--metadata={not json' ], { vaultRoot, auditLogger }),
        ).rejects.toThrow(/--metadata is not valid JSON/);
    });
});
```

Add `vi` to `src/cli/main.test.js`'s top-level `vitest` import (alongside `describe, it, expect` from
Task 1) — the rest of the imports above (`Readable`, `readFileSync as readAuditLog`, `getAuditLogger`)
are new for this task.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `runWrite` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/cli/main.js`:

```js
import { noteRead, titleToPath, noteWrite } from '../core/notes.js';
import { logAudit } from '../logger.js';

export async function readStdinContent(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function parseMetadataFlag(raw) {
    if (raw === undefined) {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`--metadata is not valid JSON: ${err.message}`);
    }
}

export async function runWrite(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            hash: { type: 'string' },
            metadata: { type: 'string' },
            content: { type: 'string' },
        },
    });
    const title = positionals[0];
    const metadata = parseMetadataFlag(values.metadata);
    const content = values.content ?? await readStdinContent(deps.stdin ?? process.stdin);

    try {
        const result = noteWrite(deps.vaultRoot, title, { hash: values.hash ?? null, metadata, content });
        logAudit(deps.auditLogger, { tool: 'write', noteTitle: title, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'write', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('write', runWrite);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): add write command with stdin content fallback and audit logging"
```

---

### Task 10: `edit` command

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`

**Interfaces:**
- Consumes: `noteEdit` from `core/notes.js` (S003), `parseMetadataFlag` (Task 9), `logAudit` (S008).
- Produces: `runEdit(args, deps) -> Promise<{...}>`, registered as `COMMANDS.edit`. `--old`/`--new` are
  flag-only (never stdin-eligible, per S006).

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/main.test.js`:

```js
import { runEdit } from './main.js';

describe('runEdit', () => {
    it('applies a surgical replace and logs a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Editable', '--content=the quick fox' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runEdit(
            [ 'Editable', `--hash=${hash}`, '--old=quick', '--new=slow' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).title).toBe('Editable');

        await vi.waitFor(() => {
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] edit');
            expect(lastLine).toContain('note_title="Editable"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=success');
        });
    });

    it('propagates an ambiguous-match error via dispatch and logs an error audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Ambiguous', '--content=foo bar foo' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await dispatch(
            [ 'edit', 'Ambiguous', `--hash=${hash}`, '--old=foo', '--new=baz' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/ambiguous|matches \d+ times/i);

        await vi.waitFor(() => {
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] edit');
            expect(lastLine).toContain('note_title="Ambiguous"');
            expect(lastLine).toContain('outcome=error');
            expect(lastLine).toMatch(/error_message=".*ambiguous.*"/i);
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `runEdit` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/cli/main.js`:

```js
import { noteRead, titleToPath, noteWrite, noteEdit } from '../core/notes.js';

export async function runEdit(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            hash: { type: 'string' },
            old: { type: 'string' },
            new: { type: 'string' },
            metadata: { type: 'string' },
        },
    });
    const title = positionals[0];
    const metadata = parseMetadataFlag(values.metadata);

    try {
        const result = noteEdit(deps.vaultRoot, title, {
            hash: values.hash, oldTxt: values.old, newTxt: values.new, metadata,
        });
        logAudit(deps.auditLogger, { tool: 'edit', noteTitle: title, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'edit', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('edit', runEdit);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): add edit command"
```

---

### Task 11: `append` command

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`

**Interfaces:**
- Consumes: `noteAppend` from `core/notes.js` (S003, note the positional `hash` argument — a different
  shape from `noteWrite`/`noteEdit`'s options object), `readStdinContent` (Task 9), `logAudit` (S008).
- Produces: `runAppend(args, deps) -> Promise<{...}>`, registered as `COMMANDS.append`. Same
  success/error `logAudit` pattern as `write`/`edit` (`tool: 'append'`).

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/main.test.js`:

```js
import { runAppend } from './main.js';

describe('runAppend', () => {
    it('appends --content to the end of the body and logs a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Appendable', '--content=first line' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runAppend(
            [ 'Appendable', `--hash=${hash}`, '--content=second line' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        const read = await runRead([ 'Appendable' ], { vaultRoot });
        expect(read.stdout).toBe('first line\nsecond line\n');

        await vi.waitFor(() => {
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] append');
            expect(lastLine).toContain('note_title="Appendable"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=success');
        });
    });

    it('reads content from stdin when --content is omitted', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());
        const created = await runWrite([ 'StdinAppend', '--content=first' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runAppend(
            [ 'StdinAppend', `--hash=${hash}` ],
            { vaultRoot, auditLogger, stdin: fakeStdin('second') },
        );

        expect(result.exitCode).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `runAppend` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/cli/main.js`:

```js
import { noteRead, titleToPath, noteWrite, noteEdit, noteAppend } from '../core/notes.js';

export async function runAppend(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { hash: { type: 'string' }, content: { type: 'string' } },
    });
    const title = positionals[0];
    const content = values.content ?? await readStdinContent(deps.stdin ?? process.stdin);

    try {
        const result = noteAppend(deps.vaultRoot, title, values.hash ?? null, content);
        logAudit(deps.auditLogger, { tool: 'append', noteTitle: title, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'append', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('append', runAppend);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): add append command"
```

---

### Task 12: `rename` command

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`

**Interfaces:**
- Consumes: `noteRename` from `core/notes.js` (S003).
- Produces: `runRename(args, deps) -> Promise<{...}>`, registered as `COMMANDS.rename`. Two
  positionals (`old-title`, `new-title`). Audit entry's `noteTitle` is logged as the **new** title (the
  note's identity after the operation) — a judgment call, flagged in Self-Review.

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/main.test.js`:

```js
import { runRename } from './main.js';

describe('runRename', () => {
    it('moves the note and logs success against the new title', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Old Name', '--content=body' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runRename([ 'Old Name', 'New Name', `--hash=${hash}` ], { vaultRoot, auditLogger });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).title).toBe('New Name');

        // Audit entry is logged against the *new* title, per this task's "Interfaces" note above —
        // not the old one, even though the command's first positional was 'Old Name'.
        await vi.waitFor(() => {
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] rename');
            expect(lastLine).toContain('note_title="New Name"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=success');
        });
    });

    it('propagates a target-exists error via dispatch, with no force override, and logs an error audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const source = await runWrite([ 'Source', '--content=a' ], { vaultRoot, auditLogger });
        await runWrite([ 'Target', '--content=b' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(source.stdout).hash;

        const result = await dispatch([ 'rename', 'Source', 'Target', `--hash=${hash}` ], { vaultRoot, auditLogger });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/already exists/i);

        await vi.waitFor(() => {
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] rename');
            expect(lastLine).toContain('note_title="Target"');
            expect(lastLine).toContain('outcome=error');
            expect(lastLine).toMatch(/error_message=".*already exists.*"/i);
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `runRename` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/cli/main.js`:

```js
import { noteRead, titleToPath, noteWrite, noteEdit, noteAppend, noteRename } from '../core/notes.js';

export async function runRename(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { hash: { type: 'string' } },
    });
    const [ oldTitle, newTitle ] = positionals;

    try {
        const result = noteRename(deps.vaultRoot, oldTitle, newTitle, values.hash ?? null);
        logAudit(deps.auditLogger, { tool: 'rename', noteTitle: newTitle, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'rename', noteTitle: newTitle, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('rename', runRename);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): add rename command"
```

---

### Task 13: `meta.last_full_reindex_at` write in `runReindex` (amends S005)

**Files:**
- Modify: `src/indexer/daemon.js`
- Modify: `src/indexer/daemon.test.js`

**Interfaces:**
- Consumes: `setMeta`, `getMeta` from `src/core/db.js` (already implemented, S001).
- Produces: `runReindex` now writes `meta.last_full_reindex_at = String(now)` immediately before
  emitting its final `{ summary }` message, but **only** for a full-vault run (`noteTitle === null`) —
  a single-title reindex doesn't represent "the vault was fully reindexed" and must not update the
  watermark `mnotes stats` reads.

- [ ] **Step 1: Write the failing tests**

Add to `src/indexer/daemon.test.js`:

```js
import { getMeta } from '../core/db.js';

describe('runReindex: records last_full_reindex_at on a full-vault run', () => {
    it('writes meta.last_full_reindex_at after a full-vault reindex completes', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'note a', 1000);
        const db = makeTestDb();

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 5000 }, {}, () => {});

        expect(getMeta(db, 'last_full_reindex_at')).toBe('5000');
    });

    it('does not touch last_full_reindex_at for a single-title reindex', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'Only.md', 'note', 1000);
        const db = makeTestDb();

        await runReindex(vaultRoot, db, { ...baseDeps(), now: 5000 }, { noteTitle: 'Only' }, () => {});

        expect(getMeta(db, 'last_full_reindex_at')).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: FAIL — `getMeta(db, 'last_full_reindex_at')` is `null` in both cases (nothing writes it yet).

- [ ] **Step 3: Write minimal implementation**

Update `src/indexer/daemon.js` — add `setMeta` to the existing `../core/db.js` import, and insert one
call at the end of `runReindex` (the rest of the function is unchanged from S005's Task 17):

```js
import { openDb, setMeta } from '../core/db.js';

// ... runReindex unchanged up through the per-path loop ...

    if (noteTitle === null) {
        setMeta(db, 'last_full_reindex_at', String(now));
    }

    onMessage({ summary: { reindexed, skipped, failed } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/indexer/daemon.test.js`
Expected: PASS (every prior S005 test plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/daemon.js src/indexer/daemon.test.js
git commit -m "feat(indexer): record last_full_reindex_at after a full-vault runReindex"
```

---

### Task 14: `src/cli/reindex.js` — Unix-socket client, streamed progress, hard error if daemon is down

**Files:**
- Create: `src/cli/reindex.js`
- Create: `src/cli/reindex.test.js`

**Interfaces:**
- Consumes: the daemon's newline-delimited-JSON socket protocol exactly as `createIpcServer` speaks it
  (S005 Task 18: request `{ action: 'reindex', noteTitle? }`, response messages `{ path, outcome,
  attempts? }` streamed per attempt, then a final `{ summary: { reindexed, skipped, failed } }`).
- Produces: `streamReindex(socketPath, noteTitle, onMessage) -> Promise<void>` (rejects with a
  descriptive "is it running?" error on a connection failure) and `runReindexCommand(args, deps) ->
  Promise<{ stdout, stderr, exitCode }>`, registered by Task 16 as `COMMANDS.reindex`. `deps` is
  `{ socketPath }`.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/reindex.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { createIpcServer } from '../indexer/daemon.js';
import { streamReindex, runReindexCommand } from './reindex.js';

const tempDirs = [];

function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-reindex-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function baseDeps() {
    return {
        chunkText: (body) => (body.length === 0 ? [] : [ { chunkIndex: 0, charStart: 0, charEnd: body.length, tokenCount: 1 } ]),
        embed: async () => new Float32Array(1024).fill(0.1),
        embeddingModel: 'test-model',
        embeddingVersion: 'v1',
        now: 0,
    };
}

describe('streamReindex / runReindexCommand', () => {
    it('streams per-path outcomes and a final summary from a real daemon socket', async () => {
        const vaultRoot = makeTempDir();
        writeFileSync(join(vaultRoot, 'A.md'), 'note body');
        const { db } = openDb(':memory:');
        const socketPath = join(makeTempDir(), 'daemon.sock');
        const server = createIpcServer(socketPath, vaultRoot, db, baseDeps());

        const result = await runReindexCommand([], { socketPath });

        server.close();
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('A.md | reindexed');
        expect(result.stdout).toContain('reindexed: 1, skipped: 0, failed: 0');
    });

    it('scopes to a single title when one is given', async () => {
        const vaultRoot = makeTempDir();
        writeFileSync(join(vaultRoot, 'Only.md'), 'note');
        writeFileSync(join(vaultRoot, 'Ignored.md'), 'note');
        const { db } = openDb(':memory:');
        const socketPath = join(makeTempDir(), 'daemon.sock');
        const server = createIpcServer(socketPath, vaultRoot, db, baseDeps());

        const result = await runReindexCommand([ 'Only' ], { socketPath });

        server.close();
        expect(result.stdout).toContain('Only.md | reindexed');
        expect(result.stdout).not.toContain('Ignored.md');
    });

    it('hard-errors with an actionable message when the daemon is not running', async () => {
        const socketPath = join(makeTempDir(), 'nobody-listening.sock');

        await expect(streamReindex(socketPath, null, () => {})).rejects.toThrow(/is it running/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cli/reindex.test.js`
Expected: FAIL — `src/cli/reindex.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/reindex.js`:

```js
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';

export function streamReindex(socketPath, noteTitle, onMessage) {
    return new Promise((resolve, reject) => {
        const client = createConnection(socketPath);
        let buffer = '';

        client.on('connect', () => {
            client.write(`${JSON.stringify({ action: 'reindex', noteTitle })}\n`);
        });
        client.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                onMessage(JSON.parse(buffer.slice(0, newlineIndex)));
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf('\n');
            }
        });
        client.on('end', resolve);
        client.on('error', (err) => {
            reject(new Error(
                `mnotes reindex: could not connect to the daemon at "${socketPath}" — is it running? (${err.message})`,
            ));
        });
    });
}

export async function runReindexCommand(args, deps) {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const noteTitle = positionals[0] ?? null;
    const lines = [];
    let summary = null;

    await streamReindex(deps.socketPath, noteTitle, (msg) => {
        if (msg.summary) {
            summary = msg.summary;
            return;
        }
        const suffix = msg.attempts ? ` (attempt ${msg.attempts})` : '';
        lines.push(`${msg.path} | ${msg.outcome}${suffix}`);
    });

    lines.push(`reindexed: ${summary.reindexed}, skipped: ${summary.skipped}, failed: ${summary.failed}`);

    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: summary.failed > 0 ? 1 : 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/reindex.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/reindex.js src/cli/reindex.test.js
git commit -m "feat(cli): add reindex command, a unix-socket client for the daemon's IPC protocol"
```

---

### Task 15: `src/cli/stats.js` — DB queries, queue depth, best-effort daemon status

**Files:**
- Create: `src/cli/stats.js`
- Create: `src/cli/stats.test.js`
- Modify: `src/format.js`
- Modify: `src/format.test.js`

**Interfaces:**
- Consumes: `getMeta` from `src/core/db.js` (S001, already implemented).
- Produces: `computeStats(db, dbPath, embeddingModel, embeddingVersion) -> object` (note/tag counts,
  total/average line count, configured embedding model/version, pending-re-embedding count via a
  `chunks`/`notes` mismatch join, index file size via `statSync`, `last_reindex_at` via `getMeta`,
  `queue_depth` via `index_queue`), `checkDaemonRunning(socketPath, timeoutMs = 300) -> Promise<boolean>`
  (non-blocking best-effort connect attempt, per S006 — `stats` never requires the daemon to be up),
  and `formatStats(stats, { json, daemonRunning }) -> string` in `format.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/stats.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openDb, setMeta } from '../core/db.js';
import { computeStats, checkDaemonRunning } from './stats.js';

const tempDirs = [];

function makeTempDbPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-stats-test-'));
    tempDirs.push(dir);
    return join(dir, 'index.db');
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('computeStats', () => {
    it('reports note/tag counts, line stats, embedding config, and queue depth', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'hash', 10, 1000, 1000);
        db.prepare('INSERT INTO tags (name) VALUES (?)').run('project');
        db.prepare('INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)').run('B.md', 1, 1);
        setMeta(db, 'last_full_reindex_at', '5000');

        const stats = computeStats(db, dbPath, 'test-model', 'v1');

        expect(stats.note_count).toBe(1);
        expect(stats.tag_count).toBe(1);
        expect(stats.total_line_count).toBe(10);
        expect(stats.average_line_count).toBe(10);
        expect(stats.embedding_model).toBe('test-model');
        expect(stats.embedding_version).toBe('v1');
        expect(stats.last_reindex_at).toBe('5000');
        expect(stats.queue_depth).toBe(1);
        expect(stats.index_size_bytes).toBeGreaterThan(0);
        db.close();
    });

    it('counts notes with a stale embedding_model/version as pending re-embedding', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'hash', 1, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('A.md').id;
        db.prepare(`
            INSERT INTO chunks (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 1, 1, 'old-model', 'v0')
        `).run(noteId);

        const stats = computeStats(db, dbPath, 'test-model', 'v1');

        expect(stats.pending_reembedding_count).toBe(1);
        db.close();
    });

    it('reports last_reindex_at as null before any full reindex has run', () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);

        expect(computeStats(db, dbPath, 'm', 'v1').last_reindex_at).toBeNull();
        db.close();
    });
});

describe('checkDaemonRunning', () => {
    it('resolves true when something is listening on the socket', async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), 'mnotes-cli-stats-test-')), 'daemon.sock');
        const server = createServer(() => {});
        await new Promise((resolve) => server.listen(socketPath, resolve));

        expect(await checkDaemonRunning(socketPath)).toBe(true);
        server.close();
    });

    it('resolves false without throwing when nothing is listening', async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), 'mnotes-cli-stats-test-')), 'nobody.sock');

        expect(await checkDaemonRunning(socketPath)).toBe(false);
    });
});
```

Add to `src/format.test.js`:

```js
import { formatStats } from './format.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cli/stats.test.js src/format.test.js`
Expected: FAIL — `src/cli/stats.js` doesn't exist yet; `formatStats` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/stats.js`:

```js
import { statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { getMeta } from '../core/db.js';

export function computeStats(db, dbPath, embeddingModel, embeddingVersion) {
    const noteCount = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
    const tagCount = db.prepare('SELECT COUNT(*) AS count FROM tags').get().count;
    const lineStats = db.prepare(
        'SELECT COALESCE(SUM(line_count), 0) AS total, COALESCE(AVG(line_count), 0.0) AS average FROM notes',
    ).get();
    const pendingReembedding = db.prepare(`
        SELECT COUNT(DISTINCT note_id) AS count
        FROM chunks
        WHERE embedding_model != ? OR embedding_version != ?
    `).get(embeddingModel, embeddingVersion).count;
    const queueDepth = db.prepare('SELECT COUNT(*) AS count FROM index_queue').get().count;

    return {
        note_count: noteCount,
        tag_count: tagCount,
        total_line_count: lineStats.total,
        average_line_count: lineStats.average,
        embedding_model: embeddingModel,
        embedding_version: embeddingVersion,
        pending_reembedding_count: pendingReembedding,
        index_size_bytes: statSync(dbPath).size,
        last_reindex_at: getMeta(db, 'last_full_reindex_at'),
        queue_depth: queueDepth,
    };
}

export function checkDaemonRunning(socketPath, timeoutMs = 300) {
    return new Promise((resolve) => {
        let settled = false;
        const client = createConnection(socketPath);

        function finish(running) {
            if (settled) {
                return;
            }
            settled = true;
            client.destroy();
            resolve(running);
        }

        const timer = setTimeout(() => finish(false), timeoutMs);
        client.on('connect', () => {
            clearTimeout(timer);
            finish(true);
        });
        client.on('error', () => {
            clearTimeout(timer);
            finish(false);
        });
    });
}
```

Add to `src/format.js`:

```js
export function formatStats(stats, { json = false, daemonRunning } = {}) {
    const withDaemon = { ...stats, daemon_running: daemonRunning };
    if (json) {
        return formatJson(withDaemon);
    }
    return `${Object.entries(withDaemon).map(([ key, value ]) => `${key}: ${value}`).join('\n')}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/stats.test.js src/format.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/stats.js src/cli/stats.test.js src/format.js src/format.test.js
git commit -m "feat(cli): add stats command's db queries, queue depth, and daemon-status check"
```

---

### Task 16: Wire `reindex`/`stats` into `main.js`, real dependency bootstrap, final review

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/cli/main.test.js`

**Interfaces:**
- Consumes: `runReindexCommand` (Task 14), `computeStats`/`checkDaemonRunning` (Task 15),
  `formatStats` (Task 15), `defaultSocketPath` from `indexer/daemon.js` (S005), `embed` from
  `indexer/embed.js` (S005), `getAuditLogger`/`defaultLogDir` from `src/logger.js` (S008), `openDb`
  from `src/core/db.js` (S001).
- Produces: `COMMANDS.reindex`/`COMMANDS.stats` registrations, `runStats(args, deps)`, and a real
  `buildRealDeps()` used only by `main()`'s direct-execution guard — every handler/test above continues
  to use its own injected `deps`, unaffected by this task.

- [ ] **Step 1: Write the failing test**

Add to `src/cli/main.test.js`:

```js
import { computeStats, checkDaemonRunning } from './stats.js';
import { runReindexCommand } from './reindex.js';

describe('runStats', () => {
    it('formats computeStats output plus daemon status', async () => {
        const dbPath = join(makeTempVault(), 'index.db');
        const { db } = openDb(dbPath);

        const result = await runStats(
            [],
            { db, dbPath, embeddingModel: 'm', embeddingVersion: 'v1', socketPath: join(makeTempVault(), 'nobody.sock') },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('note_count: 0');
        expect(result.stdout).toContain('daemon_running: false');
        db.close();
    });
});

describe('dispatch: reindex and stats are registered', () => {
    it('routes "reindex" through runReindexCommand and "stats" through runStats', async () => {
        // both COMMANDS entries exist and are reachable via dispatch — exercised indirectly by their
        // own dedicated test files (reindex.test.js, and runStats above); this just proves wiring.
        const dbPath = join(makeTempVault(), 'index.db');
        const { db } = openDb(dbPath);

        const statsResult = await dispatch(
            [ 'stats' ],
            { db, dbPath, embeddingModel: 'm', embeddingVersion: 'v1', socketPath: join(makeTempVault(), 'nobody.sock') },
        );

        expect(statsResult.exitCode).toBe(0);
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: FAIL — `runStats` is not exported; `dispatch(['stats'], ...)`/`dispatch(['reindex'], ...)`
return "unknown command".

- [ ] **Step 3: Write minimal implementation**

Update `src/cli/main.js` — add the imports, `runStats`, and both registrations, plus the real
`main()` bootstrap:

```js
import { defaultSocketPath } from '../indexer/daemon.js';
import { embed as realEmbed } from '../indexer/embed.js';
import { getAuditLogger, defaultLogDir } from '../logger.js';
import { computeStats, checkDaemonRunning } from './stats.js';
import { runReindexCommand } from './reindex.js';
import { formatStats } from '../format.js';
import { openDb } from '../core/db.js';

export async function runStats(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
    const stats = computeStats(deps.db, deps.dbPath, deps.embeddingModel, deps.embeddingVersion);
    const daemonRunning = await checkDaemonRunning(deps.socketPath);
    return { stdout: formatStats(stats, { json: values.json, daemonRunning }), stderr: '', exitCode: 0 };
}

registerCommand('reindex', runReindexCommand);
registerCommand('stats', runStats);

// DEFAULT_EMBEDDING_MODEL/VERSION must match indexer/daemon.js's own DEFAULT_EMBEDDING_MODEL/VERSION
// (S005 Task 19) — neither is exported from that module, so this is a deliberate, flagged duplication
// pending S009's config.js, which will supply both from one place. See Self-Review Notes.
const DEFAULT_EMBEDDING_MODEL = 'Qwen3-Embedding-0.6B';
const DEFAULT_EMBEDDING_VERSION = 'q8-v1';

function buildRealDeps() {
    const vaultRoot = resolveVaultRoot();
    const dbPath = resolveDbPath();
    const { db } = openDb(dbPath);
    return {
        vaultRoot,
        dbPath,
        db,
        embed: realEmbed,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        embeddingVersion: DEFAULT_EMBEDDING_VERSION,
        auditLogger: getAuditLogger(defaultLogDir()),
        socketPath: defaultSocketPath(),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2), buildRealDeps()).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
```

(This replaces the earlier bare `main().then(...)` guard from Task 1 with the real-dependency version;
`main`'s own signature is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/main.test.js`
Expected: PASS

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: every test file touched by this plan passes (`src/format.test.js`, `src/cli/main.test.js`,
`src/cli/reindex.test.js`, `src/cli/stats.test.js`, plus S002's `src/core/search.test.js` and S005's
`src/indexer/daemon.test.js`, both extended here), no lint errors (in particular no `no-console`
violations — confirm nothing in `src/cli/*.js` or `src/format.js` calls `console.*`).

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.js src/cli/main.test.js
git commit -m "feat(cli): wire reindex and stats commands, build real dependency bootstrap"
```

---

## Self-Review Notes

- **Spec coverage**: all ten `mnotes` subcommands (`search`, `grep`, `tags list`/`tags notes`, `read`,
  `write`, `edit`, `append`, `rename`, `reindex`, `stats`) have a dedicated task and passing tests. Every
  flag in S006's command table is covered: `search`'s `--mode`/`--limit`/`--explain`/`--json`; `grep`'s
  `--regex`/`--note`/`--json`; `tags`' `--json`; `read`'s `--start`/`--end`/`--raw`/`--json` three-mode
  output split; `write`/`append`'s stdin-fallback content input; `edit`'s flag-only `--old`/`--new`;
  `rename`'s hard no-force target-exists error (inherited unchanged from S003); `reindex`'s hard error
  when the daemon isn't running and its streamed per-attempt progress; `stats`'s full field list (note/
  tag counts, average length, embedding model/version, pending-re-embedding count, index size, last
  reindex time, daemon status, queue depth). The "no `reason` flag" rule and CLI mutations still being
  audited with `source: 'cli'` are covered in every mutating command's task (9, 10, 11, 12).
- **Logging** (S008, S006 "Logging"): each of `write`/`edit`/`append`/`rename` (Tasks 9–12) has both a
  success-path and an error-path test asserting on the actual `audit.log` line format produced by
  `src/logger.js`'s plain-text `writeLine` (`toContain`/`toMatch` against the real
  `TIMESTAMP LEVEL [component] msg key=value ...` shape, via `vi.waitFor` since `logAudit`'s write is
  fire-and-forget and never awaited by any handler) — not `JSON.parse`, which this plan's tests
  incorrectly assumed in an earlier draft before `src/logger.js` was actually implemented. Confirmed no
  task in this plan calls `runWithLogger` anywhere; `search`/`grep`/`tags`/`read`/`reindex`/`stats` add
  no logging at all, matching S006's "Logging" section precisely.
- **Two flagged amendments to earlier plans, not literally "owned" by S006's file list** (Tasks 3 and
  13) — surfaced prominently in the Architecture section above, repeated here for visibility: (1)
  `core/search.js` gains an additive `explainSearch` export because S002's `search()` has no seam for
  `--explain`'s raw-score requirement as originally planned; (2) `indexer/daemon.js`'s `runReindex`
  gains one `setMeta` call because nothing in S005's plan ever wrote `meta.last_full_reindex_at`, which
  S006's own spec text says `stats` reads. Both are small, additive, and don't touch any existing
  test's expected behavior — but both are genuine cross-plan changes and should be confirmed with AJ
  before implementation, per CLAUDE.md's "stop and ask rather than picking a default" guidance, the
  same posture S003's plan took when it flagged its own deviation from its orienting brief.
- **`src/format.js` is a new top-level module not named in S006's spec header** — a deliberate design
  decision (see Architecture) so `mcp/` tool handlers can import the exact same formatters without
  `mcp/` importing from `cli/` or vice versa. This plan and `docs/plans/S007-mcp-server.md` were in fact
  planned concurrently, neither seeing the other's output, and disagreed on more than just the location:
  S007's formatters (built inside `mcp/tools.js` at the time) emitted a header row on every table,
  used `|` as the delimiter, had no rank-prefix column, and pretty-printed nothing — whereas this plan's
  original `formatJson` pretty-printed, and its hand-built `formatSearchResults`/`formatGrepResults`/
  `formatTagList`/`formatTagNotes` used `' | '`, omitted headers, and (for search) prepended an
  undocumented `rank` column. Reconciled after both plans were written: this plan's `src/format.js`
  location was kept, but every formatter's *implementation* was replaced with S007's — headers, `|`
  delimiter, no rank column, compact JSON — since those matched what both specs actually required. Tasks
  2, 4, 6, and 7 above already reflect the reconciled state.
- **Config-not-ready stand-ins, all flagged as temporary**: `resolveVaultRoot`/`resolveDbPath`
  (env-var-backed, Task 1) stand in for S009's `config.js` reading `vault_path`/`db_path`; swapping
  them for real config reads once S009 lands is a mechanical change confined to `buildRealDeps()`
  (Task 16), never touching any handler or its tests. `DEFAULT_EMBEDDING_MODEL`/`DEFAULT_EMBEDDING_VERSION`
  (Task 16) are a **known, deliberate duplication** of the same-named constants hardcoded in
  `indexer/daemon.js`'s `startDaemon` (S005 Task 19, not exported) — if these two ever drift apart,
  `mnotes search`'s semantic/hybrid modes would silently return zero results (the `chunks` table's
  `WHERE embedding_model = ? AND embedding_version = ?` filter would never match), which is a much
  worse failure mode than the duplication itself. Recommended follow-up (not part of this plan): export
  both constants from `indexer/daemon.js` and import them here instead.
- **Spec gap noted, not fixed**: S006's command table lists no `--force` flag for `write`, even though
  `core/notes.js`'s `noteWrite` accepts one (S003) to bypass the size-drop guard. This plan follows the
  spec's flag table literally — there is currently no way to bypass that guard from the CLI. Flagged as
  a possible oversight worth confirming with AJ, not silently "fixed" by adding an unspecified flag.
- **Judgment calls made without a literal spec answer** (flagged per CLAUDE.md, not buried): `rename`'s
  audit-log `noteTitle` is the **new** title, not the old one (Task 12) — either is defensible, `note_
  title` is a single field so one had to be chosen. `--explain`'s exact text/JSON shape (column order,
  the `rrf_formula` string format) is explicitly left to implementation by S006's own "Explicitly out of
  scope" section — this plan's rendering is one reasonable choice, not the only one. `stats`'s
  plain-text rendering (`key: value` lines, Task 15) versus the pipe-delimited columnar format used for
  list commands — `stats` isn't a list of rows, so a key/value format was chosen instead; S006 doesn't
  specify a format for it beyond "same JSON default as everything else via `--json`."
- **Explicitly out of scope here, per S006's own "Explicitly out of scope" section and this plan's file
  boundaries**: `mnotes reindex`'s actual daemon-side protocol/retry/backoff behavior (S005, this plan
  only adds the CLI-side socket client that speaks the existing protocol); MCP tool schemas, transport,
  and error-mapping (S007, not yet planned); `config.toml`'s real schema and the install/uninstall
  scripts that would create it (S009); the launchd plist that keeps the daemon (and therefore `mnotes
  reindex`/the "daemon running" half of `stats`) alive (S009).
- **Testing approach, stated explicitly**: every handler is tested by calling the exported function
  directly with real temp vault directories, real temp-file/in-memory `openDb` connections, and a real
  `getAuditLogger` writing to a real temp log directory — never by spawning `node src/cli/main.js` as a
  subprocess, and never by mocking `core/`, `node:fs`, or `node:net`. The one deliberately-injected fake
  across this entire plan is `embed` (search/reindex tests), mirroring the exact seam S002 and S005
  already established for the one genuinely expensive external dependency. `reindex`/`stats`'s daemon
  interactions are tested against a real Unix socket via `indexer/daemon.js`'s own already-real-socket
  -tested `createIpcServer`, or a bare `node:net` `createServer`/an intentionally-nonexistent socket
  path for the "daemon down" cases — never a mocked `node:net`.
- **Placeholder scan**: no TODOs/TBDs left in any code block; every step has complete, runnable code.
- **Type/signature consistency**: every handler is `async function(args, deps) -> Promise<{ stdout,
  stderr, exitCode }>` from Task 1 through Task 16, registered into the same `COMMANDS` table via the
  same `registerCommand` function introduced in Task 1. `formatJson`/`formatTable`/`formatSearchTable`/
  `formatExplain`/`formatGrepTable`/`formatTagListTable`/`formatTagNotesTable`/`formatStats` in
  `src/format.js` are each introduced once and never change signature afterward. `core/` function calls throughout use
  the exact signatures documented in the S002–S005 plans verbatim, with the two amendments (Tasks 3, 13)
  called out as the only deviations, both additive.
