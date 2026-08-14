# S006 — CLI

Status: **Approved**
Owns: `src/cli/main.js`, `src/cli/reindex.js`, `src/cli/daemon.js`, `src/cli/stats.js`
Depends on: `S001-data-model`, `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`,
`S010-shared-utilities`, `S011-links`
Consumed by: (terminal use, `obsidian.nvim` integration)

## Purpose

Defines `mnotes`'s subcommand surface. Per the README, the CLI is "the same underlying functionality
as the MCP server, with additional flags for debugging" plus two CLI-only commands (`reindex`,
`stats`). This spec's job is to pin down argument parsing, output formatting, and the handful of
CLI-specific concerns (no `reason`, `--explain`, stdin content input) that don't apply to the MCP
surface.

## Argument parsing

Node's built-in `util.parseArgs` — no CLI framework dependency. Subcommand routing is a small
dispatch table keyed on `argv[2]` (`search`, `grep`, `tags`, `links`, `read`, `write`, `edit`, `append`,
`rename`, `reindex`, `daemon`, `stats`), each parsing its own remaining flags via `parseArgs`. This matches the
project's minimal-dependency, no-build-step bias — a dozen flat subcommands doesn't need a framework's
nested-command/auto-help machinery.

`dispatch()` intercepts `--help`/`-h` itself, ahead of routing to a command handler: `mnotes` (no
command), `mnotes --help`, or `mnotes -h` prints the full command list; `mnotes <command> --help` (the
flag can appear anywhere in that command's args) prints just that command's usage line instead of
running it. This is a static lookup table in `cli/main.js`, not per-handler flag parsing — an unknown
command is still an error regardless of a trailing `--help`.

## Output format

**Mirrors MCP tool output exactly** — the same pipe-delimited columnar text for list-style commands
(`search`, `grep`, `tags list`, `tags notes`) and the same structured JSON for `write`/`edit`/`append`/
`rename`, produced by the same formatting function each MCP tool handler calls. This is a direct
consequence of the architecture rule that `cli/` and `mcp/` must not duplicate logic — one formatter
per tool, shared by both surfaces, rather than a second "human-friendly" renderer that could drift
from what Claude actually sees. **`grep`'s `--content` flag (see Commands below) is the one
deliberate exception**: `formatGrepTable`'s `includeText` option is still the single shared formatter
(no duplicated rendering logic), but the CLI is the only caller that ever passes `includeText: true`
— a human at a terminal running `grep` interactively benefits from seeing match text inline, where
the MCP tool (S007) never does, for context-budget reasons specific to that surface.

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

**`<title>` resolves in all three modes** (S003/S010): an exact title match first, then a fallback to
a unique-basename match (e.g. `mnotes read "Barbara Garn"` finds a note actually at
`LoonStateHockey/JMS Hockey/Barbara Garn`, provided that's the only note with that basename) — this
applies to `--raw` too, not just the default/`--json` modes, even though `--raw` reads the file
directly rather than going through `noteRead`. `--json`'s `title` field reflects the *resolved*
absolute title, not an echo of whatever was typed — the mechanism that lets a script chain a
`write`/`edit`/`rename` after a `read` that started from a short reference (those commands require the
exact absolute title — see "Absolute titles for mutating commands" below).

## Commands

| Command | Flags | Notes |
|---|---|---|
| `mnotes search <query>` | `--mode=hybrid\|fulltext\|semantic`, `--limit=N`, `--explain`, `--json` | See `--explain` below. |
| `mnotes grep <pattern>` | `--regex`, `--note=<title>`, `--content`, `--json` | `--content` shows each match's line text; omitted by default (line numbers only), matching the MCP tool's output shape unless explicitly opted into. `--note` resolves the same way `read`'s `<title>` does (S010). |
| `mnotes tags list` | `--json` | |
| `mnotes tags notes <tag>` | `--json` | |
| `mnotes links <title>` | `--json` | Backlinks and forward links for one note — see `mnotes links` below. |
| `mnotes links broken` | `--json` | Every dangling `[[wikilink]]` in the vault — see `mnotes links` below. |
| `mnotes read <title>` | `--start=N`, `--end=N`, `--raw`, `--json` | See output modes above; default is neither raw nor JSON. |
| `mnotes write <title>` | `--hash=H`, `--metadata='{...}'`, `--content="..."` | Content from stdin if `--content` omitted. |
| `mnotes edit <title>` | `--hash=H`, `--old="..."`, `--new="..."`, `--metadata='{...}'` | |
| `mnotes append <title>` | `--hash=H`, `--content="..."` | Content from stdin if `--content` omitted. |
| `mnotes rename <old-title> <new-title>` | `--hash=H` | |
| `mnotes reindex [title]` | | Talks to the daemon over the S005 Unix socket; hard error if daemon isn't running. Blocks until done, streaming attempt/retry progress for a single-title reindex. |
| `mnotes daemon <start\|stop\|restart>` | | Controls the `launchd`-managed daemon process itself (not the IPC socket) — see below. |
| `mnotes stats` | `--json` | See below. |

Every command other than `reindex`/`stats` is a thin wrapper: parse flags, call the corresponding
`core/` function directly in-process (`core/search.js`, `core/grep.js`, `core/tags.js`,
`core/notes.js`, `core/links.js`), format the result. Mutations (`write`/`edit`/`append`/`rename`)
touch the vault file directly and rely on the daemon's `fswatch` loop (S005) to pick up the resulting
change asynchronously — the CLI doesn't wait for reindexing to complete on a plain write, only
`reindex` does (since that's its whole point).

### Absolute titles for mutating commands

`mnotes write`/`edit`/`append`/`rename` (`<old-title>` *and* `<new-title>`) always require the note's
exact absolute title — full path from vault root, folder prefix included — with **no** unique-basename
fallback (S003/S010). `mnotes read`/`grep --note=`/`mnotes links <title>` do get that fallback; the
mutating commands deliberately don't, for the same reason S003/S010 give: `write`'s create-vs-update
branch depends on "does this exact title already exist" meaning something unambiguous, and a wrong
resolution on a mutating command is a far worse failure than one on a read. `--help` output for each
of these four commands states the exact-title requirement explicitly, not just this spec.

If you only have a short or ambiguous reference to a note (e.g. text copied out of a `[[wikilink]]`),
`mnotes read`/`mnotes links` resolve it and report the real absolute title back to you — use that for
any follow-up mutating command, rather than passing the short reference straight through.

### `mnotes links`

CLI-only — there's no MCP equivalent (S011 deliberately keeps the link graph off the MCP tool surface;
`note_read` already carries `backlinks`/`links_out` for Claude). Two forms:

- **`mnotes links <title>`** — the same `backlinks`/`links_out` data `note_read` returns, without
  reading the rest of the note. Implemented as `noteRead(vaultRoot, title, { db })` (S003) with only
  those two fields projected out — not a second, parallel code path for deriving them, so this can
  never drift from what `note_read` itself reports for the same note, and `<title>` gets the same
  exact-then-basename resolution `read` does (S010). Default output is the pipe-
  delimited table convention (`direction|note_title`, one row per link, `direction` either `backlink`
  or `link_out`), matching every other list-style command; `--json` returns `{ backlinks, links_out }`
  in the same shape `note_read` uses.
- **`mnotes links broken`** — every dangling `[[wikilink]]` in the vault (a `target_title` with no
  matching note), via `core/links.js`'s `getBrokenLinks` (S011). Table columns `note_title` (the note
  containing the link) and `broken_target` (the unresolved title it points at).

**`broken` is a reserved subcommand keyword**, the same tradeoff `tags list`/`tags notes` already makes
— a note literally titled "broken" can't be looked up via `mnotes links broken` (it'll run the broken-
links listing instead). Accepted as a known, minor limitation rather than adding lookup ambiguity to
resolve it; not expected to collide with real vault content.

### `--explain` (search only)

Since the MCP-facing "no raw scores" rule (README) doesn't apply to this CLI debug surface,
`--explain` shows, per result: raw BM25 score, raw cosine distance, which chunk won the
best-chunk-wins collapse (with its `char_start`/`char_end`), and the RRF score with its formula
breakdown (`1/(k+fulltext_rank) + 1/(k+semantic_rank) = ...`). Plus pipeline-level detail: how many
chunks/notes were over-fetched before collapsing/truncating to `limit`, and the actual FTS5 expression
sent to `MATCH` (relevant now that `hybrid` mode passes DSL through unmodified, per S002) — this is
the level of detail that makes "why didn't note X show up" actually answerable.

### `mnotes daemon <start|stop|restart>`

A thin wrapper around `launchctl`, targeting the `com.ajmichels.mnotes` LaunchAgent (S009) directly —
distinct from `mnotes reindex`, which talks to the *already-running* daemon over its IPC socket.
This command manages the process itself, for when the daemon is stuck, needs picking up after a config
change, or needs to be stopped entirely:

- `start` — `launchctl bootstrap gui/<uid> <plist path>`, loading the LaunchAgent (a no-op error if
  it's already loaded).
- `stop` — `launchctl bootout gui/<uid>/com.ajmichels.mnotes`, unloading it. Since the plist sets
  `KeepAlive: true` (S009), a plain kill/signal would just have `launchd` immediately relaunch the
  process — `bootout` is the only way to actually stop it until the next `start` (or the next login,
  since `RunAtLoad` is also `true`).
- `restart` — `launchctl kickstart -k gui/<uid>/com.ajmichels.mnotes`, killing and relaunching a
  currently-loaded daemon in place.

`launchctl`'s own stderr is surfaced directly in the error message on failure (e.g. `restart` against
a daemon that was never started) rather than being pattern-matched into a synthesized message —
`launchctl`'s exact wording isn't stable across macOS versions, so passing it through as-is is more
reliable than guessing at it.

### `mnotes stats`

Per the README: note count, tag count, total/average note length, embedding model name/version,
count of notes pending re-embedding, index file size, last reindex time. All of this is a direct
read against the tables in S001 (no daemon dependency for these — pure DB queries) — `pending
re-embedding` is a `chunks`/`notes` join comparing stored `embedding_model`/`embedding_version` to the
currently configured model, `last reindex time` is `meta.last_full_reindex_at`.

Also reports two link counts (S011), grouped alongside `tag_count` as the same kind of vault-inventory
number: `link_count` (`SELECT COUNT(*) FROM note_links`, total wikilinks vault-wide) and
`broken_link_count` (`core/links.js`'s `getBrokenLinks(db).length` — not a second hand-rolled `COUNT`
query, so this can never disagree with `mnotes links broken`'s own listing about what counts as
broken). `broken_link_count` is the actionable one: it plays the same role `pending_reembedding_count`
already plays in this dashboard — a single number that tells you whether it's worth running the
detailed command (`mnotes links broken`), without having to run it speculatively every time.

Additionally reports **daemon status** (running / not running) and **current queue depth**
(`SELECT COUNT(*) FROM index_queue`) — the queue depth is a genuinely useful signal now that indexing
is queue-based (S005): a large or growing count means the daemon is behind or stuck. Daemon status is
a best-effort courtesy check (attempt a socket connection, non-blocking if it fails) — `stats` itself
never requires the daemon to be up, unlike `reindex`.

## Logging

Per `S008`, the CLI's *only* use of `src/logger.js` is the audit trail for mutating commands — it
never uses the logger for its own normal stdout/stderr output, and (unlike the daemon and MCP server)
it does **not** wrap command dispatch in a `runWithLogger` context:

- `mnotes search`/`grep`/`tags`/`read` — no logging at all. These call into `core/search.js`,
  `core/grep.js`, `core/tags.js`, `core/notes.js` with no enclosing `runWithLogger`, so any
  `getContextLogger()` calls inside those `core/` modules (`S002`'s malformed-query `warn`, `S004`'s
  ripgrep-not-found `warn`) silently resolve to the no-op logger when invoked from the CLI — those
  lines only exist for the MCP server, which does establish a context (`S007`). This matches the
  README's original "CLI is interactive, doesn't need persistent logging" framing for reads.
- `mnotes write`/`edit`/`append`/`rename` — after the command completes (success or a caught thrown
  error), the CLI calls `logAudit(getAuditLogger(defaultLogDir()), { tool, noteTitle, source: 'cli',
  outcome, errorMessage })` (`S008`) — `reason` is always absent (`source: 'cli'` never carries one, per
  "No `reason` flag" above). This is a direct call to `logAudit`, not a `runWithLogger`-wrapped
  context, so — same as the read commands — `core/notes.js`'s own incidental logging (`S003`'s
  caller-supplied-`id`-overwrite `debug` line) resolves to the no-op logger for CLI-driven mutations;
  only the MCP server's tool calls get that detail captured. This is a deliberate consequence of
  `S008`'s "CLI's only use of the logger is `audit.log`" decision, not an oversight — reintroducing a
  `cli.log` for incidental `core/` debug output would be a new architectural surface `S008` explicitly
  didn't add.
- `mnotes reindex`/`stats` talk to the daemon over its socket (`S005`) — no CLI-side logging beyond
  what those commands print to stdout/stderr directly; the daemon's own `indexer.log` already captures
  the actual reindex work.

## Explicitly out of scope here

- **`mnotes reindex`'s actual protocol/behavior talking to the daemon** — fully specified in S005;
  this spec only adds the CLI-side flag parsing and output formatting around that call.
- **Exact JSON shape of `--explain`/`--json` output** — left to implementation; this spec establishes
  what information must be present, not the precise field names/nesting.
