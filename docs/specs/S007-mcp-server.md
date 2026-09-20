# S007 — MCP Server

Status: **Approved**
Owns: `src/mcp/server.js`, `src/mcp/tools.js`, `src/mcp/prompts.js` (stub only — see Prompts)
Depends on: `S001-data-model`, `S002-search`, `S003-notes`, `S004-grep-tags`, `S012-attachments`
Amended by: `S015-readonly-paths` (write-guard rejection + `readonly` field/column on every affected
tool's description, per tool below), `S009-config-and-install` (multi-vault support: `vault` argument
on every vault-scoped tool, plus the new `list_vaults` tool)
Consumed by: Claude Code / Claude Desktop

## Purpose

Defines the finalized MCP tool set — superseding the README's tool section, updated per S002/S003
decisions (`note_rename` is new, `note_edit` gains `metadata`, `search` gains `limit`; S012 adds
`attachment_read`/`attachment_write`; S009 adds an optional `vault` argument to every vault-scoped tool
plus the new `list_vaults` tool) — plus server bootstrap and how `core/` errors map to MCP tool
responses. Prompts are out of scope (see below).

## `vault` argument and vault resolution

Every vault-scoped tool below (every tool except `list_vaults` itself) gains an optional
`vault<string>` input argument. It splits into the same two resolution groups S006 defines for the CLI:

1. **Single-vault-target tools** — `note_read`, `note_write`, `note_edit`, `note_append`,
   `note_rename`, `attachment_read`, `attachment_write`, `tag_list`, `metadata_keys`. `vault` resolves
   via `resolveVault(config, name)` (`src/config.js`, S009): explicit `vault` wins, else
   `default_vault`, else the sole configured vault, else a hard error naming every configured vault.
2. **Fan-out tools** — `search`, `grep`, `tag_notes`, `metadata_query`. `vault` resolves via
   `resolveVaultsForQuery(config, name)` (S009): explicit `vault` still means exactly one target vault,
   but an omitted `vault` fans out across **every** configured vault instead of falling back to
   `default_vault`, merging results with a `vault` field on every row — see each tool's own section
   below and S009's "Cross-vault fan-out for read/list tools" for the full mechanics.

An unresolvable explicit `vault` name surfaces as a normal thrown error either way, handled by the
existing "Error mapping" rule below with no special-casing. A single-vault setup (the common case,
including every config predating this feature) never requires a caller to pass `vault` at all, and never
sees a `vault` field in any tool's output — Claude only needs to reach for either once `list_vaults`
shows more than one vault configured.

## Transport

**stdio.** `mnotes-mcp` (the `bin` entry in `package.json`) is launched as a subprocess by Claude
Code/Desktop and communicates over stdin/stdout via `@modelcontextprotocol/sdk`'s stdio transport — no
network exposure, no port to configure. Standard setup for a locally-launched, single-user MCP server.

## No daemon interaction

Every tool is a direct `core/` consumer: reads hit the SQLite index directly (WAL mode handles
concurrent readers safely alongside the daemon's writes), and writes touch vault files directly,
relying on the daemon's `fswatch` loop (S005) to pick up reindexing asynchronously — exactly like the
CLI for every command except `reindex`/`stats`. The MCP server never opens the S005 Unix socket;
`reindex` and `stats` stay CLI-only per the README, and no other tool needs daemon-backed work.

**Schema version handling**: only the daemon rebuilds the schema on a version mismatch (S001/S005) —
two processes racing to drop/recreate tables concurrently would be actively dangerous, so the MCP
server never attempts DDL itself. If its own schema-version read doesn't match what the code expects,
tool calls fail with a clear error directing the caller to ensure the daemon (which owns migration) is
running — the MCP server surfaces the problem, it doesn't fix it.

## Error mapping

Every `core/` function throws on error (per CLAUDE.md). `mcp/tools.js` catches the thrown `Error` and
returns it as an MCP tool error response (`isError: true`) with the **original message preserved
verbatim** — no error-code taxonomy. Claude sees exactly why a call failed (e.g. "hash mismatch: note
has changed since last read") and can react accordingly (re-read, adjust, retry) instead of getting a
generic failure with the specific reason lost.

## Output formats

Two response shapes, chosen per tool for token efficiency (per the README's design principles):

- **Pipe-delimited columnar plain text** for every list-style tool — `search`, `grep`, `tag_list`,
  `tag_notes`, `list_vaults`. A header row plus one row per result, no JSON object/array wrapper, no
  per-field key
  repetition across rows. Deliberately **not JSON**: a JSON array of objects repeats every field name
  once per row, pure token overhead for tabular data Claude scans down a column at a time — the header
  row already documents the shape once.
- **Structured JSON** for `note_read`, the four mutating note tools (`note_write`, `note_edit`,
  `note_append`, `note_rename`), and both attachment tools (`attachment_read`, `attachment_write`,
  S012) — content and metadata are unconstrained text (or, for attachments, base64-encoded binary) that
  could collide with any plain-text delimiter scheme, so JSON's escaping is load-bearing there in a way
  it isn't for tabular rank/count/line-number data.

## Tool set

Every tool takes `reason<string>` (required) — logged per S008, not used to gate behavior (CLAUDE.md).
Every tool except `list_vaults` also takes an optional `vault<string>` — see "`vault` argument and
vault resolution" above.

Every tool's `tools/list` registration also carries a standard MCP `annotations` block
(`readOnlyHint`/`destructiveHint`/`idempotentHint`) so a client can reason about a tool's effects
before calling it, independent of the tool description's prose. Read-only tools (`search`, `grep`,
`tag_list`, `tag_notes`, `note_read`, `attachment_read`, `list_vaults`) all get `{ readOnlyHint: true,
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

### Shared tool-description snippets

Four snippets are defined once and appended verbatim to every relevant tool's description, rather than
independently reworded per tool:

- **`READONLY_WRITE_NOTE`** (S015; on `note_write`, `note_edit`, `note_append`, `note_rename`,
  `attachment_write`): *"Fails if the target path matches a pattern in the vault's `.mnotesreadonly`
  file — the error names the specific pattern that matched."*
- **`READONLY_READ_NOTE`** (S015; on `note_read`, `search`, `grep`, `tag_notes`, `attachment_read`;
  also on `metadata_query`, in its own S014 tool description): *"A `readonly` field/column is present
  when the note matches a read-only pattern — check it before attempting to write."*
- **`NO_INLINE_FRONTMATTER_NOTE`** (issue #13, S003; on `note_write`, `note_edit`, `note_append`):
  *"Do not write a `---` YAML frontmatter block yourself — pass frontmatter fields via the metadata
  parameter instead; this stays body text only."* Stated up front in the tool description, rather than
  left to be discovered via `core/notes.js`'s `assertNoFrontmatterBlock` error (S003) when a caller (an
  agent that notices a note "should have frontmatter" and hand-writes one) hits it.
- **`TAG_ESCAPE_NOTE`** (on `note_write`, `note_edit`, `note_append`): warns about inline tag
  extraction. Content passed to these tools is scanned for `#hashtags` on the next reindex exactly as
  S004 describes, and a caller has no way to see that scan happen — unlike a human typing directly into
  the vault in an editor with Obsidian's own tag highlighting, an agent calling these tools blind gets
  no visual signal that adjacent refs like `#1`/`#2` just became tags. A single isolated ref like `#5`
  is already safe (rejected as purely numeric, per S004) and the note says so, so a caller doesn't
  over-escape things that were never at risk. It states both escapes S004's extractor honors: a leading
  backslash (`\#foo`) for a single value, or wrapping a longer run in backticks/a code span (a hex
  color, or several adjacent refs) — backslash only escapes the one `#` it precedes, not a whole run.

### `search`

**Input**: `query<string>`, `?mode<fulltext|semantic|hybrid>=hybrid`, `?limit<int>=20` (max `100`,
both config-backed per S002), `?vault<string>`, `reason<string>`.
**Output**: `note_title`, `file_line_count`, `?fulltext_rank`, `?semantic_rank`, `?chunk_line_start`,
`?chunk_line_end`, `?bm25_score` (`fulltext` mode only), `?cosine_distance` (`semantic` mode only),
`?readonly` (S015, `READONLY_READ_NOTE`), `?vault` — `hybrid` mode is rank position only, never a raw
RRF score; `fulltext`/`semantic` mode also carries its native single-signal score (CLAUDE.md, S002).

**`vault` (S009)** is present only when `vault` was omitted *and* more than one vault is configured —
in that case this tool fans out across every configured vault instead of resolving to one, and results
are **grouped by vault, ranked within each** (each vault's own top-`limit` block, in `listVaults`'s
name-sorted order) — never a single cross-vault-merged ranking, since `bm25_score`/`cosine_distance`/
RRF rank position are all corpus-relative and have no meaningful comparison across two different
vaults' indexes. `limit` applies per vault under fan-out, not split across vaults. The tool description
should mention this — an agent calling `search` with no `vault` on a multi-vault setup should expect
results from every vault, not just one, and **must carry a result's `vault` forward into any follow-up
tool call naming that result's title** (`note_read`, `grep --note_title`, etc.) — those tools resolve an
omitted `vault` to `default_vault`, which may not be the vault a given fanned-out result actually came
from, so dropping it risks resolving against the wrong vault entirely (or a hard error, if that title
doesn't exist there).

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

**Input**: `pattern<string>`, `?regex<bool>=false`, `?note_title<string>`, `?vault<string>`,
`reason<string>`.
**Output**: `note_title`, `file_line_count`, `line_matches` (capped at 10 per note + `(+N more)`, per
S004), `?readonly` (S015, `READONLY_READ_NOTE`), `?vault` (S009 — same fan-out-only presence rule as
`search`'s `vault` field above; a plain concatenation across vaults here, no ranking to preserve) —
**line numbers only** (`L2, L5`), never the matched line's text. Unlike the CLI (S006), the MCP tool has
no input for opting into match text — grep is
meant to help Claude locate *which* notes and *which lines* are worth a closer look, not to substitute
for reading them. Returning matched text inline would burn context on content Claude hasn't decided it
needs yet, especially for a broad pattern with many hits across many notes; the intended flow is
`grep` to find candidates, then `note_read` (scoped to the relevant `start_line`/`end_line`) to
actually see them.

`note_title` resolves the same way `note_read`'s does (S004/S010): exact match, then unique-basename
fallback — the tool description should say so, since a caller scoping `grep` to a note it only knows
via a `[[wikilink]]` reference needs to know that's supported.

### `tag_list`

**Input**: `?vault<string>`, `reason<string>`. **Output**: `tag`, `notes_with_tag` (exact-match count,
per S004).

**Does not fan out** (S009) — unlike `tag_notes` below, an omitted `vault` always resolves to exactly
one vault (`default_vault`/sole vault/hard error, same as `note_read`), never every configured vault.
Tags are a separate vocabulary per vault (S001); merging two vaults' tag counts into one list would
misrepresent both, so `tag_list` stays single-vault-target rather than getting the same treatment
`tag_notes` gets.

### `tag_notes`

**Input**: `tag<string>`, `?vault<string>`, `reason<string>`. **Output**: `note_title`,
`file_line_count`, `?readonly` (S015, `READONLY_READ_NOTE`), `?vault` (S009 — same fan-out-only
presence rule as `search`'s `vault` field; plain concatenation, no ranking) (parent-includes-child
matching, per S004).

### `note_read`

**Input**: `note_title<string>`, `?start_line<int>`, `?end_line<int>`, `?vault<string>`, `reason<string>`.
**Output**: `{ title, start_line, end_line, total_lines, content_hash, metadata, content, backlinks,
links_out, ?readonly }` (S015, `READONLY_READ_NOTE`) — always structured JSON (unlike the CLI's `read`,
which defaults to plain text; MCP has no equivalent of the CLI's `--raw` mode since Claude always wants
the structured shape, never a reason to strip it).

`note_read` is single-vault-target, not fan-out (S009) — an omitted `vault` resolves to exactly one
vault (`default_vault`/sole vault/hard error), never every configured vault, since a note read has
exactly one answer. If `note_title` came from a fanned-out `search`/`grep`/`tag_notes` result, its
`vault` field must be carried forward here explicitly — omitting it resolves against `default_vault`
instead, which may not be where that result actually came from. The tool description should say so.

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
`?force<bool>=false`, `?vault<string>`, `reason<string>`. Tool description carries
`READONLY_WRITE_NOTE` (S015) and
`NO_INLINE_FRONTMATTER_NOTE` (issue #13).
**Output**: `{ title, hash, line_count }`.

No hash + new title = create. No hash + existing title = error. Hash matching = full content replace
+ metadata merge (`null` value deletes a key). `force: true` bypasses the size-drop guard (S003).
Fails first, before any of the above, if `note_title` matches a `.mnotesreadonly` pattern (S015) —
applies to the create path too.

**`note_title` requires the exact absolute title — no resolution fallback** (S003/S010), unlike
`note_read`/`grep`. This matters more here than on the other mutating tools: whether `note_title`
"already exists" is exactly what decides create vs. error, so any fuzziness here would make that
decision ambiguous. The tool description states this plainly: *"note_title must be the note's exact
absolute title (full path from vault root) — as returned by search or note_read, never a short or
ambiguous wikilink reference."*

### `note_edit`

**Input**: `note_title<string>`, `hash<string>` (required, non-nullable per S003), `old_txt<string>`,
`new_txt<string>`, `?metadata<json>`, `?vault<string>`, `reason<string>`. Tool description carries
`READONLY_WRITE_NOTE`
(S015) and `NO_INLINE_FRONTMATTER_NOTE` (issue #13).
**Output**: `{ title, hash, line_count }`.

Fails first if `note_title` matches a `.mnotesreadonly` pattern (S015), before the hash check. Errors
unless `old_txt` matches exactly once. `metadata` uses the same merge semantics as `note_write` — this
is new relative to the README's current documentation (S003 closed this gap).

Same as `note_write`: `note_title` requires the exact absolute title, no resolution fallback
(S003/S010) — tool description states this the same way.

### `note_append`

**Input**: `note_title<string>`, `hash<string>` (required per S003), `content<string>`,
`?vault<string>`, `reason<string>`. Tool description carries `READONLY_WRITE_NOTE` (S015) and
`NO_INLINE_FRONTMATTER_NOTE` (issue #13).
**Output**: `{ title, hash, line_count }`.

Fails first if `note_title` matches a `.mnotesreadonly` pattern (S015), before the hash check. No
`metadata` param (append stays content-only, per S003).

Same as `note_write`/`note_edit`: `note_title` requires the exact absolute title, no resolution
fallback (S003/S010).

### `note_rename` (new — not in the README's current tool table)

**Input**: `old_title<string>`, `new_title<string>`, `hash<string>`, `?vault<string>`, `reason<string>`.
Tool description
carries `READONLY_WRITE_NOTE` (S015), noting it applies to **both** `old_title` and `new_title`.
**Output**: `{ title, hash, line_count }` (`title` is `new_title`; `hash`/`line_count` reflect the
rewritten `id` frontmatter field **and** the outcome of the link cascade below, per S003).

Fails first if `old_title` **or** `new_title` matches a `.mnotesreadonly` pattern (S015) — protects an
existing read-only note from being moved, and protects a read-only-globbed zone from a normal note
being moved into it — checked before the hash comparison and the `new_title`-already-exists check
below. Hard error if `new_title` already exists — no `force` override.

Also rewrites `[[old_title]]` references in every other note that links to it — including read-only
ones, a deliberate exception to the guard above so a rename never leaves a read-only note's link
dangling (S003/S015) — so search/read results never point Claude at a stale link after a rename
(S003/S011's link cascade). This happens synchronously inside the call, no separate tool or follow-up
action needed. That cascade's own internal matching against *other* notes' link text is basename-aware
(S003/S011); `old_title`/`new_title` themselves are not — both require the exact absolute title, same
as every other mutating tool, no resolution fallback (S003/S010).

### `attachment_read` (new — S012)

**Input**: `attachment_path<string>`, `?include_content<bool>=true`, `?vault<string>`, `reason<string>`.
Tool description carries `READONLY_READ_NOTE` (S015).
**Output**: the metadata `text` block gains `?readonly` (S015) alongside `path`/`size_bytes`/
`mime_type`/`total_pages?`; two MCP content blocks when content is included — a `text` block with
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

**Bytes are never inlined as a base64 string inside the JSON metadata block.** An earlier version did
exactly that — one `text` content block containing `{ path, size_bytes, mime_type, content_base64 }`
as a single JSON string — which put the entire base64 payload in front of the model as literal text
with no structural signal that it was opaque, already-decoded binary data rather than something to
reason over. In practice the model tried to manually "decode" large attachments itself mid-turn,
ballooning output tokens until the turn timed out — worse than the truncation problem the `text`-only
design was chosen to avoid (below). The fix: `content` (when included) is now its own content block,
split by whether the Claude API can render it as vision input:

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
whatever `MAX_MCP_OUTPUT_TOKENS` the client has configured globally. Without it, the `text` metadata
block plus a base64-inlined `image` block together (as this tool used to return) easily tripped Claude
Code's default 25,000-token MCP-output limit and got silently persisted to disk with a file-reference
stub in its place. The docs are explicit that this annotation **has no effect on `image`-typed
content** — an `image` block stays subject to `MAX_MCP_OUTPUT_TOKENS` regardless, so a large raster
image read through this tool can still hit that global cap and get silently truncated to a disk
reference. The docs are silent on `resource`-typed content either way (neither confirmed to inherit
the `text` override nor confirmed to be excluded like `image`) — unverified, closed-source client
behavior, worth confirming empirically against a real oversized PDF before leaning on it. The
annotation itself stays a flat constant, not derived from `[attachments].max_read_bytes` (S009) — the
two caps bound different things (one what's read off disk, the other what a specific client forwards
for `text` content), and conflating them would reintroduce the same silent-truncation failure mode for
any `max_read_bytes` configured above 500,000 characters' worth of base64.

### `attachment_write` (new — S012)

**Input**: `attachment_path<string>`, `content_base64<string>`, `?vault<string>`, `reason<string>`.
Tool description carries `READONLY_WRITE_NOTE` (S015).
**Output**: `{ path, size_bytes, mime_type }`.

Fails first if `attachment_path` matches a `.mnotesreadonly` pattern (S015), before the parent-
directory creation or the atomic write below. Create-or-overwrite, unconditional — **no hash guard**
(S012: CLAUDE.md's hash-guard rule is scoped to notes' diffable text content, which binary attachments
have no equivalent of). Same exact-path requirement as `attachment_read`, same vault-containment check
every path-taking tool in this project already has (S010's `resolveVaultPath`).

### `list_vaults` (new — S009)

**Input**: `reason<string>` (no `vault` — this tool isn't scoped to one).
**Output**: pipe-delimited columnar text, one row per configured vault: `name`, `description` (empty
cell if unset), `is_default` (`true`/blank).

Lets Claude discover what vaults exist and route a subsequent call's `vault` argument by matching a
user's request against each vault's `description` (e.g. "add this to my D&D notes" → call
`list_vaults`, find the entry described as covering D&D campaign content, pass its `name` as `vault` on
the follow-up `note_write`) — without ever needing to know or reason about where a vault actually lives
on disk. **Deliberately never returns each vault's `path`** — every other tool in this surface already
takes titles/vault-relative paths, never absolute filesystem paths, and there's no legitimate reason for
an agent driven by this MCP server to need a vault's real location; withholding it here keeps that
boundary intact rather than leaking it through a listing tool that happens to have it available.
`src/config.js`'s `listVaults(config)` (S009) is the single implementation, shared with `mnotes vaults`
(S006) — this tool is a thin formatting wrapper over the exact same function, not a second
vault-listing code path.

## Prompts — explicitly out of scope here

The README names 5 prompt candidates (weekly review automation, note triage, stale note detection,
weekly note scaffolding, orphan note identification) as identified but undesigned. Each is its own
design problem (trigger conditions, what "stale"/"orphan" precisely means, what gets read/written) —
bundling all 5 into this spec would roughly double its scope and mix tool-schema design with
prompt-behavior design in one document. **Deferred to a dedicated follow-up spec** once the tool set
above is actually built and in use. `mcp/prompts.js` exists as a stub (empty prompt list registered
with the SDK) until that spec lands.

## Logging

`src/mcp/server.js` does two things with the logger, both per `S008`:

1. **Server lifecycle**, at `info` on its own `getLogger('mcp-server', defaultLogDir())` instance:
   `"server started"` on boot, `"stdio transport connected"`/`"stdio transport disconnected"` as the
   client attaches/detaches. Protocol-level errors (malformed JSON-RPC framing, an unsupported
   request) go to the same logger at `warn`/`error`. None of this is per-tool-call — it's the process's
   own start/stop/protocol narrative.
2. **Per-tool-call wrapping**, in `mcp/tools.js`'s dispatch: every tool invocation — read or write,
   `search` through `note_rename` — runs as `runWithLogger(mcpLogger, () => handler(args))`, so any
   `getContextLogger()` call inside the `core/` function it invokes (`S002`'s malformed-query `warn`,
   `S003`'s `id`-overwrite `debug`, `S004`'s ripgrep-not-found `warn`, `S001`'s schema-mismatch `warn`,
   should the MCP server's own connection ever hit it) lands in `mcp-server.log`. Independent of that,
   **every** tool call — unlike the CLI, which per `S006` only audits mutations — also gets a
   `logAudit(getAuditLogger(defaultLogDir()), { tool, noteTitle, vault, source: 'mcp', reason, outcome,
   errorMessage })` call in `audit.log`, using the tool's own (required, per CLAUDE.md) `reason`
   argument and the resolved vault's name (per "`vault` argument and vault resolution" above; absent
   only for `list_vaults`, which isn't scoped to one vault). This is what "logged per S008, not used to
   gate behavior" in the Tool set intro above resolves to: every tool call is audited regardless of
   outcome, `reason` is captured verbatim, and a caught thrown error (per "Error mapping" above) becomes
   `outcome: 'error'` with the preserved error message as `error_message` — the same message Claude sees
   in the tool response.

   **Exception: a fan-out call to `search`/`grep`/`tag_notes`/`metadata_query` (S009) logs more than
   once.** These four don't wrap a single `core/` call in the pattern above when `vault` is omitted
   against 2+ configured vaults — they loop, one `core/` call per resolved vault (per S009's "Cross-vault
   fan-out"), and `logAudit` is called **once per vault actually delivered results from** (all of them,
   on success), or exactly once naming whichever vault's error aborted the whole call, on the
   abort-on-first-error path S009 specifies. Every other tool, and every non-fanned-out call to these
   four (a single configured vault, or an explicit `vault` argument), still logs exactly the one entry
   described above — this exception only changes call-count, never the shape of an individual entry.

The two records serve different purposes and are intentionally redundant rather than something to
deduplicate: e.g. an MCP-driven `search` that hits `core/search.js`'s malformed-FTS5-query throw
produces a `warn` line in `mcp-server.log` ("what happened inside this component") *and* an
`outcome: 'error'` line in `audit.log` ("what did this caller do and did it work"), in two separate
files for two separate readers.

## Explicitly out of scope here (beyond prompts)

- **Audit log entry shape for MCP tool calls** (`{ tool, note_title, reason, timestamp, outcome }` per
  the README) — S008.
- **`@modelcontextprotocol/sdk` registration boilerplate specifics** — implementation detail, not an
  architectural decision this spec needs to pin down.
