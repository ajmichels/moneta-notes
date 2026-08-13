# S007 MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/mcp/tools.js` (the 9 MCP tool handlers and the generic
error-mapping/audit-logging wrapper), `src/format.js` (the shared pipe-delimited table and compact-JSON
output formatters, also consumed by `docs/plans/S006-cli.md`'s CLI handlers), `src/mcp/server.js`
(schema-version guard, `McpServer` bootstrap, stdio transport, real-dependency `main()`), and
`src/mcp/prompts.js` (an empty-list stub) per `docs/specs/S007-mcp-server.md`.

**Architecture:** `mcp/tools.js` owns every tool's business logic as a small, directly-callable
handler function — `searchTool(deps, input)`, `grepTool(deps, input)`, `tagListTool(deps, input)`,
`tagNotesTool(deps, input)`, `noteReadTool(deps, input)`, `noteWriteTool(deps, input)`,
`noteEditTool(deps, input)`, `noteAppendTool(deps, input)`, `noteRenameTool(deps, input)` — each a
thin adapter: unpack `input`'s snake_case tool-schema fields into the camelCase options each `core/`
function expects, call the `core/` function, format the result, and return it through a single shared
wrapper, `callTool(auditLogger, toolName, input, fn)`. That wrapper is the one place error-mapping
(`isError: true`, original thrown message preserved verbatim, per S007 "Error mapping") and
S008 audit logging (`source: 'mcp'`, `reason` from `input.reason`, `note_title` where applicable) both
happen — every handler goes through it, so neither concern is duplicated per-tool. `deps` is a plain
object (`{ db, vaultRoot, embed, embeddingModel, embeddingVersion, auditLogger }`) injected by
`server.js`, mirroring the dependency-injection seam `S002-search`/`S005-indexing-daemon` already
established for `embed` — handlers never import `indexer/embed.js` or open a DB/vault path themselves,
which is what makes them callable directly in tests with fakes, no live stdio connection required.

Two output-format helpers live in `src/format.js`, a shared top-level module — not inside `tools.js`
itself: `formatTable(columns, rows) -> string` (generic pipe-delimited columnar text, reused by
`search`/`grep`/`tag_list`/`tag_notes`) and `formatJson(result) -> string` (used by `note_read` and the
four mutating tools — `core/notes.js` already returns exactly the snake_case wire shape S003 defined, so
this is a thin `JSON.stringify` wrapper, not a field-remapping step). This plan's Task 2 and Task 3 build
`src/format.js` itself along with every formatter in it (`formatTable`, `formatSearchTable`,
`formatGrepTable`, `formatTagListTable`, `formatTagNotesTable`, `formatJson`); every tool handler in
Tasks 5–11 imports the formatter(s) it needs from `../format.js`, never redefining them locally.
`docs/plans/S006-cli.md` — planned concurrently with this plan, without either seeing the other's output
— independently arrived at the same `src/format.js` location. The two plans were reconciled after both
were written: S006's location choice (`src/format.js`, a shared top-level module so neither `cli/` nor
`mcp/` imports across the other's directory) won, and this plan's formatter *implementations* (header
rows on every table, `|`-delimited with no rank-prefix column, compact `formatJson`) won, since those
match the specs' documented requirements. See `docs/plans/S006-cli.md`'s own Architecture section for its
side of that reconciliation.

`server.js` owns process bootstrap: `assertSchemaCurrent(dbPath)` (the schema-version-mismatch guard
S007 requires — see the important wrinkle called out below), `createServer(deps) -> McpServer` (builds
a `McpServer`, registers all 9 tools with their `zod` input schemas against the handlers from
`tools.js`, registers the prompt stub from `prompts.js` — testable without ever calling `.connect()`),
and `main()` (wires real dependencies — `openDb`, the real `embed` from `indexer/embed.js`, a real
`getAuditLogger`, `vaultRoot`/`dbPath` from environment variables as an explicit stand-in for the
`config.toml` values S009 will eventually supply — and connects over `StdioServerTransport`).

**Important wrinkle reconciled here, not left implicit:** `core/db.js`'s already-implemented `openDb`
unconditionally rebuilds the schema (`dropAllTables` + `createSchema`) whenever the stored
`meta.schema_version` doesn't match the code's `SCHEMA_VERSION` — that's S001's job, and it runs
*inside* `openDb` itself, not behind a caller-controlled flag. S007's spec is explicit that "the MCP
server never attempts DDL itself" and must instead fail with a clear error pointing at the daemon.
Calling `openDb(dbPath)` naively from the MCP server would silently perform exactly the DDL rebuild the
spec forbids. This plan resolves that by having `assertSchemaCurrent(dbPath)` open its own **separate,
short-lived** `node:sqlite` `DatabaseSync` connection (not through `openDb`), read `meta.schema_version`
directly, compare it to `SCHEMA_VERSION` (imported from `core/db.js`), close that connection, and throw
before `main()` ever calls the real `openDb(dbPath)` for the server's long-lived connection. Only after
the version is confirmed current does `main()` call `openDb`, at which point it's a guaranteed no-op on
schema (so no rebuild ever actually happens from the MCP process in practice) — `openDb`'s call site is
kept exactly as S001 built it, nothing about `core/db.js` changes.

**Tech Stack:** `@modelcontextprotocol/sdk` (already a `package.json` dependency; `McpServer`,
`StdioServerTransport`, `InMemoryTransport`, `Client` — the last two for testing only), `zod` (new
dependency — required by `McpServer.registerTool`'s `inputSchema` parameter, which this plan uses for
protocol-level input validation), `core/search.js` (S002), `core/notes.js` (S003), `core/grep.js` /
`core/tags.js` (S004), `indexer/embed.js`'s `embed`/`DEFAULT_MODEL_ID` (S005), `src/logger.js`'s
`getAuditLogger`/`logAudit` (S008), `core/db.js`'s `openDb`/`SCHEMA_VERSION` (S001, already
implemented). Vitest throughout, calling handler functions directly against real fixtures (real
in-memory/temp-file SQLite via `openDb`, real temp vault directories, a real `rg` binary for `grep` —
no mocking, per CLAUDE.md) rather than spinning up a live stdio subprocess for every test. The one
exception is `server.js`'s own wiring test (Task 14), which uses the SDK's `InMemoryTransport` +
`Client` to prove `createServer`'s `registerTool` calls actually produce a working, protocol-correct
server end-to-end — a "real but lightweight" check (real `McpServer`/`Client`/JSON-RPC framing, zero
process spawning, zero real stdin/stdout) that exercises the SDK wiring CLAUDE.md's "don't spin up the
MCP server" guidance is really aimed at avoiding (a subprocess + real stdio pipes), without resorting to
a private/undocumented introspection API.

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md) — except where a field name is
  itself part of a spec-mandated snake_case wire shape (`note_title`, `file_line_count`, ...), which
  only ever appears as an object *key*, never a JS identifier.
- Test files colocated: `src/mcp/tools.js` → `src/mcp/tools.test.js`, `src/mcp/server.js` →
  `src/mcp/server.test.js`, `src/mcp/prompts.js` → `src/mcp/prompts.test.js`, `src/format.js` →
  `src/format.test.js` (CLAUDE.md) — the last one holds `formatTable`/`formatSearchTable`/
  `formatGrepTable`/`formatTagListTable`/`formatTagNotesTable`/`formatJson` and their tests (Tasks 2–3),
  not `tools.js`.
- 4-space indentation, single quotes, trailing commas on multiline, spaced array brackets
  (`[ 'a', 'b' ]`), `func-style: declaration` — matches `eslint.config.js` and every prior plan's
  style.
- **`core/` is never modified by this plan.** `mcp/` consumes `core/search.js`, `core/notes.js`,
  `core/grep.js`, `core/tags.js`, `core/db.js` exactly as those plans built them — no new `core/`
  exports, no signature changes.
- **Every MCP tool takes a required `reason<string>` argument**, logged via S008's `logAudit`, never
  used to gate behavior beyond that (CLAUDE.md) — enforced at the protocol boundary by `zod`'s
  `inputSchema` (Task 14) and consumed only by `callTool`'s audit-logging call (Task 12).
- **Don't add MCP resources** (CLAUDE.md) — this plan registers only tools and the prompt stub, never
  `server.registerResource` or equivalent.
- **Don't show raw RRF/BM25/cosine scores anywhere in tool output** (CLAUDE.md) — trivially satisfied
  here because `core/search.js`'s `search()` already strips them before returning (S002); this plan's
  formatters never have access to a raw score to begin with.
- **Error mapping**: every `core/` function throws; `callTool` catches the thrown `Error` and returns
  `isError: true` with `err.message` preserved **verbatim** — no wrapping, no error-code taxonomy, no
  re-phrasing (S007 "Error mapping").
- **No daemon interaction**: `mcp/` never opens the S005 Unix socket, never calls `reindex`/`stats`
  logic — those are CLI-only (S006). The only S005-adjacent behavior here is `assertSchemaCurrent`
  telling the caller to go check that the daemon is running, never talking to it directly.
- **`mcp/` must not duplicate logic already in `core/`** (CLAUDE.md) — every handler is a thin
  unpack-call-format adapter; hash rules, metadata merge semantics, the size-drop guard, ambiguous-edit
  detection, RRF, tag matching, etc. all stay exactly where S002/S003/S004 put them.
- Lint budget in mind while structuring helpers: `max-lines-per-function: 50`, `max-statements: 30`,
  `max-depth: 2`, `max-nested-callbacks: 3`, `max-params: 5` (`eslint.config.js`) — every handler stays
  a handful of lines by design (unpack, call, format), and multi-field dependencies are always a single
  `deps`/`options` object, mirroring every prior plan's pattern.
- Exact tool input/output field names (`note_title`, `file_line_count`, `old_txt`, `new_txt`,
  `old_title`, `new_title`, `line_count`, `content_hash`, ...) per `docs/specs/S007-mcp-server.md`,
  copied verbatim into the tasks below — never invented or abbreviated differently.

---

### Task 1: `callTool` — generic error-mapping wrapper

**Files:**
- Create: `src/mcp/tools.js`
- Create: `src/mcp/tools.test.js`

**Interfaces:**
- Produces: `callTool(fn) -> Promise<{ content: [{ type: 'text', text: string }], isError?: true }>`.
  This is the *pre-audit-logging* version of the wrapper — Task 12 extends its signature to
  `callTool(auditLogger, toolName, input, fn)` once every handler exists to update in lockstep. Every
  handler built in Tasks 5–11 calls this version first.

- [ ] **Step 1: Write the failing tests**

Create `src/mcp/tools.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { callTool } from './tools.js';

describe('callTool', () => {
    it('wraps a successful string result in MCP content shape', async () => {
        const result = await callTool(async () => 'ok');

        expect(result).toEqual({ content: [ { type: 'text', text: 'ok' } ] });
    });

    it('maps a thrown Error to isError: true with the message preserved verbatim', async () => {
        const result = await callTool(async () => {
            throw new Error('hash mismatch: note has changed since last read');
        });

        expect(result).toEqual({
            content: [ { type: 'text', text: 'hash mismatch: note has changed since last read' } ],
            isError: true,
        });
    });

    it('maps a synchronous throw the same way as an async rejection', async () => {
        const result = await callTool(() => {
            throw new Error('sync boom');
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('sync boom');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `src/mcp/tools.js` doesn't exist yet (`Cannot find module './tools.js'` or similar).

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/tools.js`:

```js
export async function callTool(fn) {
    let text;
    try {
        text = await fn();
    } catch (err) {
        return { content: [ { type: 'text', text: err.message } ], isError: true };
    }

    return { content: [ { type: 'text', text } ] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add callTool error-mapping wrapper, isError with verbatim message"
```

---

### Task 2: Pipe-delimited table formatters

**Files:**
- Create: `src/format.js`
- Create: `src/format.test.js`

**Interfaces:**
- Produces: `formatTable(columns, rows) -> string` (generic — header row + one row per item, `|`
  -joined, missing/null cells render as an empty string) and four per-tool formatters built on it:
  `formatSearchTable(results, mode)`, `formatGrepTable(results)`, `formatTagListTable(results)`,
  `formatTagNotesTable(results)`. The latter three also do the camelCase (`core/grep.js`/`core/tags.js`
  return shape) → snake_case (wire shape) field-name mapping S004's plan explicitly deferred to
  "S006/S007's formatting responsibility."

- [ ] **Step 1: Write the failing tests**

Create `src/format.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
    formatTable, formatSearchTable, formatGrepTable, formatTagListTable, formatTagNotesTable,
} from './format.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/format.test.js`
Expected: FAIL — `src/format.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/format.js`:

```js
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

export function formatSearchTable(results, mode) {
    const columns = mode === 'hybrid'
        ? [ 'note_title', 'file_line_count', 'fulltext_rank', 'semantic_rank' ]
        : [ 'note_title', 'file_line_count' ];
    return formatTable(columns, results);
}

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

export function formatTagListTable(results) {
    const rows = results.map((r) => ({ tag: r.tag, notes_with_tag: r.notesWithTag }));
    return formatTable([ 'tag', 'notes_with_tag' ], rows);
}

export function formatTagNotesTable(results) {
    const rows = results.map((r) => ({ note_title: r.noteTitle, file_line_count: r.fileLineCount }));
    return formatTable([ 'note_title', 'file_line_count' ], rows);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/format.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/format.js src/format.test.js
git commit -m "feat(format): add formatTable and per-tool table formatters (shared cli/mcp)"
```

---

### Task 3: `formatJson` — JSON output for `note_read` and the mutating tools

**Files:**
- Modify: `src/format.js`
- Modify: `src/format.test.js`

Note: `src/format.js` and `src/format.test.js` were already created by Task 2 — this task modifies
(does not create) them.

**Interfaces:**
- Produces: `formatJson(result) -> string`. A thin, dedicated wrapper (not an inline
  `JSON.stringify` at each of the five call sites) so there's exactly one place to change if the
  serialization strategy (e.g. pretty-printing) ever needs to differ from `JSON.stringify(result)`'s
  compact default — kept compact here, matching this project's token-efficiency bias.

- [ ] **Step 1: Write the failing test**

Add to `src/format.test.js`:

```js
import { formatJson } from './format.js';

describe('formatJson', () => {
    it('serializes a result object as compact JSON', () => {
        const text = formatJson({ title: 'A', hash: 'abc123', line_count: 5 });

        expect(text).toBe('{"title":"A","hash":"abc123","line_count":5}');
        expect(JSON.parse(text)).toEqual({ title: 'A', hash: 'abc123', line_count: 5 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/format.test.js`
Expected: FAIL — `formatJson` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/format.js` — add:

```js
export function formatJson(result) {
    return JSON.stringify(result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/format.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/format.js src/format.test.js
git commit -m "feat(format): add formatJson, the shared compact-JSON formatter"
```

---

### Task 4: `assertSchemaCurrent` — schema-version-mismatch guard

**Files:**
- Create: `src/mcp/server.js`
- Create: `src/mcp/server.test.js`

**Interfaces:**
- Consumes: `SCHEMA_VERSION` from `src/core/db.js` (S001, already implemented); a raw `node:sqlite`
  `DatabaseSync` connection opened directly (**not** via `core/db.js`'s `openDb`, per the Architecture
  note above — `openDb` would itself perform the DDL rebuild this function exists to prevent the MCP
  server from ever triggering).
- Produces: `assertSchemaCurrent(dbPath) -> void`, throwing a clear, actionable error naming the daemon
  as the fix when the stored `meta.schema_version` is missing or doesn't match `SCHEMA_VERSION`; no
  throw when it matches. `main()` (Task 14) calls this before ever calling `openDb`.

- [ ] **Step 1: Write the failing tests**

Create `src/mcp/server.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setMeta } from '../core/db.js';
import { assertSchemaCurrent } from './server.js';

const tempDirs = [];

function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-mcp-server-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('assertSchemaCurrent', () => {
    it('does not throw when the stored schema_version matches SCHEMA_VERSION', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const { db } = openDb(dbPath);
        db.close();

        expect(() => assertSchemaCurrent(dbPath)).not.toThrow();
    });

    it('throws a clear, actionable error mentioning the daemon when the version is stale', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const { db } = openDb(dbPath);
        setMeta(db, 'schema_version', '999');
        db.close();

        expect(() => assertSchemaCurrent(dbPath)).toThrow(/schema.*out of date|daemon/i);
    });

    it('throws the same guard error when the meta table does not exist at all', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const bootstrap = new DatabaseSync(dbPath);
        bootstrap.close();

        expect(() => assertSchemaCurrent(dbPath)).toThrow(/schema.*out of date|daemon/i);
    });

    it('never performs a schema rebuild as a side effect of checking', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const { db } = openDb(dbPath);
        setMeta(db, 'schema_version', '999');
        db.close();

        expect(() => assertSchemaCurrent(dbPath)).toThrow();

        // Re-inspect with a fresh raw connection: still stale, proving assertSchemaCurrent did not
        // rebuild/rewrite the version the way openDb would have.
        const inspect = new DatabaseSync(dbPath);
        const row = inspect.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        inspect.close();
        expect(row.value).toBe('999');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/server.test.js`
Expected: FAIL — `src/mcp/server.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/server.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../core/db.js';

function readStoredSchemaVersion(dbPath) {
    const db = new DatabaseSync(dbPath);
    try {
        const tableRow = db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        ).get();
        if (!tableRow) {
            return null;
        }
        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        return row ? Number(row.value) : null;
    } finally {
        db.close();
    }
}

export function assertSchemaCurrent(dbPath) {
    const storedVersion = readStoredSchemaVersion(dbPath);

    if (storedVersion !== SCHEMA_VERSION) {
        throw new Error(
            `mnotes-mcp: index schema is out of date or missing (expected version ${SCHEMA_VERSION}, `
            + `found ${storedVersion === null ? 'none' : storedVersion}). Ensure the mnotes indexing `
            + 'daemon is running — it owns schema migration and rebuilds the index on startup.',
        );
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.js src/mcp/server.test.js
git commit -m "feat(mcp): add assertSchemaCurrent guard, never DDL from the MCP process"
```

---

### Task 5: `search` tool handler

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `search` from `src/core/search.js` (S002); `callTool`, `formatSearchTable` from Tasks 1–2.
- Produces: `searchTool(deps, input) -> Promise<{ content, isError? }>`, where `deps = { db, embed,
  embeddingModel, embeddingVersion }` and `input = { query, mode = 'hybrid', limit = 20, reason }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js` (new imports and shared fixtures near the top):

```js
import { openDb } from '../core/db.js';
import { searchTool } from './tools.js';

function insertNote(db, { path, contentHash = 'hash', lineCount = 10, mtime = 1000 }) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, contentHash, lineCount, mtime, mtime);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function insertFtsRow(db, noteId, title, body) {
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

async function fakeEmbed() {
    return new Float32Array(1024).fill(0.1);
}
```

```js
describe('searchTool', () => {
    it('returns a pipe-delimited table for a fulltext hit', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Recipe.md', lineCount: 5 });
        insertFtsRow(db, noteId, 'Recipe', 'a note about knowledge graphs');

        const result = await searchTool(
            { db, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' },
            { query: 'graphs', mode: 'fulltext', limit: 20, reason: 'testing search' },
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe('note_title|file_line_count\nRecipe|5');
        db.close();
    });

    it('maps a thrown search() error (malformed FTS5 syntax) to isError: true', async () => {
        const { db } = openDb(':memory:');

        const result = await searchTool(
            { db, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' },
            { query: '"unterminated', mode: 'fulltext', limit: 20, reason: 'testing search' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/malformed/i);
        db.close();
    });

    it('defaults mode to hybrid and includes rank columns when omitted', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'Both.md' });
        insertFtsRow(db, noteId, 'Both', 'graph search');

        const result = await searchTool(
            { db, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' },
            { query: 'graph', reason: 'testing default mode' },
        );

        expect(result.content[0].text).toContain('fulltext_rank|semantic_rank');
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `searchTool is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { search } from '../core/search.js';
import { formatSearchTable } from '../format.js';

export async function searchTool(deps, input) {
    const { db, embed, embeddingModel, embeddingVersion } = deps;
    const { query, mode = 'hybrid', limit = 20 } = input;

    return callTool(async () => {
        const results = await search(db, { query, mode, limit, embed, embeddingModel, embeddingVersion });
        return formatSearchTable(results, mode);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add search tool handler"
```

---

### Task 6: `grep` tool handler

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `grep` from `src/core/grep.js` (S004); `callTool`, `formatGrepTable` from Tasks 1–2.
- Produces: `grepTool(deps, input) -> Promise<{ content, isError? }>`, where `deps = { vaultRoot }` and
  `input = { pattern, regex = false, note_title = null, reason }`. Uses a real temp vault directory and
  the real `rg` binary in tests, matching `S004-grep-tags`'s "real, not mocked" posture.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js` (new imports and a temp-vault helper):

```js
import { mkdtempSync as mkdtempSyncVault, rmSync as rmSyncVault, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { grepTool } from './tools.js';

const vaultTempDirs = [];

function makeTempVault(files) {
    const dir = mkdtempSyncVault(joinPath(tmpdir(), 'mnotes-mcp-grep-test-'));
    vaultTempDirs.push(dir);
    for (const [ relPath, content ] of Object.entries(files)) {
        writeFileSync(joinPath(dir, relPath), content);
    }
    return dir;
}

afterEach(() => {
    while (vaultTempDirs.length > 0) {
        rmSyncVault(vaultTempDirs.pop(), { recursive: true, force: true });
    }
});
```

(Add `afterEach` to the existing `vitest` import at the top of the file if not already imported.)

```js
describe('grepTool', () => {
    it('returns a pipe-delimited table with capped line_matches', () => {
        return (async () => {
            const vaultRoot = makeTempVault({ 'Recipe.md': 'line one\nsome hello world text\n' });

            const result = await grepTool(
                { vaultRoot },
                { pattern: 'hello', reason: 'testing grep' },
            );

            expect(result.isError).toBeUndefined();
            expect(result.content[0].text).toBe(
                'note_title|file_line_count|line_matches\nRecipe|3|L2: some hello world text',
            );
        })();
    });

    it('maps a thrown grep() error (unknown note_title) to isError: true', async () => {
        const vaultRoot = makeTempVault({ 'A.md': 'apple pie\n' });

        const result = await grepTool(
            { vaultRoot },
            { pattern: 'apple', note_title: 'Nonexistent', reason: 'testing scoped grep' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/note not found/i);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `grepTool is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { grep } from '../core/grep.js';
import { formatGrepTable } from '../format.js';

export async function grepTool(deps, input) {
    const { vaultRoot } = deps;
    const { pattern, regex = false, note_title: noteTitle = null } = input;

    return callTool(async () => {
        const results = grep(vaultRoot, pattern, { regex, noteTitle });
        return formatGrepTable(results);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add grep tool handler"
```

---

### Task 7: `tag_list` and `tag_notes` tool handlers

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `tagList`, `tagNotes`, `syncNoteTags` from `src/core/tags.js` (S004); `callTool`,
  `formatTagListTable`, `formatTagNotesTable` from Tasks 1–2.
- Produces: `tagListTool(deps, input) -> Promise<{ content, isError? }>` (`deps = { db }`, `input =
  { reason }`) and `tagNotesTool(deps, input)` (`deps = { db }`, `input = { tag, reason }`). Grouped
  into one task since both are trivial read-only wrappers around a single `core/tags.js` query.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js`:

```js
import { syncNoteTags } from '../core/tags.js';
import { tagListTool, tagNotesTool } from './tools.js';

describe('tagListTool', () => {
    it('returns a pipe-delimited table of tag/notes_with_tag', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md' });
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await tagListTool({ db }, { reason: 'testing tag_list' });

        expect(result.content[0].text).toBe('tag|notes_with_tag\nproject|1');
        db.close();
    });
});

describe('tagNotesTool', () => {
    it('returns a pipe-delimited table of matching notes, parent-includes-child', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertNote(db, { path: 'A.md', lineCount: 3 });
        syncNoteTags(db, noteId, [ 'project/api-migration' ]);

        const result = await tagNotesTool({ db }, { tag: 'project', reason: 'testing tag_notes' });

        expect(result.content[0].text).toBe('note_title|file_line_count\nA|3');
        db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `tagListTool`/`tagNotesTool` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { tagList, tagNotes } from '../core/tags.js';
import { formatTagListTable, formatTagNotesTable } from '../format.js';

export async function tagListTool(deps) {
    const { db } = deps;
    return callTool(async () => formatTagListTable(tagList(db)));
}

export async function tagNotesTool(deps, input) {
    const { db } = deps;
    const { tag } = input;
    return callTool(async () => formatTagNotesTable(tagNotes(db, tag)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add tag_list and tag_notes tool handlers"
```

---

### Task 8: `note_read` tool handler

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `noteRead` from `src/core/notes.js` (S003); `callTool`, `formatJson` from Tasks 1/3.
- Produces: `noteReadTool(deps, input) -> Promise<{ content, isError? }>`, where `deps = { vaultRoot }`
  and `input = { note_title, start_line, end_line, reason }`. Always structured JSON — no CLI-style
  `--raw`/plain-text mode, per S007's explicit "MCP has no equivalent of the CLI's `--raw` mode."

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js` (new imports and a temp-vault-with-note helper):

```js
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { noteReadTool } from './tools.js';

function writeRawNote(vaultRoot, title, raw) {
    const filePath = joinPath(vaultRoot, `${title}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');
    return filePath;
}
```

```js
describe('noteReadTool', () => {
    it('returns structured JSON with title/content/metadata/content_hash', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Plain Note', 'body text');

        const result = await noteReadTool(
            { vaultRoot },
            { note_title: 'Plain Note', reason: 'testing note_read' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.title).toBe('Plain Note');
        expect(parsed.content).toBe('body text');
        expect(parsed.metadata).toEqual({});
        expect(typeof parsed.content_hash).toBe('string');
    });

    it('maps a missing-note error to isError: true with the message preserved', async () => {
        const vaultRoot = makeTempVault({});

        const result = await noteReadTool(
            { vaultRoot },
            { note_title: 'Does Not Exist', reason: 'testing missing note' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/not found/i);
    });

    it('passes start_line/end_line through to noteRead for windowing', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Multi', 'line1\nline2\nline3\n');

        const result = await noteReadTool(
            { vaultRoot },
            { note_title: 'Multi', start_line: 2, end_line: 3, reason: 'testing windowing' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.content).toBe('line2\nline3');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `noteReadTool is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { noteRead } from '../core/notes.js';
import { formatJson } from '../format.js';

export async function noteReadTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, start_line: startLine, end_line: endLine } = input;

    return callTool(async () => {
        const result = noteRead(vaultRoot, noteTitle, { startLine, endLine });
        return formatJson(result);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add note_read tool handler"
```

---

### Task 9: `note_write` tool handler

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `noteWrite` from `src/core/notes.js` (S003); `callTool`, `formatJson` from Tasks 1/3.
- Produces: `noteWriteTool(deps, input) -> Promise<{ content, isError? }>`, where `deps = { vaultRoot }`
  and `input = { note_title, hash, metadata = null, content, force = false, reason }`. `hash` is
  required-but-nullable (create vs. update dispatch lives entirely inside `noteWrite`, per S003) —
  this handler never inspects `hash` itself, just passes it through.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js`:

```js
import { noteWriteTool } from './tools.js';

describe('noteWriteTool', () => {
    it('creates a new note when hash is null, returning { title, hash, line_count } as JSON', async () => {
        const vaultRoot = makeTempVault({});

        const result = await noteWriteTool(
            { vaultRoot },
            { note_title: 'New Note', hash: null, content: 'hello world', reason: 'testing create' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.title).toBe('New Note');
        expect(parsed.line_count).toBe(1);
        expect(typeof parsed.hash).toBe('string');
    });

    it('maps "already exists" (null hash against existing title) to isError: true', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Existing', 'already here');

        const result = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Existing', hash: null, content: 'overwrite attempt', reason: 'testing guard' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/already exists/i);
    });

    it('bypasses the size-drop guard when force: true is passed', async () => {
        const vaultRoot = makeTempVault({});
        const created = await noteWriteTool(
            { vaultRoot },
            {
                note_title: 'Shrinking', hash: null,
                content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10', reason: 'setup',
            },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Shrinking', hash, content: 'l1', force: true, reason: 'testing force' },
        );

        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text).line_count).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `noteWriteTool is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { noteWrite } from '../core/notes.js';

export async function noteWriteTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, hash, metadata = null, content, force = false } = input;

    return callTool(async () => {
        const result = noteWrite(vaultRoot, noteTitle, { hash, metadata, content, force });
        return formatJson(result);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add note_write tool handler"
```

---

### Task 10: `note_edit` and `note_append` tool handlers

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `noteEdit`, `noteAppend` from `src/core/notes.js` (S003); `callTool`, `formatJson` from
  Tasks 1/3.
- Produces: `noteEditTool(deps, input)` (`input = { note_title, hash, old_txt, new_txt, metadata =
  null, reason }` — `hash` required, non-nullable, no `force`, per S003's Task 6 design decision that
  S007's finalized schema has no `force` for `note_edit`) and `noteAppendTool(deps, input)` (`input =
  { note_title, hash, content, reason }` — no `metadata` param at all, per S007). Grouped since both
  are hash-required mutations with near-identical shape.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js`:

```js
import { noteEditTool, noteAppendTool } from './tools.js';

describe('noteEditTool', () => {
    it('replaces old_txt with new_txt exactly once, returning JSON', async () => {
        const vaultRoot = makeTempVault({});
        const created = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Editable', hash: null, content: 'the quick fox', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteEditTool(
            { vaultRoot },
            {
                note_title: 'Editable', hash, old_txt: 'quick', new_txt: 'slow',
                reason: 'testing edit',
            },
        );

        expect(result.isError).toBeUndefined();
        const read = await noteReadTool({ vaultRoot }, { note_title: 'Editable', reason: 'verify' });
        expect(JSON.parse(read.content[0].text).content).toBe('the slow fox');
    });

    it('maps an ambiguous old_txt match to isError: true', async () => {
        const vaultRoot = makeTempVault({});
        const created = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Ambiguous', hash: null, content: 'foo bar foo', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteEditTool(
            { vaultRoot },
            { note_title: 'Ambiguous', hash, old_txt: 'foo', new_txt: 'baz', reason: 'testing ambiguity' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/ambiguous|matches \d+ times/i);
    });
});

describe('noteAppendTool', () => {
    it('appends content and returns { title, hash, line_count } as JSON', async () => {
        const vaultRoot = makeTempVault({});
        const created = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Appendable', hash: null, content: 'first line', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteAppendTool(
            { vaultRoot },
            { note_title: 'Appendable', hash, content: 'second line', reason: 'testing append' },
        );

        expect(JSON.parse(result.content[0].text).line_count).toBe(2);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `noteEditTool`/`noteAppendTool` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { noteEdit, noteAppend } from '../core/notes.js';

export async function noteEditTool(deps, input) {
    const { vaultRoot } = deps;
    const {
        note_title: noteTitle, hash, old_txt: oldTxt, new_txt: newTxt, metadata = null,
    } = input;

    return callTool(async () => {
        const result = noteEdit(vaultRoot, noteTitle, { hash, oldTxt, newTxt, metadata });
        return formatJson(result);
    });
}

export async function noteAppendTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, hash, content } = input;

    return callTool(async () => {
        const result = noteAppend(vaultRoot, noteTitle, hash, content);
        return formatJson(result);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add note_edit and note_append tool handlers"
```

---

### Task 11: `note_rename` tool handler

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `noteRename` from `src/core/notes.js` (S003); `callTool`, `formatJson` from Tasks 1/3.
- Produces: `noteRenameTool(deps, input) -> Promise<{ content, isError? }>`, where `deps = { vaultRoot
  }` and `input = { old_title, new_title, hash, reason }`. Hard error if `new_title` already exists —
  no `force` override exists on this tool at all (S007), so there's nothing for this handler to pass
  through beyond the three required fields.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js`:

```js
import { noteRenameTool } from './tools.js';

describe('noteRenameTool', () => {
    it('renames and returns { title: new_title, hash, line_count } as JSON', async () => {
        const vaultRoot = makeTempVault({});
        const created = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Old Name', hash: null, content: 'body unchanged', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteRenameTool(
            { vaultRoot },
            { old_title: 'Old Name', new_title: 'New Name', hash, reason: 'testing rename' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.title).toBe('New Name');
    });

    it('hard-errors when new_title already exists, with no force override available', async () => {
        const vaultRoot = makeTempVault({});
        const created = await noteWriteTool(
            { vaultRoot },
            { note_title: 'Source', hash: null, content: 'source body', reason: 'setup' },
        );
        await noteWriteTool(
            { vaultRoot },
            { note_title: 'Target', hash: null, content: 'target body', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteRenameTool(
            { vaultRoot },
            { old_title: 'Source', new_title: 'Target', hash, reason: 'testing collision' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/already exists/i);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `noteRenameTool is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js` — add:

```js
import { noteRename } from '../core/notes.js';

export async function noteRenameTool(deps, input) {
    const { vaultRoot } = deps;
    const { old_title: oldTitle, new_title: newTitle, hash } = input;

    return callTool(async () => {
        const result = noteRename(vaultRoot, oldTitle, newTitle, hash);
        return formatJson(result);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS (all 9 tools now have a handler)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): add note_rename tool handler"
```

---

### Task 12: Audit logging — extend `callTool`, thread `auditLogger` through every handler

**Files:**
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `logAudit` from `src/logger.js` (S008 — `entry = { tool, noteTitle, source, reason,
  outcome, errorMessage }`, `source: 'mcp'` always here).
- Produces: `callTool`'s signature changes to `callTool(auditLogger, toolName, input, fn) ->
  Promise<{ content, isError? }>` — every successful *and* failed call now writes exactly one audit
  log entry (S008's "outcome: success/error" — a failed mutation is a normal audit event, not a system
  error, matching S008's own reasoning). Every one of the 9 handlers from Tasks 5–11 is updated to call
  this new signature, passing `deps.auditLogger` and the tool's snake_case name.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools.test.js` (new imports and a temp-log-dir helper):

```js
import { readFileSync } from 'node:fs';
import { getAuditLogger } from '../logger.js';

const logTempDirs = [];

function makeTempLogDir() {
    const dir = mkdtempSyncVault(joinPath(tmpdir(), 'mnotes-mcp-audit-test-'));
    logTempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (logTempDirs.length > 0) {
        rmSyncVault(logTempDirs.pop(), { recursive: true, force: true });
    }
});

function readAuditLines(logDir) {
    return readFileSync(joinPath(logDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
}
```

Replace the existing `describe('callTool', ...)` block with:

```js
describe('callTool', () => {
    it('wraps a successful result and logs a success audit entry', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        const result = await callTool(
            auditLogger, 'search', { reason: 'testing audit success' },
            async () => 'ok',
        );

        expect(result).toEqual({ content: [ { type: 'text', text: 'ok' } ] });
        const [ line ] = readAuditLines(logDir);
        expect(line).toMatchObject({
            tool: 'search', source: 'mcp', reason: 'testing audit success', outcome: 'success',
            error_message: null,
        });
    });

    it('maps a thrown Error to isError: true and logs an error audit entry', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        const result = await callTool(
            auditLogger, 'note_write', { note_title: 'X', reason: 'testing audit failure' },
            async () => { throw new Error('hash mismatch'); },
        );

        expect(result).toEqual({
            content: [ { type: 'text', text: 'hash mismatch' } ],
            isError: true,
        });
        const [ line ] = readAuditLines(logDir);
        expect(line).toMatchObject({
            tool: 'note_write', note_title: 'X', source: 'mcp', outcome: 'error',
            error_message: 'hash mismatch',
        });
    });

    it('logs note_title from old_title when present (note_rename), null otherwise', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        await callTool(
            auditLogger, 'note_rename',
            { old_title: 'Old', new_title: 'New', reason: 'testing rename audit' },
            async () => 'ok',
        );
        await callTool(auditLogger, 'search', { reason: 'testing null note_title' }, async () => 'ok');

        const [ renameLine, searchLine ] = readAuditLines(logDir);
        expect(renameLine.note_title).toBe('Old');
        expect(searchLine.note_title).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: FAIL — `callTool`'s current 1-argument signature ignores the new arguments entirely, so no
audit log line is ever written and `readAuditLines` throws (`audit.log` doesn't exist).

- [ ] **Step 3: Write minimal implementation**

Update `src/mcp/tools.js`:

1. Add the import and replace `callTool`:

```js
import { logAudit } from '../logger.js';

export async function callTool(auditLogger, toolName, input, fn) {
    const noteTitle = input.note_title ?? input.old_title ?? null;
    let text;

    try {
        text = await fn();
    } catch (err) {
        logAudit(auditLogger, {
            tool: toolName,
            noteTitle,
            source: 'mcp',
            reason: input.reason,
            outcome: 'error',
            errorMessage: err.message,
        });
        return { content: [ { type: 'text', text: err.message } ], isError: true };
    }

    logAudit(auditLogger, {
        tool: toolName,
        noteTitle,
        source: 'mcp',
        reason: input.reason,
        outcome: 'success',
        errorMessage: null,
    });
    return { content: [ { type: 'text', text } ] };
}
```

2. Update every one of the 9 handlers to pass `(deps.auditLogger, '<tool_name>', input, fn)` instead of
   `(fn)`. Each change is a one-line edit to the `return callTool(...)` call; the tool name string
   matches the wire-format tool name exactly (`snake_case`, matching S007's tool table):

```js
export async function searchTool(deps, input) {
    const { db, embed, embeddingModel, embeddingVersion } = deps;
    const { query, mode = 'hybrid', limit = 20 } = input;

    return callTool(deps.auditLogger, 'search', input, async () => {
        const results = await search(db, { query, mode, limit, embed, embeddingModel, embeddingVersion });
        return formatSearchTable(results, mode);
    });
}

export async function grepTool(deps, input) {
    const { vaultRoot } = deps;
    const { pattern, regex = false, note_title: noteTitle = null } = input;

    return callTool(deps.auditLogger, 'grep', input, async () => {
        const results = grep(vaultRoot, pattern, { regex, noteTitle });
        return formatGrepTable(results);
    });
}

export async function tagListTool(deps, input) {
    const { db } = deps;
    return callTool(deps.auditLogger, 'tag_list', input, async () => formatTagListTable(tagList(db)));
}

export async function tagNotesTool(deps, input) {
    const { db } = deps;
    const { tag } = input;
    return callTool(deps.auditLogger, 'tag_notes', input, async () => formatTagNotesTable(tagNotes(db, tag)));
}

export async function noteReadTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, start_line: startLine, end_line: endLine } = input;

    return callTool(deps.auditLogger, 'note_read', input, async () => {
        const result = noteRead(vaultRoot, noteTitle, { startLine, endLine });
        return formatJson(result);
    });
}

export async function noteWriteTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, hash, metadata = null, content, force = false } = input;

    return callTool(deps.auditLogger, 'note_write', input, async () => {
        const result = noteWrite(vaultRoot, noteTitle, { hash, metadata, content, force });
        return formatJson(result);
    });
}

export async function noteEditTool(deps, input) {
    const { vaultRoot } = deps;
    const {
        note_title: noteTitle, hash, old_txt: oldTxt, new_txt: newTxt, metadata = null,
    } = input;

    return callTool(deps.auditLogger, 'note_edit', input, async () => {
        const result = noteEdit(vaultRoot, noteTitle, { hash, oldTxt, newTxt, metadata });
        return formatJson(result);
    });
}

export async function noteAppendTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, hash, content } = input;

    return callTool(deps.auditLogger, 'note_append', input, async () => {
        const result = noteAppend(vaultRoot, noteTitle, hash, content);
        return formatJson(result);
    });
}

export async function noteRenameTool(deps, input) {
    const { vaultRoot } = deps;
    const { old_title: oldTitle, new_title: newTitle, hash } = input;

    return callTool(deps.auditLogger, 'note_rename', input, async () => {
        const result = noteRename(vaultRoot, oldTitle, newTitle, hash);
        return formatJson(result);
    });
}
```

3. Every test added in Tasks 5–11 that calls a handler directly (not through `callTool`) now needs a
   real `auditLogger` in its `deps` object and a `reason` in its `input` object, since `logAudit`
   throws if `source: 'mcp'` and `reason` is falsy (S008). Update each prior test's `deps` literal from
   e.g. `{ db, embed, embeddingModel, embeddingVersion }` to `{ db, embed, embeddingModel,
   embeddingVersion, auditLogger: getAuditLogger(makeTempLogDir()) }` (and the `vaultRoot`-only ones
   similarly) — every prior test already includes a `reason` string in its `input`, so this is a
   `deps`-object-only edit, not a rewrite.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/tools.test.js`
Expected: PASS (full `tools.js` suite green — every handler test from Tasks 5–11 plus the new audit
tests)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.js src/mcp/tools.test.js
git commit -m "feat(mcp): wire S008 audit logging through every tool handler via callTool"
```

---

### Task 13: `prompts.js` stub — empty prompt list

**Files:**
- Create: `src/mcp/prompts.js`
- Create: `src/mcp/prompts.test.js`

**Interfaces:**
- Produces: `registerPrompts(server) -> void` — registers zero prompts against a real `McpServer`
  instance. Exists purely so `server.js`'s bootstrap has one uniform call site
  (`registerPrompts(server)`) regardless of whether any prompts exist yet, per S007's "Prompts —
  explicitly out of scope here" (deferred to a future spec).

- [ ] **Step 1: Write the failing test**

Create `src/mcp/prompts.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPrompts } from './prompts.js';

describe('registerPrompts', () => {
    it('does not throw when called against a real McpServer with no prompts to register', () => {
        const server = new McpServer({ name: 'mnotes-mcp', version: '0.1.0' });

        expect(() => registerPrompts(server)).not.toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/mcp/prompts.test.js`
Expected: FAIL — `src/mcp/prompts.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/prompts.js`:

```js
// Prompts are explicitly out of scope for S007 — see docs/specs/S007-mcp-server.md "Prompts". The
// README names 5 candidates (weekly review automation, note triage, stale note detection, weekly
// note scaffolding, orphan note identification) as identified but undesigned; each needs its own
// design pass, deferred to a dedicated follow-up spec once the tool set above is built and in use.
// This function is a stub — zero prompts registered — so server.js has one uniform bootstrap call
// site that doesn't need to change shape once prompts eventually land.
export function registerPrompts() {
    // Intentionally empty.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/mcp/prompts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/prompts.js src/mcp/prompts.test.js
git commit -m "feat(mcp): add prompts.js stub, no prompts registered (deferred spec)"
```

---

### Task 14: `server.js` bootstrap — `createServer`, tool registration, stdio `main()`

**Files:**
- Modify: `package.json` (add `zod` dependency)
- Modify: `src/mcp/server.js`
- Modify: `src/mcp/server.test.js`

**Interfaces:**
- Consumes: every handler from `src/mcp/tools.js` (Tasks 5–12); `registerPrompts` from
  `src/mcp/prompts.js` (Task 13); `assertSchemaCurrent` from Task 4; `openDb` (S001), `embed` /
  `DEFAULT_MODEL_ID` (S005), `getAuditLogger` / `defaultLogDir` (S008).
- Produces: `createServer(deps) -> McpServer` (builds and registers, never connects — fully testable in
  isolation) and `main() -> Promise<void>` (wires real dependencies, calls `assertSchemaCurrent` before
  `openDb`, connects `StdioServerTransport`, guarded so importing `server.js` in tests never starts a
  real process). This task is the one place `zod` schemas for all 9 tools' `inputSchema` live, per the
  `@modelcontextprotocol/sdk`'s `registerTool` API.

- [ ] **Step 1: Add the `zod` dependency**

Run: `pnpm add zod@^3.25`

- [ ] **Step 2: Write the failing test**

Add to `src/mcp/server.test.js`:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../core/db.js';
import { getAuditLogger } from '../logger.js';
import { createServer } from './server.js';

async function connectedClient(deps) {
    const server = createServer(deps);
    const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
    ]);

    return client;
}

describe('createServer', () => {
    it('registers all 9 tools, listable over a real (in-memory) MCP connection', async () => {
        const { db } = openDb(':memory:');
        const vaultRoot = makeTempDir();
        const auditLogger = getAuditLogger(makeTempDir());
        async function fakeEmbed() {
            return new Float32Array(1024).fill(0.1);
        }

        const client = await connectedClient({
            db, vaultRoot, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1', auditLogger,
        });
        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name).sort()).toEqual([
            'grep', 'note_append', 'note_edit', 'note_read', 'note_rename', 'note_write',
            'search', 'tag_list', 'tag_notes',
        ]);
    });

    it('round-trips a real search tool call end-to-end through the client', async () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'h', 3, 1000, 1000);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(1, 'A', 'hello world');
        const vaultRoot = makeTempDir();
        const auditLogger = getAuditLogger(makeTempDir());
        async function fakeEmbed() {
            return new Float32Array(1024).fill(0.1);
        }

        const client = await connectedClient({
            db, vaultRoot, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1', auditLogger,
        });
        const result = await client.callTool({
            name: 'search',
            arguments: { query: 'hello', mode: 'fulltext', reason: 'end-to-end test' },
        });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toBe('note_title|file_line_count\nA|3');
    });

    it('rejects a tool call missing the required reason argument', async () => {
        const { db } = openDb(':memory:');
        const vaultRoot = makeTempDir();
        const auditLogger = getAuditLogger(makeTempDir());
        async function fakeEmbed() {
            return new Float32Array(1024).fill(0.1);
        }

        const client = await connectedClient({
            db, vaultRoot, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1', auditLogger,
        });

        await expect(
            client.callTool({ name: 'tag_list', arguments: {} }),
        ).rejects.toThrow();
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/mcp/server.test.js`
Expected: FAIL — `createServer` is not exported yet.

- [ ] **Step 4: Write minimal implementation**

Update `src/mcp/server.js` — add imports, the `zod` schemas, `TOOL_DEFS`, `createServer`, and `main`
(keep `assertSchemaCurrent`/`readStoredSchemaVersion` from Task 4 unchanged):

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDb } from '../core/db.js';
import { getAuditLogger, defaultLogDir } from '../logger.js';
import { embed, DEFAULT_MODEL_ID } from '../indexer/embed.js';
import { registerPrompts } from './prompts.js';
import {
    searchTool, grepTool, tagListTool, tagNotesTool, noteReadTool, noteWriteTool,
    noteEditTool, noteAppendTool, noteRenameTool,
} from './tools.js';

const SEARCH_DESCRIPTION = 'Full-text, semantic, or hybrid search over the vault. FTS5 query syntax '
    + '(AND/OR/NOT, "phrase", word*, NEAR) is live in both fulltext and hybrid mode — a malformed '
    + 'expression is a hard error in either mode, not just fulltext.';

const TOOL_DEFS = [
    {
        name: 'search',
        description: SEARCH_DESCRIPTION,
        inputSchema: {
            query: z.string(),
            mode: z.enum([ 'fulltext', 'semantic', 'hybrid' ]).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            reason: z.string(),
        },
        handler: searchTool,
    },
    {
        name: 'grep',
        description: 'Ripgrep-backed literal or regex search over vault note files.',
        inputSchema: {
            pattern: z.string(),
            regex: z.boolean().optional(),
            note_title: z.string().optional(),
            reason: z.string(),
        },
        handler: grepTool,
    },
    {
        name: 'tag_list',
        description: 'List every tag currently in use, with an exact-match note count per tag.',
        inputSchema: { reason: z.string() },
        handler: tagListTool,
    },
    {
        name: 'tag_notes',
        description: 'List notes carrying a tag, including nested child tags (parent-includes-child).',
        inputSchema: { tag: z.string(), reason: z.string() },
        handler: tagNotesTool,
    },
    {
        name: 'note_read',
        description: 'Read a note by title, optionally windowed to a line range.',
        inputSchema: {
            note_title: z.string(),
            start_line: z.number().int().optional(),
            end_line: z.number().int().optional(),
            reason: z.string(),
        },
        handler: noteReadTool,
    },
    {
        name: 'note_write',
        description: 'Create a note (hash: null) or fully replace an existing one (hash matches its '
            + 'current content_hash). No hash against an existing title is an error, not a silent '
            + 'overwrite.',
        inputSchema: {
            note_title: z.string(),
            hash: z.string().nullable(),
            metadata: z.record(z.string(), z.any()).nullable().optional(),
            content: z.string(),
            force: z.boolean().optional(),
            reason: z.string(),
        },
        handler: noteWriteTool,
    },
    {
        name: 'note_edit',
        description: 'Surgically replace old_txt with new_txt in an existing note. old_txt must '
            + 'match exactly once.',
        inputSchema: {
            note_title: z.string(),
            hash: z.string(),
            old_txt: z.string(),
            new_txt: z.string(),
            metadata: z.record(z.string(), z.any()).nullable().optional(),
            reason: z.string(),
        },
        handler: noteEditTool,
    },
    {
        name: 'note_append',
        description: 'Append content to the end of an existing note.',
        inputSchema: {
            note_title: z.string(),
            hash: z.string(),
            content: z.string(),
            reason: z.string(),
        },
        handler: noteAppendTool,
    },
    {
        name: 'note_rename',
        description: 'Rename a note. Hard error if new_title already exists — no force override.',
        inputSchema: {
            old_title: z.string(),
            new_title: z.string(),
            hash: z.string(),
            reason: z.string(),
        },
        handler: noteRenameTool,
    },
];

export function createServer(deps) {
    const server = new McpServer({ name: 'mnotes-mcp', version: '0.1.0' });

    for (const { name, description, inputSchema, handler } of TOOL_DEFS) {
        server.registerTool(name, { description, inputSchema }, (input) => handler(deps, input));
    }

    registerPrompts(server);

    return server;
}

const EMBEDDING_VERSION = '1'; // stand-in pending S009's config.toml embedding_version key

export async function main() {
    const dbPath = process.env.MNOTES_DB_PATH;
    const vaultRoot = process.env.MNOTES_VAULT_ROOT;

    if (!dbPath || !vaultRoot) {
        throw new Error(
            'mnotes-mcp: MNOTES_DB_PATH and MNOTES_VAULT_ROOT must be set in the environment '
            + '(config.toml-based resolution lands in S009).',
        );
    }

    assertSchemaCurrent(dbPath);
    const { db } = openDb(dbPath);
    const auditLogger = getAuditLogger(defaultLogDir());

    const server = createServer({
        db,
        vaultRoot,
        embed,
        embeddingModel: DEFAULT_MODEL_ID,
        embeddingVersion: EMBEDDING_VERSION,
        auditLogger,
    });

    await server.connect(new StdioServerTransport());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        process.stderr.write(`mnotes-mcp: fatal: ${err.message}\n`);
        process.exit(1);
    });
}
```

Also add the temp-dir test helper `makeTempDir` used above, if `src/mcp/server.test.js` doesn't already
have one from Task 4 (it does — reuse it, no change needed there).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/mcp/server.test.js`
Expected: PASS (full file green — schema-guard tests from Task 4 plus the three new `createServer`
end-to-end tests)

- [ ] **Step 6: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass across `src/mcp/tools.test.js`, `src/mcp/server.test.js`,
`src/mcp/prompts.test.js`; no lint errors.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/mcp/server.js src/mcp/server.test.js
git commit -m "feat(mcp): bootstrap McpServer with all 9 tools, stdio transport, schema guard"
```

---

## Self-Review Notes

- **Spec coverage**: all 9 tools S007 finalizes (`search`, `grep`, `tag_list`, `tag_notes`,
  `note_read`, `note_write`, `note_edit`, `note_append`, `note_rename`) have a dedicated handler, exact
  input/output field names matching the spec verbatim (`old_txt`/`new_txt`, `old_title`/`new_title`,
  `line_matches` capped-at-10-plus-"(+N more)", `notes_with_tag`, `content_hash`, ...), a required
  `reason<string>` on every tool (enforced by `zod` at the protocol boundary in Task 14), the two output
  formats (pipe-delimited for list tools, structured JSON for `note_read` + the four mutators), verbatim
  error-message preservation with `isError: true` (Task 1, exercised per-tool in Tasks 5–11), S008 audit
  logging with `source: 'mcp'` (Task 12), the `mnotes-mcp` stdio bin entry (Task 14, matches
  `package.json`'s existing `bin` field), the schema-version-mismatch guard that never lets the MCP
  process perform DDL (Task 4), and the prompts stub (Task 13).
- **Important discovered wrinkle, resolved explicitly rather than silently worked around**:
  `core/db.js`'s already-implemented `openDb` (S001) rebuilds the schema unconditionally on a version
  mismatch, with no caller-controlled opt-out — but S007's spec is explicit that "the MCP server never
  attempts DDL itself." Calling `openDb` directly from `main()` would have violated that. This plan's
  `assertSchemaCurrent` (Task 4) reads `meta.schema_version` through its own short-lived raw
  `DatabaseSync` connection instead, and `main()` calls it *before* ever calling the real `openDb` — so
  by the time `openDb` runs, the version is already guaranteed current and its rebuild branch is
  structurally unreachable from the MCP process in practice. `core/db.js` itself is untouched.
- **Formatter ownership — reconciled with S006 after both plans were independently written**: this plan
  and `docs/plans/S006-cli.md` were planned concurrently, neither seeing the other's output, and
  disagreed on both the formatters' location and their exact behavior (header rows, delimiter, whether
  `formatJson` pretty-prints). That disagreement was resolved after the fact: formatters now live in
  `src/format.js` — a shared top-level module, per S006's location choice, so neither `cli/` nor `mcp/`
  imports across the other's directory — but using **this plan's** implementations (`formatTable`/
  `formatJson`/`formatSearchTable`/`formatGrepTable`/`formatTagListTable`/`formatTagNotesTable`, with
  header rows and compact JSON), since those were the spec-compliant ones. Tasks 2 and 3 above already
  reflect the reconciled state — `src/format.js`, not `mcp/tools.js`, is where these are built. See
  `docs/plans/S006-cli.md`'s own Self-Review Notes for its side of this reconciliation.
- **`zod` added as a new dependency**: `@modelcontextprotocol/sdk`'s `registerTool` API takes a
  `ZodRawShapeCompat` (or `AnySchema`) for `inputSchema`; `zod` is a declared peer dependency of the SDK
  but wasn't yet installed in this repo. Confirmed via `node_modules/@modelcontextprotocol/sdk/package.
  json`'s `peerDependencies` (`"zod": "^3.25 || ^4.0"`) before pinning `^3.25` here.
  `mcp/tools.js`'s handler functions themselves never import `zod` — schema definition is entirely
  `server.js`'s concern (Task 14), keeping the handlers plain-JS-args-in/plain-JS-object-out and
  trivially testable per CLAUDE.md's `core/`-style testing philosophy, even though `tools.js` isn't
  `core/` itself.
- **Config values not yet backed by `config.toml` (S009 doesn't exist yet)**: `vaultRoot` and the
  SQLite `dbPath` are read from `process.env.MNOTES_VAULT_ROOT`/`MNOTES_DB_PATH` in `main()` as an
  explicit, flagged stand-in — the same posture S002/S003/S005's plans took toward `limit` bounds,
  `SIZE_DROP_THRESHOLD`, and rotation policy numbers pending S009. `EMBEDDING_VERSION = '1'` in
  `server.js` is a similar placeholder for a `config.toml` value that doesn't exist yet; `embeddingModel`
  uses the real `DEFAULT_MODEL_ID` export from `indexer/embed.js` (S005) since that one *is* already a
  concrete, correct value today, not a stand-in.
- **Testing approach for `mcp/tools.js` and `mcp/server.js`, decided and justified per the task
  brief's request**: every one of the 9 handlers (Tasks 5–11) is tested by calling the exported handler
  function directly with a `deps` object built from real fixtures (`openDb(':memory:')` with
  hand-inserted rows, a real temp vault directory, a real `rg` binary for `grep`, a real `getAuditLogger`
  writing to a real temp log directory) — no SDK, no transport, no subprocess, matching CLAUDE.md's
  "don't spin up the MCP server" guidance in spirit even though that guidance is literally about testing
  `core/` logic. `server.js`'s `createServer` (Task 14) gets one additional, dedicated layer of test
  using the SDK's own `InMemoryTransport.createLinkedPair()` + a real `Client` — a **real** MCP
  client/server pair exchanging real JSON-RPC messages (proving `registerTool`'s wiring, `zod`
  validation, and the tool-name/response-shape contract actually work end-to-end), but with zero process
  spawning and zero real stdin/stdout, which is what makes it "lightweight" rather than the kind of
  literal subprocess-based integration test CLAUDE.md is warning against.
- **Explicitly out of scope, per S007's own "Explicitly out of scope here" section and this plan's
  framing**: the exact audit log entry shape's internals (`{ tool, note_title, source, reason,
  timestamp, outcome }`) belong to S008, already built — this plan only calls `logAudit`, never
  redefines its contract. `@modelcontextprotocol/sdk` registration boilerplate specifics beyond
  `registerTool`'s documented config shape are treated as implementation detail, not something this
  plan re-derives from first principles. Prompts (`registerPrompts`'s real content) are deferred to a
  dedicated follow-up spec per S007 — Task 13 only builds the stub. `reindex`/`stats` are CLI-only
  (S006) and never appear anywhere in this plan. `--explain`-style raw-score debug output is CLI-only
  (S006) and structurally impossible here anyway, since `core/search.js`'s `search()` never returns raw
  scores to any caller, MCP included.
- **Design decisions made without an exact spec sentence to point to, flagged rather than silently
  baked in**: (1) `note_rename`'s audit `note_title` is logged as `old_title` (the note identified and
  hash-checked by the input), not `new_title` (the post-mutation identity) — a judgment call, since the
  spec doesn't say which; (2) `formatSearchTable`'s column set is chosen by the caller-supplied `mode`
  string, not by inspecting whether the first result happens to carry rank fields, so an empty hybrid
  result set still gets a header with `fulltext_rank`/`semantic_rank` columns rather than silently
  collapsing to the 2-column fulltext/semantic shape; (3) `formatJson`'s compact (non-pretty-printed)
  `JSON.stringify` output, matching this project's token-efficiency bias stated throughout the README
  and S007 spec, though not spelled out as a literal requirement for the JSON-mode tools specifically.
- **Placeholder scan**: no TODOs/TBDs left in any code block; every step has complete, runnable code.
  Task 12's "update every prior test's `deps` object" step is the one place this plan asks an
  implementer to mechanically touch code shown in earlier tasks rather than reproducing every changed
  test verbatim a second time — flagged explicitly in that task's Step 3 rather than left as an
  unstated assumption, mirroring how `S002`'s Task 4 and `S001`'s Task 9→10 handle the same kind of
  later-task edit to earlier-task code.
- **Type/signature consistency**: `callTool` has exactly two signatures across this plan's lifetime —
  `(fn)` from Task 1 through Task 11, then `(auditLogger, toolName, input, fn)` from Task 12 onward,
  with the change and every call-site update landing in the same task/commit, never left half-migrated.
  Every one of the 9 handler functions keeps the identical `(deps, input) -> Promise<{ content,
  isError? }>` shape from the task that introduces it through the end of the plan. `assertSchemaCurrent
  (dbPath) -> void` (Task 4) and `createServer(deps) -> McpServer` (Task 14) are each introduced once
  and never change shape afterward.
