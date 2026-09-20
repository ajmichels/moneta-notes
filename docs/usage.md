# Usage

Two ways to use `mnotes`: the **CLI** (terminal, `obsidian.nvim` integration) and the **MCP server**
(Claude Code / Claude Desktop). Both are thin wrappers around the same `core/` library, so behavior is
identical between them wherever a feature exists on both surfaces — see
[S006 — CLI](specs/S006-cli.md) and [S007 — MCP Server](specs/S007-mcp-server.md) for full detail.

Run `mnotes --help` or `mnotes <command> --help` any time for the in-tool version of this reference.

## Output formats

List-style commands (`search`, `grep`, `tags list`, `tags notes`, `metadata keys`, `metadata query`,
`links`) print pipe-delimited
columnar text by default, columns padded with whitespace so they stay visually aligned in a terminal,
with a `--json` flag for scripting or `obsidian.nvim` integration (JSON output is always compact, not
padded). Mutating commands (`write`/`edit`/`append`/`rename`) are always structured JSON
(`{ title, hash, line_count }`) — `--json` is a no-op for those.

`mnotes read` is the one exception: its default output is the raw note body (not JSON), so it pipes
naturally into `$EDITOR`, `less`, etc. See the table under [`mnotes read`](#mnotes-read-title) below.

`mnotes logs --json` is the other exception: it's NDJSON (one compact object per line), not a single
JSON array — necessary since `--follow` streams indefinitely and can never close a `]`. See
[`mnotes logs`](#mnotes-logs) below.

The raw RRF score is never shown in `hybrid`-mode search output — only rank position, since a fused
score isn't independently meaningful. `fulltext` and `semantic` mode are single-signal, though: their
native score (`bm25_score` / `cosine_distance`, respectively) is meaningful on its own and appears
alongside rank in normal output for those modes. Use `--explain` on `search` if you need the RRF
formula breakdown or per-side ranks together for debugging.

Any JSON that lands on stderr (currently just `read`'s metadata) is pretty-printed for readability,
unlike the compact single-line JSON `--json` produces on stdout for scripting. When a command writes to
both streams, stderr is flushed before stdout.

Every list-style command above, plus `read`, `attachment read`, and `links`/`links broken`, carries a
`readonly` field (`--json`) or column (default table output — `read-only` when set, blank otherwise)
when a note matches a pattern in `.mnotesreadonly` — see [Read-only paths](#read-only-paths) below.

## Read-only paths

A gitignore-style `.mnotesreadonly` file at the vault root (same syntax as `.mnotesignore` — comments,
negation, `Templates/`-style directory patterns) marks matching notes/attachments as protected: every
mutating command (`write`/`edit`/`append`/`rename`/`attachment write`) fails with an error naming the
exact pattern that matched, before touching disk. Unlike `.mnotesignore`, a read-only note stays fully
indexed and readable — the guard only blocks writes, and it's checked fresh on every call, so editing
`.mnotesreadonly` takes effect immediately with no daemon restart or reindex needed.

```
# .mnotesreadonly — vault root
Vendor/**
Archive/
Reference/imported-notes.md
```

`rename` checks **both** the old and new title — you can't move a read-only note away, and you can't
move an ordinary note onto a read-only-globbed path either. One exception: `rename`'s link-cascade
rewrite (see below) is still allowed to fix a `[[wikilink]]` inside a read-only note pointing at the
renamed note — leaving that link dangling would be worse than the cascade touching it. See
[S015](specs/S015-readonly-paths.md) for the full design.

## Multi-vault (`--vault`)

Every vault-scoped command below accepts `--vault=<name>`, naming one of the vaults configured under
`[vaults.<name>]` in `config.toml` (see [Configuration](configuration.md#vaults--vaultsname-and-default_vault)).
Omitted, it resolves via `default_vault` if set, or the sole configured vault if there's only one — the
common case, needing no flag at all. Run `mnotes vaults` to list what's configured.

**Cross-vault fan-out.** `search`, `grep`, `tags notes`, `metadata query`, and `links broken` are the
exception: with `--vault` omitted and 2+ vaults configured, they fan out across **every** configured
vault instead of erroring, tagging each row with a `vault` column (present only in this fanned-out
shape — an explicit `--vault`, or a single-vault setup, never adds it) and grouping output by vault
(each vault's own ranked block, `--limit` applied per vault — there's no cross-vault score/rank merge,
since BM25/cosine/RRF are all corpus-relative). Every other vault-scoped command (`read`, the mutating
commands, `stats`, `tags list`, `metadata keys`) has no such fallback — with 2+ vaults configured and no
`default_vault`, it's a hard error naming the configured vaults, since there's genuinely nothing to
default a single-note/single-corpus operation to.

```sh
mnotes read "Weekly Notes/2026-W32" --vault=dnd
mnotes search "goblin ambush"                    # fans out across every vault if 2+ are configured
mnotes search "goblin ambush" --vault=dnd        # scoped to one vault, same output shape as a
                                                  # single-vault install
mnotes vaults                                    # list configured vaults (name, description, default)
```

### `mnotes vaults`

```sh
mnotes vaults
mnotes vaults --json
```

Lists every configured vault: `name | description | default`. Never includes the on-disk path — a
caller tells vaults apart by name/description, not by where they live. No `--vault` flag (there's
nothing to scope to).

## Commands

### `mnotes search <query>`

```sh
mnotes search "obsidian sync conflict"
mnotes search "vector search" --mode=semantic --limit=5
mnotes search "index_queue retry" --explain
```

Flags: `--mode=hybrid|fulltext|semantic` (default `hybrid`), `--limit=N`, `--explain`, `--json`,
`--vault=<name>` (omitted with 2+ vaults configured, fans out across all of them — see
[Multi-vault](#multi-vault---vault) above).

`semantic`/`hybrid` mode embeds the query by asking the indexing daemon over its IPC socket (S005) —
neither the CLI nor the MCP server ever loads the embedding model itself, so this is a **hard error**
("could not connect to the daemon") if the daemon isn't running. `fulltext` mode has no such
dependency. Same behavior on the MCP `search` tool.

`--explain` is CLI-only debug output — a header line with the pipeline summary (mode, limit, overfetch),
followed by a column-headered, whitespace-aligned table showing raw BM25 score, raw cosine distance,
which chunk won the best-chunk-wins collapse, and the RRF score with its formula breakdown (columns vary
by mode). Useful for "why didn't note X show up" debugging; never exposed through MCP.

### `mnotes grep <pattern>`

```sh
mnotes grep "TODO"
mnotes grep '^\s*- \[ \]' --regex
mnotes grep "deadline" --note="Weekly Notes/2026-W32" --content
```

Flags: `--regex`, `--note=<title>` (restrict to one note — resolves the same way `read`'s `<title>`
does, see below), `--content` (show matched line text inline — CLI-only; the MCP tool always omits it
for context-budget reasons), `--json`, `--vault=<name>` (omitted with 2+ vaults configured, fans out —
see [Multi-vault](#multi-vault---vault) above).

A whole-vault `grep` (no `--note`) skips any path matched by a `.mnotesignore` file at the vault root —
a plain-text, gitignore-syntax file (comments, negation, `Templates/`-style directory patterns all
work) for excluding paths from both `grep` and the index (see `mnotes reindex` below). `--note=<title>`
still finds a note directly by name even if it matches `.mnotesignore` — the exclusion only affects
"search everywhere," not a lookup where you already know the title.

### `mnotes tags list` / `mnotes tags notes <tag>`

```sh
mnotes tags list
mnotes tags notes "project/moneta-notes"
```

Flags: `--json`, `--vault=<name>` — `list` requires it when 2+ vaults are configured (no fan-out);
`notes` fans out across every vault when omitted, same as `search`/`grep` above.

### `mnotes metadata keys` / `mnotes metadata query`

```sh
mnotes metadata keys
mnotes metadata query --filter="status=active"
mnotes metadata query --filter="priority>3" --filter="status!=archived"
mnotes metadata query --filter="due<2026-01-01" --exists=due
mnotes metadata query --filter="status in draft,review" --match=any
mnotes metadata query --filter="depends_on.project=project/moneta-notes"
mnotes metadata query --filter="tags=project"
```

Frontmatter search — every field except `tags` (which has its own purpose-built, indexed storage;
`tags` is still filterable here, see below) is projected into a searchable per-note JSON blob at index
time. `metadata keys` is discovery (`key | type | example | notes_with_key`, one row per distinct
field found across the vault, `type` inferred from one sampled value); `metadata query` filters notes
by one or more conditions on those fields.

Each `--filter` is a small string, parsed into `{key, op, value, negate}`:

| Filter string | Meaning |
|---|---|
| `key=value` | equals |
| `key!=value` | not equals (negated equals) |
| `key>value` / `key>=value` / `key<value` / `key<=value` | numeric or date range |
| `key in v1,v2,...` | equals any of a comma-separated list |

`key` may be a bare top-level field (`status`) or exactly one level of nesting (`depends_on.project`
— e.g. matching one field of an array-of-objects entry independently, like a `depends_on: [{project,
source}, ...]` list). Deeper nesting than that isn't addressable here — still fully visible via
`mnotes read`'s raw metadata output, just not filterable by this command. A value that looks like a
number (`3`) or `true`/`false` is parsed as that type, not a string; an unquoted `Y-M-D`-shaped date
value is compared correctly regardless of whether the stored value carries full timestamp precision.

`--exists=key`/`--missing=key` are sugar for `{key, op: 'exists'}` / `{key, op: 'exists', negate:
true}` — "does/doesn't have this field set at all." Multiple `--filter`/`--exists`/`--missing` flags
combine via `--match=all` (default, AND) or `--match=any` (OR) — a single flat toggle over every
condition given, not per-pair nested grouping.

`key: "tags"` is a special case: filterable here (`eq`/`in`/`exists` only — tags aren't ordered, so
`>`/`<` etc. are a usage error) without duplicating `mnotes tags`' storage or matching logic — it
resolves through the exact same exact-or-nested-child, case-insensitive match `tags notes` uses, so
`tags=project` also matches a note tagged `project/api-migration`.

Flags: `--filter=...` (repeatable), `--exists=key`/`--missing=key` (repeatable), `--match=all|any`
(default `all`), `--json`, `--vault=<name>` — `keys` requires it when 2+ vaults are configured (no
fan-out); `query` fans out across every vault when omitted, same as `search`/`grep` above.

### `mnotes links <title>` / `mnotes links broken`

```sh
mnotes links "Weekly Notes/2026-W32"
mnotes links broken
```

`mnotes links <title>` shows the same `backlinks`/`links_out` data `mnotes read --json` returns for
that note, without pulling the rest of the note's content — `<title>` resolves the same way `read`'s
does (exact match, then unique-basename fallback; see below). `mnotes links broken` lists every
dangling `[[wikilink]]` in the vault — a link whose target doesn't resolve to any current note.
"Doesn't resolve" covers both "no note matches at all" and "the basename is ambiguous, shared by more
than one note" — treated the same, since neither has an obvious single note to point at. Both are
index-backed (current as of each note's last reindex), and `broken` is a reserved subcommand keyword
(a note literally titled "broken" isn't reachable via this command).

Flags: `--json`, `--vault=<name>` — `<title>` requires it when 2+ vaults are configured (no fan-out,
it's about one specific note); `broken` fans out across every vault when omitted, same as
`search`/`grep` above.

### `mnotes read <title>`

```sh
mnotes read "Weekly Notes/2026-W32"
mnotes read "Weekly Notes/2026-W32" --start=10 --end=40
mnotes read "Weekly Notes/2026-W32" --raw > backup.md
mnotes read "Weekly Notes/2026-W32" --json | jq -r .content_hash
```

| Mode | stdout | stderr |
|---|---|---|
| default | Note body only, frontmatter stripped | Parsed `metadata` object, as pretty-printed JSON |
| `--raw` | Exact file bytes as stored (frontmatter included), unmodified | Nothing |
| `--json` | Full structured JSON (`title`, `content_hash`, `metadata`, `content`, line info, `backlinks`, `links_out`) | Nothing |

Also accepts `--vault=<name>` — required when 2+ vaults are configured and `default_vault` isn't set
(see [Multi-vault](#multi-vault---vault) above).

In default mode, the metadata on stderr is written before the body on stdout, so it appears first when
both streams land in the same terminal.

Use `--json` (or read `content_hash` from `mnotes write`/`edit`'s own output) any time you need the
hash for a follow-up `write`/`edit`/`rename` call — see the next section.

`backlinks` (notes that link to this one) and `links_out` (notes this one links to) are both plain
arrays of note titles, parsed from Obsidian-style `[[wikilinks]]`. `links_out` always reflects the
note's full body, even when `--start`/`--end` narrow what's actually printed. `backlinks` is
index-backed — current as of the last reindex of whichever note contains the link, same freshness as
`search` results.

**`<title>` doesn't have to be the exact full title.** It resolves the same way Obsidian itself
resolves a bare `[[wikilink]]`: an exact match first, and if that misses, a fallback to whichever note
has that as its unique basename (the last path segment — e.g. `mnotes read "Barbara Garn"` finds a
note actually at `LoonStateHockey/JMS Hockey/Barbara Garn`, as long as no other note in the vault
shares that basename). This applies in all three output modes, including `--raw`. If the basename is
shared by more than one note, it's treated as unresolved (same as no match at all) — Obsidian itself
has no documented, guaranteed rule for that case, so this doesn't try to guess one. **The `title` field
in `--json` output is always the resolved, real title** — not necessarily whatever string you typed —
so it's the one to use for a follow-up `write`/`edit`/`append`/`rename` call (see next section).

### `mnotes write <title>`, `mnotes edit <title>`, `mnotes append <title>`, `mnotes rename <old> <new>`

**Every mutating call on an existing note requires a matching content hash** — read the note first
(`mnotes read <title> --json`) to get its current `content_hash`, then pass it as `--hash`. A missing
hash against an existing title is a hard error, not a silent overwrite — this is deliberate (see
CLAUDE.md's architecture rules): notes can change outside of any given session, so the hash check
protects against clobbering someone else's concurrent edit. Creating a **new** note (no existing title)
doesn't need a hash.

**`<title>`/`<old-title>`/`<new-title>` on these four commands must be the exact absolute title** —
unlike `read`/`grep --note=`/`links <title>`, there's no short-form/basename resolution here. If you
only have a short reference (say, text copied out of a `[[wikilink]]`), `mnotes read` it first — the
`title` field in its `--json` output is the real, absolute title to use here.

```sh
# create a new note (no hash needed — it doesn't exist yet)
echo "# Weekly Notes 2026-W33" | mnotes write "Weekly Notes/2026-W33"

# edit an existing note — hash required
hash=$(mnotes read "Weekly Notes/2026-W32" --json | jq -r .content_hash)
mnotes edit "Weekly Notes/2026-W32" --hash="$hash" --old="- [ ] draft docs" --new="- [x] draft docs"

# append — content from stdin or --content
mnotes append "Daily Notes/2026-08-13" --hash="$hash" --content="Shipped the docs pages."

# rename
mnotes rename "Weekly Notes/2026-W32" "Weekly Notes/2026-W32-archived" --hash="$hash"
```

`rename` also rewrites `[[Weekly Notes/2026-W32]]`-style references in every other note that links to
the one being renamed, so nothing in the vault is left pointing at a stale title. This happens
automatically as part of the rename call — no separate step needed.

**Attachment writes work differently** (see [`mnotes attachment`](#mnotes-attachment-readwrite)
below): no hash guard, since there's no diffable text content to protect against clobbering.

All four also fail if the target matches a pattern in `.mnotesreadonly` — see
[Read-only paths](#read-only-paths) above; `rename` checks both the old and new title.

`write` and `append` read content from **stdin** if `--content` is omitted — works naturally with
`$EDITOR`-produced files, heredocs, or piped command output:

```sh
cat draft.md | mnotes write "Weekly Notes/2026-W33" --hash="$hash"
```

`edit`'s `--old`/`--new` are always flags (not stdin-eligible — a single stdin stream can't carry two
separate values). All four accept `--metadata='{...}'` to set structured frontmatter (never raw YAML
string manipulation), and all four accept `--vault=<name>` — required when 2+ vaults are configured
and `default_vault` isn't set.

These commands are logged to `audit.log` (`source: cli`, no `reason` — see
[Process Management](process-management.md#logs)) but don't wait for reindexing to complete; the
daemon's `fswatch` loop picks up the change asynchronously. Use `mnotes reindex <title>` if you need to
block until a specific note is reindexed.

### `mnotes attachment read|write`

```sh
mnotes attachment read "Attachments/receipt.pdf"                    # opens via the OS default app
mnotes attachment read "Attachments/receipt.pdf" --raw > backup.pdf # raw bytes to stdout
mnotes attachment read "Attachments/receipt.pdf" --metadata         # {path, size_bytes, mime_type}
mnotes attachment write "Attachments/receipt.pdf" ~/Downloads/receipt.pdf
curl -s https://example.com/report.pdf | mnotes attachment write "Attachments/report.pdf"
```

Read/write access to binary vault files that aren't notes — images, PDFs, anything a note references
via `![[...]]` or a markdown link. Unlike every other command here, **there's no index behind
attachments**, so `<path>` must be the exact vault-relative path (as it appears in the note's
reference) — no short-form/basename resolution, not even on the read side.

`mnotes attachment read`'s default action opens the resolved file with the OS default app (`open`) —
nothing is printed to stdout, since attachment bytes aren't meant to be dumped to a terminal. `--raw`
streams the exact bytes to stdout instead (useful for backing up a copy or piping elsewhere), subject
to the `[attachments].max_read_bytes` cap (see [Configuration](configuration.md#attachments));
`--metadata`/`--json` (aliases) print `{ path, size_bytes, mime_type }` with no bytes and no cap.

`mnotes attachment write <path> [local-file]` reads `<local-file>` off your local disk — or, if
omitted, raw bytes from stdin (the same fallback `write`/`append` already have for note content, see
above) — and writes it to `<path>` in the vault — always create-or-overwrite, no hash required (S012's
rationale: there's no diffable text content for a hash guard to protect). It also fails if `<path>`
matches a pattern in `.mnotesreadonly` (see [Read-only paths](#read-only-paths) above); `--metadata`/
`--json` on the read side includes a `readonly` field when the attachment is protected.

Both accept `--vault=<name>` — required when 2+ vaults are configured and `default_vault` isn't set.

### `mnotes reindex [title]`

```sh
mnotes reindex                              # full reindex
mnotes reindex "Weekly Notes/2026-W32"      # single note, streams attempt/retry progress
mnotes reindex --vault=dnd                  # scope to one configured vault
```

Talks to the *running* daemon over its Unix socket — hard error ("could not connect to the daemon") if
the daemon isn't up. Idempotent: running it twice with no intervening vault changes leaves the index in
the same state both times. See [Process Management](process-management.md) if this fails.

Accepts `--vault=<name>` — required when 2+ vaults are configured and `default_vault` isn't set (no
fan-out; a reindex always targets one vault's own queue).

A full `mnotes reindex` (no title) also re-reads `.mnotesignore` and purges any already-indexed note
that now matches it — the same cleanup a daemon restart does at startup. Add or edit `.mnotesignore`,
then run a full `mnotes reindex`, to retroactively exclude a folder (e.g. Obsidian template files,
which commonly have unquoted `{{placeholder}}` syntax in frontmatter that YAML misparses as nested
objects — see [S010](specs/S010-shared-utilities.md)) without waiting for each file to be touched
individually.

### `mnotes daemon <start|stop|restart>`

Controls the daemon process itself — `launchctl` on macOS, `systemctl --user` on Linux — distinct
from `reindex` above. Full detail in
[Process Management](process-management.md#mnotes-daemon-startstoprestart).

### `mnotes stats`

```sh
mnotes stats
mnotes stats --json
```

Note/tag/link counts (including `broken_link_count` — see `mnotes links broken` above for the full
listing), total/average note length, embedding model + version, count of notes pending re-embedding,
index file size, last full reindex time, daemon status, and current queue depth. Pure DB
reads plus a best-effort socket probe — never itself requires the daemon to be running. Single-vault
report, so it accepts `--vault=<name>` (no fan-out) — required when 2+ vaults are configured and
`default_vault` isn't set.

### `mnotes logs`

```sh
mnotes logs                                   # every audit.log entry, oldest-first
mnotes logs --source=mcp                      # only Claude's tool calls, not your own CLI mutations
mnotes logs --tool=note_write --outcome=error
mnotes logs --note="Weekly Notes/2026-W32"
mnotes logs --since=1h --json
mnotes logs --follow                          # last 20 matching entries, then streams live
mnotes logs --follow --source=mcp | grep note_write

mnotes logs --file=indexer                    # raw indexer.log lines, no parsing
mnotes logs --file=indexer --follow | grep ERROR
mnotes logs --file=mcp-server --limit=50
mnotes logs --file=daemon.stderr              # the daemon process's own stderr, not logger.js output
```

Filters/tails the audit trail (`audit.log`, [S008](specs/S008-logging.md)) by default — every MCP tool
call and every CLI mutating command (`write`/`edit`/`append`/`rename`/`attachment write`), with `tool`,
`source` (`mcp`/`cli`), `vault` (the vault that call targeted — blank for `list_vaults`, which has no
single vault to name), the note title or attachment path, `query` (the `search` tool's query string,
MCP calls only), `reason` (MCP calls only), and `outcome`. This is CLI-only, like `links`/`vectors` —
there's no MCP equivalent.

**`--vault=<name>` here is a plain equality filter, not the default-vault-fallback resolution every
other command's `--vault` does** — omitted, it shows every vault's entries unfiltered; an unrecognized
name isn't an error, it just matches zero rows; an entry with no `vault` field (e.g. `list_vaults`)
never matches a given `--vault` value.

`--file` selects which log file, one of seven: `audit` (default), `indexer`, `mcp-server` (S008's other
two logger.js-written files — lifecycle/prose text, not structured per-call records), or
`daemon.stdout`/`daemon.stderr`/`logrotate.stdout`/`logrotate.stderr` — the daemon and log-rotator
*processes*' own raw stdout/stderr, redirected there by `launchd`/`systemd` rather than written by
this project's logger, so they can contain anything the process happened to print (a Node warning, an
uncaught exception) rather than a guaranteed line format. They're normally empty; check them first when
a service won't start at all. Unlike the other five files, these two aren't rotated by the log-rotation
service, so they can grow unbounded over a long-lived install.

For every value other than `audit`, `mnotes logs` just prints raw lines (still with `--limit`/`--follow`
support) — no parsing or table formatting. **The audit-specific flags (`--source`, `--tool`, `--note`,
`--outcome`, `--since`, `--json`) only work with `--file=audit`** (the default) — passing any of them
alongside another `--file` is an error naming the flag(s) that don't apply, rather than silently
ignoring them.

Flags: `--file=<name>` (default `audit`), `--source=mcp|cli`, `--tool=<name>`,
`--note=<title>` (exact match against whichever identifier the entry carries — no resolution),
`--outcome=success|error`, `--vault=<name>` (plain equality filter — see above),
`--since=<30m|1h|2d|ISO-8601>`, `--limit=N` (last N matching entries), `--follow`, `--json`.

With no `--limit`, plain `mnotes logs` prints everything matching, oldest-first — no implicit cap.
`--follow` tails like `tail -f` (not `tail -F`: it won't pick a file back up after the log-rotator
service, [S008](specs/S008-logging.md), rotates it away mid-run) and prints the last **20** matching
(or, for a non-`audit` file, available) lines as backlog before switching to live output (`--limit=N`
overrides that backlog size). Because it writes each line to stdout as it arrives rather than buffering
a final result, `--follow` pipes into `grep` (or anything else) as a genuine live filter, on any of the
seven files — end it with Ctrl-C, or just let the downstream command exit and
close the pipe.

### `mnotes vectors <subcommand>`

CLI-only debug/analysis tooling over the raw embedding space — see
[Vector Tools Usage](usage-vectors.md) for every subcommand's flags and examples, and
[S013 — Vector Tools](specs/S013-vector-tools.md) for full behavioral detail. No MCP equivalent (same
rationale as `mnotes links`).

## MCP server (Claude Code / Claude Desktop)

See [MCP Server Usage](usage-mcp.md) for the full tool list, registration steps, and the differences
from the CLI — [S007 — MCP Server](specs/S007-mcp-server.md) for full behavioral detail.
