# Usage

Two ways to use `mnotes`: the **CLI** (terminal, `obsidian.nvim` integration) and the **MCP server**
(Claude Code / Claude Desktop). Both are thin wrappers around the same `core/` library, so behavior is
identical between them wherever a feature exists on both surfaces — see
[S006 — CLI](specs/S006-cli.md) and [S007 — MCP Server](specs/S007-mcp-server.md) for full detail.

Run `mnotes --help` or `mnotes <command> --help` any time for the in-tool version of this reference.

## Output formats

List-style commands (`search`, `grep`, `tags list`, `tags notes`) print pipe-delimited columnar text by
default, with a `--json` flag for scripting or `obsidian.nvim` integration. Mutating commands
(`write`/`edit`/`append`/`rename`) are always structured JSON (`{ title, hash, line_count }`) — `--json`
is a no-op for those.

`mnotes read` is the one exception: its default output is the raw note body (not JSON), so it pipes
naturally into `$EDITOR`, `less`, etc. See the table under [`mnotes read`](#mnotes-read-title) below.

Raw relevance scores (BM25, cosine distance, RRF) are never shown in normal output — only rank
position. Use `--explain` on `search` if you need the underlying numbers for debugging.

## Commands

### `mnotes search <query>`

```sh
mnotes search "obsidian sync conflict"
mnotes search "vector search" --mode=semantic --limit=5
mnotes search "index_queue retry" --explain
```

Flags: `--mode=hybrid|fulltext|semantic` (default `hybrid`), `--limit=N`, `--explain`, `--json`.

`--explain` is CLI-only debug output — shows raw BM25 score, raw cosine distance, which chunk won the
best-chunk-wins collapse, the RRF score with its formula breakdown, and how many chunks/notes were
over-fetched before truncating to `--limit`. Useful for "why didn't note X show up" debugging; never
exposed through MCP.

### `mnotes grep <pattern>`

```sh
mnotes grep "TODO"
mnotes grep '^\s*- \[ \]' --regex
mnotes grep "deadline" --note="Weekly Notes/2026-W32" --content
```

Flags: `--regex`, `--note=<title>` (restrict to one note), `--content` (show matched line text inline —
CLI-only; the MCP tool always omits it for context-budget reasons), `--json`.

### `mnotes tags list` / `mnotes tags notes <tag>`

```sh
mnotes tags list
mnotes tags notes "project/moneta-notes"
```

Flag: `--json`.

### `mnotes read <title>`

```sh
mnotes read "Weekly Notes/2026-W32"
mnotes read "Weekly Notes/2026-W32" --start=10 --end=40
mnotes read "Weekly Notes/2026-W32" --raw > backup.md
mnotes read "Weekly Notes/2026-W32" --json | jq -r .content_hash
```

| Mode | stdout | stderr |
|---|---|---|
| default | Note body only, frontmatter stripped | Parsed `metadata` object, as JSON |
| `--raw` | Exact file bytes as stored (frontmatter included), unmodified | Nothing |
| `--json` | Full structured JSON (`title`, `content_hash`, `metadata`, `content`, line info) | Nothing |

Use `--json` (or read `content_hash` from `mnotes write`/`edit`'s own output) any time you need the
hash for a follow-up `write`/`edit`/`rename` call — see the next section.

### `mnotes write <title>`, `mnotes edit <title>`, `mnotes append <title>`, `mnotes rename <old> <new>`

**Every mutating call on an existing note requires a matching content hash** — read the note first
(`mnotes read <title> --json`) to get its current `content_hash`, then pass it as `--hash`. A missing
hash against an existing title is a hard error, not a silent overwrite — this is deliberate (see
CLAUDE.md's architecture rules): notes can change outside of any given session, so the hash check
protects against clobbering someone else's concurrent edit. Creating a **new** note (no existing title)
doesn't need a hash.

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

`write` and `append` read content from **stdin** if `--content` is omitted — works naturally with
`$EDITOR`-produced files, heredocs, or piped command output:

```sh
cat draft.md | mnotes write "Weekly Notes/2026-W33" --hash="$hash"
```

`edit`'s `--old`/`--new` are always flags (not stdin-eligible — a single stdin stream can't carry two
separate values). All four accept `--metadata='{...}'` to set structured frontmatter (never raw YAML
string manipulation).

These commands are logged to `audit.log` (`source: cli`, no `reason` — see
[Process Management](process-management.md#logs)) but don't wait for reindexing to complete; the
daemon's `fswatch` loop picks up the change asynchronously. Use `mnotes reindex <title>` if you need to
block until a specific note is reindexed.

### `mnotes reindex [title]`

```sh
mnotes reindex                              # full reindex
mnotes reindex "Weekly Notes/2026-W32"      # single note, streams attempt/retry progress
```

Talks to the *running* daemon over its Unix socket — hard error ("could not connect to the daemon") if
the daemon isn't up. Idempotent: running it twice with no intervening vault changes leaves the index in
the same state both times. See [Process Management](process-management.md) if this fails.

### `mnotes daemon <start|stop|restart>`

Controls the daemon process itself via `launchctl`, distinct from `reindex` above. Full detail in
[Process Management](process-management.md#mnotes-daemon-startstoprestart).

### `mnotes stats`

```sh
mnotes stats
mnotes stats --json
```

Note/tag counts, total/average note length, embedding model + version, count of notes pending
re-embedding, index file size, last full reindex time, daemon status, and current queue depth. Pure DB
reads plus a best-effort socket probe — never itself requires the daemon to be running.

## MCP server (Claude Code / Claude Desktop)

Once registered (`claude mcp add mnotes ...` — done automatically by
[`scripts/install.sh`](installation.md) if `claude` is on `PATH`), the following tools are available to
Claude in any session:

`search`, `grep`, `tag_list`, `tag_notes`, `note_read`, `note_write`, `note_edit`, `note_append`,
`note_rename`

These map directly onto the CLI commands above (`note_read` ↔ `mnotes read`, etc.) and share the same
`core/` logic — same hashing rules, same size-drop guard, same "no raw scores" output. Two differences
from the CLI:

- Every tool requires a **`reason<string>`** argument, logged for audit purposes (mirroring
  `description` on Claude Code's native file tools) — the CLI has no equivalent since a human typing
  the command *is* the reason.
- `--explain`, `--raw`, and `grep`'s `--content` (all CLI debug/ergonomics flags) have no MCP
  equivalent.

Check `claude mcp list` to confirm registration, and `mcp-server.log` /
[`audit.log`](process-management.md#logs) if a tool call isn't behaving as expected.
