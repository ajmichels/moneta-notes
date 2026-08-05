# S006 — CLI

Status: **Approved**
Owns: `src/cli/main.js`, `src/cli/reindex.js`, `src/cli/stats.js`
Depends on: `S001-data-model`, `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`
Consumed by: (terminal use, `obsidian.nvim` integration)

## Purpose

Defines `mnotes`'s subcommand surface. Per the README, the CLI is "the same underlying functionality
as the MCP server, with additional flags for debugging" plus two CLI-only commands (`reindex`,
`stats`). This spec's job is to pin down argument parsing, output formatting, and the handful of
CLI-specific concerns (no `reason`, `--explain`, stdin content input) that don't apply to the MCP
surface.

## Argument parsing

Node's built-in `util.parseArgs` — no CLI framework dependency. Subcommand routing is a small
dispatch table keyed on `argv[2]` (`search`, `grep`, `tags`, `read`, `write`, `edit`, `append`,
`rename`, `reindex`, `stats`), each parsing its own remaining flags via `parseArgs`. This matches the
project's minimal-dependency, no-build-step bias — a dozen flat subcommands doesn't need a framework's
nested-command/auto-help machinery.

## Output format

**Mirrors MCP tool output exactly** — the same pipe-delimited columnar text for list-style commands
(`search`, `grep`, `tags list`, `tags notes`) and the same structured JSON for `write`/`edit`/`append`/
`rename`, produced by the same formatting function each MCP tool handler calls. This is a direct
consequence of the architecture rule that `cli/` and `mcp/` must not duplicate logic — one formatter
per tool, shared by both surfaces, rather than a second "human-friendly" renderer that could drift
from what Claude actually sees.

List-style commands accept a `--json` flag for scripting/`obsidian.nvim` integration use cases where
structured output is more convenient than parsing pipe-delimited columns. `write`/`edit`/`append`/
`rename` are already JSON by default (per the README and S003's `{ title, hash, line_count }` return
shape), so `--json` is a no-op / not offered on those. **`read` is the one exception** — see below,
its default output is deliberately not JSON.

## No `reason` flag

MCP tools require `reason<string>` to audit *why Claude* took an action — necessary because Claude's
reasoning isn't otherwise visible. Running `mnotes write` yourself from a terminal has no equivalent
ambiguity (you're the one typing the command), so the CLI doesn't have or require a `--reason` flag.
Mutating commands still get logged (S008), with a fixed `source: "cli"` field distinguishing them from
`source: "mcp"` audit entries — same log shape, no reason string required.

## Content input for `write`/`append`

Both read note content from **stdin** if no `--content` flag is given (standard Unix piping — works
naturally with `$EDITOR`-produced files, heredocs, or piped command output), with `--content "..."` as
a shorthand for short one-liners:

```sh
cat draft.md | mnotes write "Weekly Notes/2026-W32" --hash=<hash>
mnotes append "Daily Notes/2026-08-04" --hash=<hash> --content="Quick note"
```

`edit`'s `--old`/`--new` stay flag-only (not stdin-eligible — a single stdin stream can't carry two
separate values) since surgical `old_txt`/`new_txt` replacements are typically shorter than whole-note
content, matching `note_edit`'s own "surgical" scope.

## `mnotes read` output modes

Unlike every other command, `read`'s **default output is not JSON** — a deliberate CLI-specific
divergence from the MCP tool, justified by Unix piping ergonomics: piping a note straight into
`$EDITOR`, `less`, or another tool shouldn't require unwrapping JSON first, and this is exactly the
kind of thing the CLI (used interactively and from `obsidian.nvim`) needs to do routinely in a way the
MCP tool never does.

| Mode | stdout | stderr |
|---|---|---|
| default | Note body only, frontmatter stripped | Parsed `metadata` object, as JSON |
| `--raw` | The exact file bytes as stored (frontmatter included), unmodified | Nothing |
| `--json` | Full MCP-identical structured JSON (`title`, `content_hash`, `metadata`, `content`, line info) | Nothing |

`--json` exists because `content_hash` isn't visible in either of the other two modes' stdout — any
script that wants to chain a `write`/`edit` after a `read` needs the hash, and `--json` is the one mode
that surfaces it on stdout without a second lookup. `--raw` is for getting the file exactly as it
lives on disk (e.g. a manual diff or backup) — no metadata is separately reported in that mode since
it's already present in the raw output.

## Commands

| Command | Flags | Notes |
|---|---|---|
| `mnotes search <query>` | `--mode=hybrid\|fulltext\|semantic`, `--limit=N`, `--explain`, `--json` | See `--explain` below. |
| `mnotes grep <pattern>` | `--regex`, `--note=<title>`, `--json` | |
| `mnotes tags list` | `--json` | |
| `mnotes tags notes <tag>` | `--json` | |
| `mnotes read <title>` | `--start=N`, `--end=N`, `--raw`, `--json` | See output modes above; default is neither raw nor JSON. |
| `mnotes write <title>` | `--hash=H`, `--metadata='{...}'`, `--content="..."` | Content from stdin if `--content` omitted. |
| `mnotes edit <title>` | `--hash=H`, `--old="..."`, `--new="..."`, `--metadata='{...}'` | |
| `mnotes append <title>` | `--hash=H`, `--content="..."` | Content from stdin if `--content` omitted. |
| `mnotes rename <old-title> <new-title>` | `--hash=H` | |
| `mnotes reindex [title]` | | Talks to the daemon over the S005 Unix socket; hard error if daemon isn't running. Blocks until done, streaming attempt/retry progress for a single-title reindex. |
| `mnotes stats` | `--json` | See below. |

Every command other than `reindex`/`stats` is a thin wrapper: parse flags, call the corresponding
`core/` function directly in-process (`core/search.js`, `core/grep.js`, `core/tags.js`,
`core/notes.js`), format the result. Mutations (`write`/`edit`/`append`/`rename`) touch the vault file
directly and rely on the daemon's `fswatch` loop (S005) to pick up the resulting change asynchronously
— the CLI doesn't wait for reindexing to complete on a plain write, only `reindex` does (since that's
its whole point).

### `--explain` (search only)

Since the MCP-facing "no raw scores" rule (README) doesn't apply to this CLI debug surface,
`--explain` shows, per result: raw BM25 score, raw cosine distance, which chunk won the
best-chunk-wins collapse (with its `char_start`/`char_end`), and the RRF score with its formula
breakdown (`1/(k+fulltext_rank) + 1/(k+semantic_rank) = ...`). Plus pipeline-level detail: how many
chunks/notes were over-fetched before collapsing/truncating to `limit`, and the actual FTS5 expression
sent to `MATCH` (relevant now that `hybrid` mode passes DSL through unmodified, per S002) — this is
the level of detail that makes "why didn't note X show up" actually answerable.

### `mnotes stats`

Per the README: note count, tag count, total/average note length, embedding model name/version,
count of notes pending re-embedding, index file size, last reindex time. All of this is a direct
read against the tables in S001 (no daemon dependency for these — pure DB queries) — `pending
re-embedding` is a `chunks`/`notes` join comparing stored `embedding_model`/`embedding_version` to the
currently configured model, `last reindex time` is `meta.last_full_reindex_at`.

Additionally reports **daemon status** (running / not running) and **current queue depth**
(`SELECT COUNT(*) FROM index_queue`) — the queue depth is a genuinely useful signal now that indexing
is queue-based (S005): a large or growing count means the daemon is behind or stuck. Daemon status is
a best-effort courtesy check (attempt a socket connection, non-blocking if it fails) — `stats` itself
never requires the daemon to be up, unlike `reindex`.

## Explicitly out of scope here

- **`mnotes reindex`'s actual protocol/behavior talking to the daemon** — fully specified in S005;
  this spec only adds the CLI-side flag parsing and output formatting around that call.
- **Exact JSON shape of `--explain`/`--json` output** — left to implementation; this spec establishes
  what information must be present, not the precise field names/nesting.
