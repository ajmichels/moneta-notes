# S007 — MCP Server

Status: **Approved**
Owns: `src/mcp/server.js`, `src/mcp/tools.js`, `src/mcp/prompts.js` (stub only — see Prompts)
Depends on: `S001-data-model`, `S002-search`, `S003-notes`, `S004-grep-tags`, `S012-attachments`
Consumed by: Claude Code / Claude Desktop

## Purpose

Defines the finalized MCP tool set (superseding the README's tool section, which this spec brings up
to date with decisions made in S002/S003: `note_rename` is new, `note_edit` gains `metadata`, `search`
gains `limit`; S012 adds `attachment_read`/`attachment_write`), server bootstrap, and how `core/`
errors map to MCP tool responses. Prompts are explicitly out of scope — see below.

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
- **Structured JSON** for `note_read`, the four mutating note tools (`note_write`, `note_edit`,
  `note_append`, `note_rename`), and both attachment tools (`attachment_read`, `attachment_write`,
  S012) — content and metadata are unconstrained text (or, for attachments, base64-encoded binary) that
  could collide with any plain-text delimiter scheme, so JSON's escaping is load-bearing there in a way
  it isn't for tabular rank/count/line-number data.

## Tool set

Every tool takes `reason<string>` (required) — logged per S008, not used to gate behavior (CLAUDE.md).

Every tool's `tools/list` registration also carries a standard MCP `annotations` block
(`readOnlyHint`/`destructiveHint`/`idempotentHint`) so a client can reason about a tool's effects
before calling it, independent of the tool description's prose. Read-only tools (`search`, `grep`,
`tag_list`, `tag_notes`, `note_read`, `attachment_read`) all get `{ readOnlyHint: true,
destructiveHint: false, idempotentHint: true }`. Mutating tools get `readOnlyHint: false` and set the
other two per their actual semantics rather than a blanket "any mutation is destructive":

- `destructiveHint` is `false` only for `note_append` — it's the one mutating tool that is purely
  additive (content-only, no overwrite, per below). Every other mutating tool (`note_write`,
  `note_edit`, `note_rename`, `attachment_write`) can overwrite or remove existing content, so
  `destructiveHint: true`.
- `idempotentHint` is `true` only for `attachment_write` — an unconditional create-or-overwrite with
  no hash guard (per below), so calling it twice with the same input leaves the same end state. Every
  other mutating tool requires a fresh `hash` that matches current content (or, for `note_rename`, a
  `new_title` that must not already exist) on each call, so a second identical call fails rather than
  being a no-op — `idempotentHint: false`.

### `search`

**Input**: `query<string>`, `?mode<fulltext|semantic|hybrid>=hybrid`, `?limit<int>=20` (max `100`,
both config-backed per S002), `reason<string>`.
**Output**: `note_title`, `file_line_count`, `?fulltext_rank`, `?semantic_rank`, `?chunk_line_start`,
`?chunk_line_end`, `?bm25_score` (`fulltext` mode only), `?cosine_distance` (`semantic` mode only) —
`hybrid` mode is rank position only, never a raw RRF score; `fulltext`/`semantic` mode also carries its
native single-signal score (CLAUDE.md, S002).

`chunk_line_start`/`chunk_line_end` (S001/S002) are present only when the result has a semantic-side
match — always in `semantic` mode, and in `hybrid` mode only for notes that matched (at least partly)
via the semantic side; absent for `fulltext` mode entirely and for any `hybrid` note that matched only
via the fulltext side. They're 1-indexed line numbers into the note's body, in the same coordinate
space `note_read`'s `start_line`/`end_line` accept — the tool description should tell Claude it can
pass them straight through to a follow-up `note_read` call to fetch just the matching slice of a large
note instead of reading the whole thing.

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

`note_title` resolves the same way `note_read`'s does (S004/S010): exact match, then unique-basename
fallback — the tool description should say so, since a caller scoping `grep` to a note it only knows
via a `[[wikilink]]` reference needs to know that's supported.

### `tag_list`

**Input**: `reason<string>`. **Output**: `tag`, `notes_with_tag` (exact-match count, per S004).

### `tag_notes`

**Input**: `tag<string>`, `reason<string>`. **Output**: `note_title`, `file_line_count`
(parent-includes-child matching, per S004).

### `note_read`

**Input**: `note_title<string>`, `?start_line<int>`, `?end_line<int>`, `reason<string>`.
**Output**: `{ title, start_line, end_line, total_lines, content_hash, metadata, content, backlinks,
links_out }` — always structured JSON (unlike the CLI's `read`, which defaults to plain text; MCP has
no equivalent of the CLI's `--raw` mode since Claude always wants the structured shape, never a reason
to strip it).

`backlinks`/`links_out` (S003/S011) are the two wikilink traversal directions — titles of notes
linking *to* this one, and titles this note links *to* — each a plain array of note titles, `[]` when
there are none. Both the MCP server and the CLI always hold an open `db` handle (per "No daemon
interaction" above, and per S006's `buildRealDeps`), so `backlinks` is always populated on both
surfaces, not conditionally available on one and not the other.

**`note_title` resolves rather than requiring an exact match** (S003/S010): exact title match first,
then a fallback to a unique-basename match if that misses. **The returned `title` reflects whichever
one actually resolved** — it is not necessarily an echo of the input `note_title`. This is the one
tool in this whole surface allowed to do this; the tool description must say so explicitly, along
with: *"note_title may be a short/ambiguous reference (e.g. text from inside a `[[wikilink]]`) — this
tool resolves it and returns the note's true absolute title in its response. Every mutating tool below
requires that absolute title exactly; read a note first if you only have a short reference to it."*
This is the sentence that makes the read/write split (S003/S010) legible to Claude at call time, not
just to a spec reader.

### `note_write`

**Input**: `note_title<string>`, `hash<null|string>`, `?metadata<json>`, `content<string>`,
`?force<bool>=false`, `reason<string>`.
**Output**: `{ title, hash, line_count }`.

No hash + new title = create. No hash + existing title = error. Hash matching = full content replace
+ metadata merge (`null` value deletes a key). `force: true` bypasses the size-drop guard (S003).

**`note_title` requires the exact absolute title — no resolution fallback** (S003/S010), unlike
`note_read`/`grep`. This matters more here than on the other mutating tools: whether `note_title`
"already exists" is exactly what decides create vs. error, so any fuzziness here would make that
decision ambiguous. The tool description states this plainly: *"note_title must be the note's exact
absolute title (full path from vault root) — as returned by search or note_read, never a short or
ambiguous wikilink reference."*

### `note_edit`

**Input**: `note_title<string>`, `hash<string>` (required, non-nullable per S003), `old_txt<string>`,
`new_txt<string>`, `?metadata<json>`, `reason<string>`.
**Output**: `{ title, hash, line_count }`.

Errors unless `old_txt` matches exactly once. `metadata` uses the same merge semantics as
`note_write` — this is new relative to the README's current documentation (S003 closed this gap).

Same as `note_write`: `note_title` requires the exact absolute title, no resolution fallback (S003/
S010) — tool description states this the same way.

### `note_append`

**Input**: `note_title<string>`, `hash<string>` (required per S003), `content<string>`,
`reason<string>`.
**Output**: `{ title, hash, line_count }`.

No `metadata` param (append stays content-only, per S003).

Same as `note_write`/`note_edit`: `note_title` requires the exact absolute title, no resolution
fallback (S003/S010).

### `note_rename` (new — not in the README's current tool table)

**Input**: `old_title<string>`, `new_title<string>`, `hash<string>`, `reason<string>`.
**Output**: `{ title, hash, line_count }` (`title` is `new_title`; `hash`/`line_count` reflect the
rewritten `id` frontmatter field **and** the outcome of the link cascade below, per S003).

Hard error if `new_title` already exists — no `force` override.

Also rewrites `[[old_title]]` references in every other note that links to it, so search/read results
never point Claude at a stale link after a rename (S003/S011's link cascade) — this happens
synchronously inside the call, no separate tool or follow-up action needed. That cascade's own
internal matching against *other* notes' link text is basename-aware (S003/S011); `old_title`/
`new_title` themselves are not — both require the exact absolute title, same as every other mutating
tool, no resolution fallback (S003/S010).

### `attachment_read` (new — S012)

**Input**: `attachment_path<string>`, `?include_content<bool>=true`, `reason<string>`.
**Output**: two MCP content blocks when content is included — a `text` block with
`{ path, size_bytes, mime_type, total_pages? }` as JSON, plus a second block carrying the actual
bytes (see below). `include_content: false`, or an over-cap file, returns only the `text` metadata
block.

Reads a binary vault file that isn't a note — an image, PDF, or other attachment a note references via
`![[...]]`/a markdown link. **No index backs this tool** (S012), so `attachment_path` requires the
exact vault-relative path with no short-form/basename resolution — unlike `note_read`'s `note_title`,
there's no fallback here at all, not even on the read side. The tool description states this plainly:
*"attachment_path must be the exact vault-relative path, as it appears in the note's reference — there
is no short-form or basename resolution for attachments, unlike note_title."*

The file's bytes are capped by a config-backed size limit (S009's `[attachments].max_read_bytes`) — a
file over the cap with `include_content: true` (the default) is a hard error naming the cap and
directing the caller to retry with `include_content: false` for metadata only, or (PDFs) with
`start_page`/`end_page` (S012) for a page-range slice instead of the whole file.

**Bytes are never inlined as a base64 string inside the JSON metadata block.** An earlier version of
this tool did exactly that — one `text` content block containing
`{ path, size_bytes, mime_type, content_base64 }` as a single JSON string — which put the entire
base64 payload in front of the model as literal text with no structural signal that it was opaque,
already-decoded binary data rather than something to reason over. In practice this caused the model
to try to manually "decode" large attachments itself mid-turn, ballooning output tokens until the
turn timed out — worse than the truncation problem the `text`-only design was chosen to avoid (below).
The fix: `content` (when included) is now its own content block, split by whether the Claude API can
render it as vision input —
- **`image/png`, `image/jpeg`, `image/gif`, `image/webp`** → an `image` content block
  (`{ type: 'image', data, mimeType }`) — the exact four raster formats the Claude API's vision input
  accepts; nothing else qualifies even if MCP's own schema would technically allow representing it as
  `image` (SVG, HEIC and anything non-raster stay in the bucket below).
- **Everything else that isn't metadata-only** (PDF, docx, zip, `application/octet-stream`, ...) → a
  `resource` content block (`EmbeddedResource`: `{ type: 'resource', resource: { uri, mimeType, blob } }`).
  `uri` is a synthetic `attachment://<path>` label the schema requires but that is never dereferenced —
  `blob` already carries the full base64 payload inline, in the same response, unlike a `resource_link`
  block (which *would* require a `resources/read` round trip against a registered resource). Per
  CLAUDE.md, this project does not register any `resources/list`/`resources/read` capability, and
  doesn't need to for this to work.

**`attachment_read`'s `tools/list` registration carries `_meta: { 'anthropic/maxResultSizeChars':
500000 }`** — a Claude-Code-specific annotation (documented at
`code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings`, not part of the MCP spec itself) that
raises a tool's `text`-content output threshold to the annotation's hard ceiling, independent of
whatever `MAX_MCP_OUTPUT_TOKENS` the client has configured globally — without it, the `text` metadata
block plus a base64-inlined `image` block together (as this tool used to return) easily tripped Claude
Code's default 25,000-token MCP-output limit and got silently persisted to disk with a file-reference
stub in its place. The docs are explicit that this annotation **has no effect on `image`-typed
content** — an `image` block stays subject to `MAX_MCP_OUTPUT_TOKENS` regardless, so a large raster
image read through this tool can still hit that global cap and get silently truncated to a disk
reference. The docs are silent on `resource`-typed content either way (neither confirmed to inherit
the `text` override nor confirmed to be excluded like `image`) — this is unverified, closed-source
client behavior, not a settled guarantee, and worth confirming empirically against a real oversized
PDF before leaning on it. The annotation itself stays a flat constant, not derived from
`[attachments].max_read_bytes` (S009) — the two caps bound different things (one what's read off disk,
the other what a specific client will forward for `text` content) and conflating them would just
reintroduce the same silent-truncation failure mode for any `max_read_bytes` configured above 500,000
characters' worth of base64.

### `attachment_write` (new — S012)

**Input**: `attachment_path<string>`, `content_base64<string>`, `reason<string>`.
**Output**: `{ path, size_bytes, mime_type }`.

Create-or-overwrite, unconditional — **no hash guard** (S012: CLAUDE.md's hash-guard rule is scoped to
notes' diffable text content, which binary attachments have no equivalent of). Same exact-path
requirement as `attachment_read`, same vault-containment check every path-taking tool in this project
already has (S010's `resolveVaultPath`).

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
