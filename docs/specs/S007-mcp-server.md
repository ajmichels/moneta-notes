# S007 — MCP Server

Status: **Approved**
Owns: `src/mcp/server.js`, `src/mcp/tools.js`, `src/mcp/prompts.js` (stub only — see Prompts)
Depends on: `S001-data-model`, `S002-search`, `S003-notes`, `S004-grep-tags`
Consumed by: Claude Code / Claude Desktop

## Purpose

Defines the finalized MCP tool set (superseding the README's tool section, which this spec brings up
to date with decisions made in S002/S003: `note_rename` is new, `note_edit` gains `metadata`, `search`
gains `limit`), server bootstrap, and how `core/` errors map to MCP tool responses. Prompts are
explicitly out of scope — see below.

## Transport

**stdio.** `mnotes-mcp` (the `bin` entry in `package.json`) is launched as a subprocess by Claude
Code/Desktop and communicates over stdin/stdout via `@modelcontextprotocol/sdk`'s stdio transport —
no network exposure, no port to configure. Standard setup for a locally-launched, single-user MCP
server.

## No daemon interaction

Every tool is a direct `core/` consumer — reads hit the SQLite index directly (WAL mode handles
concurrent readers safely alongside the daemon's writes), writes touch vault files directly and rely
on the daemon's `fswatch` loop (S005) to pick up reindexing asynchronously, exactly like the CLI does
for every command except `reindex`/`stats`. The MCP server never opens the S005 Unix socket — `reindex`
and `stats` are CLI-only per the README, and no other tool needs daemon-backed work.

**Schema version handling**: only the daemon rebuilds the schema on a version mismatch (S001/S005) —
the MCP server never attempts DDL itself, since two processes racing to drop/recreate tables
concurrently would be actively dangerous. If the MCP server's own schema-version read doesn't match
what the code expects, tool calls fail with a clear error directing the caller to ensure the daemon is
running (which owns migration) — the MCP server surfaces the problem, it doesn't fix it.

## Error mapping

Every `core/` function throws on error (per CLAUDE.md). `mcp/tools.js` catches the thrown `Error` and
returns it as an MCP tool error response (`isError: true`) with the **original message preserved
verbatim** — no error-code taxonomy. Claude sees exactly why a call failed (e.g. "hash mismatch: note
has changed since last read") and can react accordingly (re-read, adjust, retry), rather than a
generic failure with the specific reason lost.

## Output formats

Two response shapes, chosen per tool for token efficiency (per the README's design principles):

- **Pipe-delimited columnar plain text** for every list-style tool — `search`, `grep`, `tag_list`,
  `tag_notes`. A header row plus one row per result, no JSON object/array wrapper, no per-field key
  repetition across rows. This is deliberately **not JSON**: a JSON array of objects repeats every
  field name once per row, which is pure token overhead for tabular data Claude is going to scan down
  a column at a time anyway — the header row already documents the shape once.
- **Structured JSON** for `note_read` and the four mutating tools (`note_write`, `note_edit`,
  `note_append`, `note_rename`) — content and metadata are unconstrained text that could collide with
  any plain-text delimiter scheme, so JSON's escaping is load-bearing there in a way it isn't for
  tabular rank/count/line-number data.

## Tool set

Every tool takes `reason<string>` (required) — logged per S008, not used to gate behavior (CLAUDE.md).

### `search`

**Input**: `query<string>`, `?mode<fulltext|semantic|hybrid>=hybrid`, `?limit<int>=20` (max `100`,
both config-backed per S002), `reason<string>`.
**Output**: `note_title`, `file_line_count`, `?fulltext_rank`, `?semantic_rank` (rank position only,
never raw scores — CLAUDE.md).

Tool **description** must document (per S002) that FTS5 query syntax (`AND`/`OR`/`NOT`, `"phrase"`,
`word*`, `NEAR`) is live in both `fulltext` and `hybrid` mode (not gated behind an opt-in), and that a
malformed expression is a hard error in either mode — this is a real behavior Claude needs to know
about to use `search` reliably, not an implementation detail to hide.

### `grep`

**Input**: `pattern<string>`, `?regex<bool>=false`, `?note_title<string>`, `reason<string>`.
**Output**: `note_title`, `file_line_count`, `line_matches` (capped at 10 per note + `(+N more)`, per
S004) — **line numbers only** (`L2, L5`), never the matched line's text. Unlike the CLI (S006), the
MCP tool has no input for opting into match text — grep is meant to help Claude locate *which* notes
and *which lines* are worth a closer look, not to substitute for reading them. Returning matched text
inline would burn context on content Claude hasn't decided it needs yet, especially for a broad
pattern with many hits across many notes; the intended flow is `grep` to find candidates, then
`note_read` (scoped to the relevant `start_line`/`end_line`) to actually see them.

### `tag_list`

**Input**: `reason<string>`. **Output**: `tag`, `notes_with_tag` (exact-match count, per S004).

### `tag_notes`

**Input**: `tag<string>`, `reason<string>`. **Output**: `note_title`, `file_line_count`
(parent-includes-child matching, per S004).

### `note_read`

**Input**: `note_title<string>`, `?start_line<int>`, `?end_line<int>`, `reason<string>`.
**Output**: `{ title, start_line, end_line, total_lines, content_hash, metadata, content }` — always
structured JSON (unlike the CLI's `read`, which defaults to plain text; MCP has no equivalent of the
CLI's `--raw` mode since Claude always wants the structured shape, never a reason to strip it).

### `note_write`

**Input**: `note_title<string>`, `hash<null|string>`, `?metadata<json>`, `content<string>`,
`?force<bool>=false`, `reason<string>`.
**Output**: `{ title, hash, line_count }`.

No hash + new title = create. No hash + existing title = error. Hash matching = full content replace
+ metadata merge (`null` value deletes a key). `force: true` bypasses the size-drop guard (S003).

### `note_edit`

**Input**: `note_title<string>`, `hash<string>` (required, non-nullable per S003), `old_txt<string>`,
`new_txt<string>`, `?metadata<json>`, `reason<string>`.
**Output**: `{ title, hash, line_count }`.

Errors unless `old_txt` matches exactly once. `metadata` uses the same merge semantics as
`note_write` — this is new relative to the README's current documentation (S003 closed this gap).

### `note_append`

**Input**: `note_title<string>`, `hash<string>` (required per S003), `content<string>`,
`reason<string>`.
**Output**: `{ title, hash, line_count }`.

No `metadata` param (append stays content-only, per S003).

### `note_rename` (new — not in the README's current tool table)

**Input**: `old_title<string>`, `new_title<string>`, `hash<string>`, `reason<string>`.
**Output**: `{ title, hash, line_count }` (`title` is `new_title`; `hash` reflects the rewritten `id`
frontmatter field, per S003).

Hard error if `new_title` already exists — no `force` override.

## Prompts — explicitly out of scope here

The README names 5 prompt candidates (weekly review automation, note triage, stale note detection,
weekly note scaffolding, orphan note identification) as identified but undesigned. Each is its own
design problem (trigger conditions, what "stale"/"orphan" precisely means, what gets read/written) —
bundling all 5 into this spec would roughly double its scope and mix tool-schema design with
prompt-behavior design in one document. **Deferred to a dedicated follow-up spec** once the tool set
above is actually built and in use. `mcp/prompts.js` exists as a stub (empty prompt list registered
with the SDK) until that spec lands.

## Logging

`src/mcp/server.js` does two separate things with the logger, both per `S008`:

1. **Server lifecycle**, at `info` on its own `getLogger('mcp-server', defaultLogDir())` instance:
   `"server started"` on boot, `"stdio transport connected"`/`"stdio transport disconnected"` as the
   client attaches/detaches. Protocol-level errors (malformed JSON-RPC framing, an unsupported
   request) go to the same logger at `warn`/`error`. None of this is per-tool-call — it's the process's
   own start/stop/protocol narrative.
2. **Per-tool-call wrapping**, in `mcp/tools.js`'s dispatch: every tool invocation — read or write,
   `search` through `note_rename` — runs as `runWithLogger(mcpLogger, () => handler(args))`, so any
   `getContextLogger()` call inside the `core/` function it invokes (`S002`'s malformed-query `warn`,
   `S003`'s `id`-overwrite `debug`, `S004`'s ripgrep-not-found `warn`, `S001`'s schema-mismatch `warn`
   in the unlikely event the MCP server's own connection hits it) lands in `mcp-server.log`. Separately
   from that context, **every** tool call — this is the asymmetry with the CLI, which per `S006` only
   audits mutations — also gets a `logAudit(getAuditLogger(defaultLogDir()), { tool, noteTitle,
   source: 'mcp', reason, outcome, errorMessage })` call in `audit.log`, using the tool's own
   (required, per CLAUDE.md) `reason` argument. This is what "logged per S008, not used to gate
   behavior" in the Tool set intro above actually resolves to: every tool call is audited regardless of
   outcome, `reason` is captured verbatim, and a caught thrown error (per "Error mapping" above) becomes
   `outcome: 'error'` with the preserved error message as `error_message` — the same message Claude sees
   in the tool response.

Net effect: an MCP-driven `search` that hits `core/search.js`'s malformed-FTS5-query throw produces
*two* durable records — a `warn` line in `mcp-server.log` from the `core/` call site itself, and an
`outcome: 'error'` line in `audit.log` from the tool-call wrapper — which is intentional redundancy
(different files, different purposes: one is "what happened inside this component," the other is "what
did this caller do and did it work") rather than something to deduplicate.

## Explicitly out of scope here (beyond prompts)

- **Audit log entry shape for MCP tool calls** (`{ tool, note_title, reason, timestamp, outcome }` per
  the README) — S008.
- **`@modelcontextprotocol/sdk` registration boilerplate specifics** — implementation detail, not an
  architectural decision this spec needs to pin down.
