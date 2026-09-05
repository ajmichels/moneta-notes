# S006 — CLI

Status: **Approved**
Owns: `src/cli/main.js`, `src/cli/reindex.js`, `src/cli/daemon.js`, `src/cli/stats.js`, `src/cli/logs.js`
Depends on: `S001-data-model`, `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`,
`S008-logging` (`mnotes logs` reads its three log files, parsing `audit.log`'s line format
specifically), `S009-config-and-install` (`src/platform` supplies `mnotes daemon`'s service-control
functions — see below; also owns the `launchd`/`systemd` templates whose redirected stdout/stderr
files `mnotes logs --file=daemon.stdout` etc. read), `S010-shared-utilities`, `S011-links`,
`S012-attachments`
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
`rename`, `attachment`, `reindex`, `daemon`, `stats`, `logs`, `vectors`), each parsing its own remaining
flags via `parseArgs`. This matches the
project's minimal-dependency, no-build-step bias — a dozen flat subcommands doesn't need a framework's
nested-command/auto-help machinery.

`dispatch()` intercepts `--help`/`-h` itself, ahead of routing to a command handler: `mnotes` (no
command), `mnotes --help`, or `mnotes -h` prints the full command list; `mnotes <command> --help` (the
flag can appear anywhere in that command's args) prints just that command's usage line instead of
running it. This is a static lookup table (`COMMAND_USAGE` in `cli/main.js`) keyed by top-level
command name, not per-handler flag parsing — an unknown command is still an error regardless of a
trailing `--help`.

**`vectors` is the one exception to the static-lookup-table approach**, per S013: it has no
`COMMAND_USAGE` entry, and `dispatch()` explicitly skips its generic `--help` short-circuit for this
one command, always calling `runVectorsCommand` (`cli/vectors.js`) and letting it interpret `--help`
itself. This is because `vectors` has eight sub-subcommands with genuinely distinct, non-trivial flag
sets — a single flat usage line (adequate for every other command's `--help`) would either have to
cram all eight together or lose the sub-subcommand-specific detail entirely. `runVectorsCommand`
implements the same two-tier shape the top-level CLI does (`mnotes vectors`/`mnotes vectors --help`
lists subcommands; `mnotes vectors <subcommand> --help` gives that subcommand's full usage, argument,
and flag documentation), just one level down.

## Output format

**Mirrors MCP tool output** — the same pipe-delimited columnar text for list-style commands
(`search`, `grep`, `tags list`, `tags notes`, `links`) and the same structured JSON for
`write`/`edit`/`append`/`rename`, produced by the same formatting function each MCP tool handler calls.
This is a direct consequence of the architecture rule that `cli/` and `mcp/` must not duplicate logic —
one formatter per tool, shared by both surfaces, rather than a second "human-friendly" renderer that
could drift from what Claude actually sees. Two deliberate exceptions, both opt-in flags/options on the
otherwise-shared formatter rather than a parallel rendering path:

- **`grep`'s `--content` flag**: `formatGrepTable`'s `includeText` option is still the single shared
  formatter, but the CLI is the only caller that ever passes `includeText: true` — a human at a
  terminal running `grep` interactively benefits from seeing match text inline, where the MCP tool
  (S007) never does, for context-budget reasons specific to that surface.
- **Column alignment**: every `formatTable`-based CLI table (`search`, `grep`, `tags list`,
  `tags notes`, `links`, `links broken`) passes `align: true`, which pads each column to its widest
  cell and inserts a hyphen-filled separator row under the header, so columns line up visually in a
  terminal. MCP's calls to the same formatters leave `align` at its default (`false`, compact/unpadded)
  — an LLM reader gets no benefit from the padding, and it costs tokens on every tool response. The
  underlying values and column set are identical either way; only the whitespace differs.

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
| default | Note body only, frontmatter stripped | Parsed `metadata` object, as pretty-printed (indented) JSON |
| `--raw` | The exact file bytes as stored (frontmatter included), unmodified | Nothing |
| `--json` | Full MCP-identical structured JSON (`title`, `content_hash`, `metadata`, `content`, line info) | Nothing |

`--json` exists because `content_hash` isn't visible in either of the other two modes' stdout — any
script that wants to chain a `write`/`edit` after a `read` needs the hash, and `--json` is the one mode
that surfaces it on stdout without a second lookup. `--raw` is for getting the file exactly as it
lives on disk (e.g. a manual diff or backup) — no metadata is separately reported in that mode since
it's already present in the raw output.

Default mode's stderr JSON is pretty-printed (`JSON.stringify(metadata, null, 2)`, trailing blank line)
rather than the compact single-line JSON `--json`/`--explain --json` produce on stdout — stderr here is
for a human skimming metadata at a glance, not a script parsing it, so indentation costs nothing and
helps readability. `main()` also writes stderr before stdout for every command, so this metadata prints
ahead of the note body when both streams land in the same terminal.

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
| `mnotes attachment read <path>` | `--raw`, `--metadata`/`--json` | Default action opens the file via the OS default app (`open`); see S012. |
| `mnotes attachment write <path> [local-file]` | | Reads `<local-file>` off local disk (stdin if omitted), writes it to `<path>` (vault-relative) — see S012. |
| `mnotes reindex [title]` | | Talks to the daemon over the S005 Unix socket; hard error if daemon isn't running. Blocks until done, streaming attempt/retry progress for a single-title reindex. |
| `mnotes daemon <start\|stop\|restart>` | | Controls the OS-service-managed daemon process itself (not the IPC socket) — see below. |
| `mnotes stats` | `--json` | See below. |
| `mnotes logs` | `--file=<name>` (7 values, see below), `--source=mcp\|cli`, `--tool=<name>`, `--note=<title>`, `--outcome=success\|error`, `--since=<duration\|ISO8601>`, `--limit=N`, `--follow`, `--json` | `--file` defaults to `audit`; the rest are audit-only — see below. |
| `mnotes vectors <subcommand>` | (per subcommand) | `compare`/`nearest`/`cluster`/`reduce`/`tag-fit`/`tag-redundancy`/`outliers`/`calibrate` — CLI-only debug/analysis tooling over the raw embedding space, no MCP equivalent (same rationale as `mnotes links`). Fully specified in [S013 — Vector Tools](S013-vector-tools.md), which owns `src/cli/vectors.js` and amends this spec only to add `vectors` to the dispatch table above. |

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

### `mnotes attachment read|write` (S012)

Read/write access to binary vault files that aren't notes (images, PDFs, etc.) — no index backs these,
so `<path>` is always the exact vault-relative path, never resolved against a short reference the way
`read`/`grep --note=`/`links <title>` are.

`mnotes attachment read <path>` has three modes: default shells out to `open <resolved-path>` (the OS
default app for that file type — no bytes touch `mnotes`' own stdout); `--raw` streams the file's exact
bytes to stdout (subject to the same `[attachments].max_read_bytes` cap the MCP tool's
`include_content` uses); `--metadata`/`--json` (aliases) print `{ path, size_bytes, mime_type }` with
no bytes and no cap. `mnotes attachment write <path> [local-file]` reads `<local-file>` off local disk
(or, if omitted, raw bytes from stdin — same fallback `write`/`append` already have for note content)
and writes it to `<path>` — create-or-overwrite, no hash guard (S012's binary-content rationale for why
CLAUDE.md's hash rule doesn't apply here).

### `--explain` (search only)

Since the MCP-facing "no raw scores" rule (README) doesn't apply to this CLI debug surface,
`--explain` shows, per result: raw BM25 score, raw cosine distance, which chunk won the
best-chunk-wins collapse (with both its `char_start`/`char_end` and its derived `line_start`/
`line_end`, per S001/S002), and the RRF score with its formula breakdown
(`1/(k+fulltext_rank) + 1/(k+semantic_rank) = ...`). Plus pipeline-level detail: how many
chunks/notes were over-fetched before collapsing/truncating to `limit`, and the actual FTS5 expression
sent to `MATCH` (relevant now that `hybrid` mode passes DSL through unmodified, per S002) — this is
the level of detail that makes "why didn't note X show up" actually answerable.

Non-JSON output is a pipeline-summary line (`mode=... limit=... overfetch=... fts5_expression=...`)
followed by the same aligned, column-headered table every other list-style command uses (see "Output
format" above) — column set varies by mode (`bm25` for fulltext; `cosine`/`chunk` for semantic;
`fulltext_rank`/`semantic_rank`/`rrf` for hybrid), but the header-row-then-separator-then-data shape is
consistent with `search`/`grep`/`tags`/`links`.

### `mnotes daemon <start|stop|restart>`

A thin wrapper around `src/platform`'s `startDaemonService`/`stopDaemonService`/`restartDaemonService`
(S009) — `src/cli/daemon.js` itself contains no `launchctl`/`systemctl` calls or `process.platform`
checks; it just calls whichever platform module `src/platform/index.js` selected. Distinct from
`mnotes reindex`, which talks to the *already-running* daemon over its IPC socket. This command manages
the process itself, for when the daemon is stuck, needs picking up after a config change, or needs to
be stopped entirely:

- `start` — macOS: `launchctl bootstrap gui/<uid> <plist path>`, loading the LaunchAgent (a no-op error
  if it's already loaded). Linux: `systemctl --user start mnotes.service` — the unit is already
  loaded/enabled by `scripts/install.sh` (S009), so `start` here just (re)starts the process, not a
  load/enable step.
- `stop` — macOS: `launchctl bootout gui/<uid>/com.ajmichels.mnotes`, unloading it. Since the plist sets
  `KeepAlive: true` (S009), a plain kill/signal would just have `launchd` immediately relaunch the
  process — `bootout` is the only way to actually stop it until the next `start` (or the next login,
  since `RunAtLoad` is also `true`). Linux: `systemctl --user stop mnotes.service` — `Restart=always`
  (S009's equivalent of `KeepAlive`) only restarts a service that *crashes*, not one `systemctl stop`
  asked to stop, so a plain `stop` is sufficient here; the unit stays enabled and comes back on next
  login same as macOS's `RunAtLoad`.
- `restart` — macOS: `launchctl kickstart -k gui/<uid>/com.ajmichels.mnotes`, killing and relaunching a
  currently-loaded daemon in place. Linux: `systemctl --user restart mnotes.service`.

The underlying service manager's own stderr is surfaced directly in the error message on failure (e.g.
`restart` against a daemon that was never started) rather than being pattern-matched into a synthesized
message — neither `launchctl`'s nor `systemctl`'s exact wording is stable across OS/distro versions, so
passing it through as-is is more reliable than guessing at it. This was already true of the macOS-only
version of this code and carries over unchanged to the Linux implementation.

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

### `mnotes logs`

CLI-only, like `links`/`vectors` — no MCP equivalent, since there's no reason an agent would need to
introspect its own audit trail through a tool call. `--file=<name>` picks which log file, defaulting to
`audit` — that's the file that actually answers "what has an agent been doing through MCP," which is
what this command exists for, so it's the default rather than requiring `--file=audit` explicitly every
time. `<name>` is one of seven values, each mapping mechanically to `<name>.log` under the log
directory (S008/S009):

- **`audit`** (default) — S008's structured audit trail; the only one this command actually parses.
- **`indexer`**, **`mcp-server`** — S008's other two logger.js-written files: lifecycle/prose text, not
  structured per-call records.
- **`daemon.stdout`**, **`daemon.stderr`**, **`logrotate.stdout`**, **`logrotate.stderr`** — not
  logger.js output at all. These are the raw stdout/stderr the service manager (`launchd` on macOS,
  `systemd --user` on Linux) redirects the daemon and log-rotator *processes* to, per
  `launchd/*.plist.template`/`systemd/*.service.template` (S009's `StandardOutPath`/`StandardErrorPath`
  and `StandardOutput`/`StandardError` keys) — whatever Node happens to print outside of `logger.js`
  (an experimental-feature warning, an uncaught exception's stack trace). Normally near-empty; the
  first place to look when a service fails to start at all, before it's even reached the point of
  writing its own `indexer.log`/lifecycle line. Unlike the other five, these two processes' output
  isn't rotated by `src/log-rotator.js` (`LOG_FILE_NAMES` there only covers the three S008 files) — an
  existing, unrelated gap this spec doesn't attempt to close.

For every value other than `audit`, `mnotes logs` is a `--follow`/`--limit`-over-raw-lines convenience,
not a parser — it prints each line exactly as stored, with no field extraction and no table formatting.
**Every audit-specific flag (`--source`, `--tool`, `--note`, `--outcome`, `--since`, `--json`) is a hard
error when combined with a non-`audit` `--file`** (naming every offending flag in one message, not just
the first) — these flags presuppose the structured shape only `audit.log` has, and silently ignoring
them would let a `--file=indexer --outcome=error` typo look like it did something when it didn't.

`src/cli/logs.js` parses each `audit.log` line back into a structured record (`timestamp`, `tool`,
`source`, `noteTitle`/`attachmentPath`, `reason`, `outcome`, `errorMessage`) by inverting
`logger.js`'s own line-formatting grammar — not a second, independently-evolving format, so a change to
`formatLine`/`formatValue` (S008) that isn't mirrored here will show up as a parse failure (a skipped
line) rather than silently drifting. `--file=indexer`/`mcp-server` skip this parser entirely — they
never need it, since there's no structured record to extract.

**Filters** (`--source`, `--tool`, `--note`, `--outcome`, `--since`, `--limit`) AND together, and only
apply to `--file=audit` (see above); there's no `--match=any` here unlike `metadata query`, since
combining audit fields with OR semantics isn't a usage pattern this command needs to support. `--note`
matches either `note_title` or `attachment_path` on an entry, whichever that entry actually carries
(S012's identifier-slot design) — exact match, no resolution, the same as `mnotes attachment`'s
`<path>`. `--since` accepts a relative shorthand (`30m`, `1h`, `2d` — seconds/minutes/hours/days) or a
full ISO-8601 timestamp. `--limit` (last N) and `--follow` apply to any of the seven files, since both
are meaningful over plain lines just as much as over parsed entries.

**Output for `--file=audit`**: default is the same aligned pipe-table convention as
`search`/`grep`/`tags`/`links`, one column per audit field (`note_title`/`attachment_path` collapsed
into a single `identifier` column, since an entry only ever carries one of the two). **`--json` is
NDJSON here — one compact JSON object per line — not the single-array shape every other command's
`--json` uses.** This is deliberate, not an inconsistency: `--json` has to mean the same thing whether
or not `--follow` is also given, and `--follow`'s output is inherently an open-ended stream of
individual lines that can never be wrapped in a closing `]`.

**Output for every other `--file` value**: each line exactly as it appears in the file, joined with
`\n` — no table, no JSON option (rejected per the audit-only-flags rule above, since there's no
structured shape to serialize).

With no `--limit`, non-`--follow` mode prints every matching (or, for a non-`audit` file, every) line
in the file, oldest-first, same as `grep`/`cat` would — no implicit cap.

**`--follow`** tails whichever file `--file` selects like `tail -f` (not `tail -F`): it does not pick a
file back up after S008's log-rotator renames it away mid-run, matching `tail -f`'s own well-known
limitation rather than solving log-rotation-awareness as a new feature. This is the one command in the
CLI that requires a documented exception to the "every command returns one
`{ stdout, stderr, exitCode }` from `dispatch()`" convention (see "Argument parsing" above): a live
follow never finishes on its own, so `runLogsCommand` writes each matching line directly to
`process.stdout` (or `deps.write` under test) as it arrives, rather than accumulating a return value —
the same behavior `tail -f` itself has, ended by Ctrl-C or by a downstream pipe closing, with no
special-case code needed for either. This is what makes `mnotes logs --follow | grep ...` (or
`mnotes logs --file=indexer --follow | grep ERROR`) work as a live filter, which plain buffered command
output could not support. `followLogFile` (the underlying watcher) is file-format-agnostic — it just
hands the caller each raw appended line; `--file=audit`'s caller parses/filters that line, every other
`--file` value's caller prints it straight through.

`--follow` defaults to printing the last **20** matching/available lines as backlog before switching to
live output (`--limit=N` overrides that backlog size, same flag either way, on any of the seven files)
— bigger than `tail -f`'s own default of 10, but still bounded rather than "print everything," since
the goal is recent context, not a full replay. Streamed `--file=audit` output while following uses a
header-less single-row rendering (`formatLogRow`), not the aligned table `formatLogsTable` produces for
the backlog/non-follow case — a table header re-printed per arriving line, or inconsistent with the
already-printed backlog's column widths, would be worse than no header at all for a stream a reader is
watching scroll by. Every other `--file` value has no such distinction to make — backlog and
streamed lines are both just the raw line text either way.

## Logging

Per `S008`, the CLI's *only* use of `src/logger.js` is the audit trail for mutating commands — it
never uses the logger for its own normal stdout/stderr output, and (unlike the daemon and MCP server)
it does **not** wrap command dispatch in a `runWithLogger` context:

- `mnotes search`/`grep`/`tags`/`read`/`attachment read` — no logging at all. These call into
  `core/search.js`, `core/grep.js`, `core/tags.js`, `core/notes.js`, `core/attachments.js` with no
  enclosing `runWithLogger`, so any `getContextLogger()` calls inside those `core/` modules (`S002`'s
  malformed-query `warn`, `S004`'s ripgrep-not-found `warn`) silently resolve to the no-op logger when
  invoked from the CLI — those lines only exist for the MCP server, which does establish a context
  (`S007`). This matches the README's original "CLI is interactive, doesn't need persistent logging"
  framing for reads.
- `mnotes logs` — also no logging, for the same "read-only" reason, though it's not a `core/` caller at
  all (it reads `audit.log` directly, per the `mnotes logs` section above) — mentioned here for
  completeness, not because it shares the other read commands' code path.
- `mnotes write`/`edit`/`append`/`rename`/`attachment write` — after the command completes (success or
  a caught thrown error), the CLI calls `logAudit(getAuditLogger(defaultLogDir()), { tool, noteTitle,
  source: 'cli', outcome, errorMessage })` (`S008`) — `reason` is always absent (`source: 'cli'` never
  carries one, per
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
