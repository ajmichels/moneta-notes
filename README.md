# Moneta Notes (mnotes)

A personal notes system built around an Obsidian vault (edited via `obsidian.nvim`, not the Obsidian
app), providing fast full-text and semantic search plus safe, structured note read/write access for
Claude via MCP.

Three components, one shared core library:

1. **Indexing Subsystem** — a background daemon that keeps a SQLite index (FTS5 + sqlite-vec) in
   sync with the vault on disk.
2. **CLI Tools** — terminal commands for manual/debug search and note access, used directly and from
   NeoVim.
3. **MCP Server** — exposes search, read, and write capabilities to Claude Code / Claude Desktop.

The CLI and MCP server are thin wrappers around one shared `core` library. Neither implements
search, hashing, or file I/O logic itself — that guarantees the two surfaces can never drift out of
sync.

Runs on macOS only (Apple Silicon), on either a personal or work machine, never both at once. Each
machine gets its own vault, its own index, and its own config.

---

## Architecture

```
moneta-notes/
├── README.md
├── package.json
├── commitlint.config.js    # configuration for commitlint cli
├── eslint.config.js        # eslint configuration for linting and formatting
├── vitest.config.js        # vitest configuration
├── vitest.setup.js         # code executed before each test execution
├── vitest.helpers.js       # helper functions for unit testing
├── config.example.toml     # documents shape, never the real config
├── docs/                   # for project documentation
├── src/
│   ├── config.js           # loads ~/.config/mnotes/config.toml
│   ├── logger.js           # shared logger
│   ├── log-rotator.js      # shared logging rotation
│   ├── core/
│   │   ├── db.js           # schema, connection, migrations
│   │   ├── db.test.js
│   │   ├── search.js       # fts5 + sqlite-vec + rrf
│   │   ├── search.test.js
│   │   ├── notes.js        # note_read/write/edit/append, hashing
│   │   ├── notes.test.js
│   │   ├── grep.js         # ripgrep wrapper
│   │   ├── grep.test.js
│   │   ├── tags.js
│   │   └── tags.test.js
│   ├── indexer/
│   │   ├── daemon.js       # fswatch loop, calls core/db
│   │   ├── daemon.test.js
│   │   ├── embed.js        # feature-extraction via @huggingface/transformers
│   │   └── embed.test.js
│   ├── cli/
│   │   ├── main.js         # arg parsing, calls core/*
│   │   ├── reindex.js      # `mnotes reindex` — full vault or single note
│   │   ├── stats.js        # `mnotes stats`
│   │   └── *.test.js
│   └── mcp/
│       ├── server.js       # server bootstrap, @modelcontextprotocol/sdk
│       ├── server.test.js
│       ├── tools.js        # tool defs
│       ├── tools.test.js
│       ├── prompts.js      # prompt defs
│       └── prompts.test.js
├── launchd/
│   └── com.ajmichels.mnotes.plist.template
└── scripts/
    ├── install.sh          # renders plist template, installs via launchctl
    └── uninstall.sh        # disables via launchctl, removes plist file
```

Test files live next to the code they test (`src/core/search.js` / `src/core/search.test.js`), not
in a separate `test/` tree.

`core/` has zero knowledge of CLI flags or MCP tool schemas — it takes plain arguments and returns
plain data. `cli/main.js` and `mcp/server.js` each do their own argument parsing / protocol plumbing
and then call the same functions underneath.

Plain JS, no build step — `node src/indexer/daemon.js` runs directly, no `tsc`, no `dist/`.

---

## Indexing Subsystem

- **Storage**: SQLite. FTS5 (external content table — index only, no duplicated note content) for
  full-text; sqlite-vec for embeddings.
- **Change detection**: `launchd` keeps a background process alive; `fswatch` watches the vault
  directory for file changes and triggers re-indexing. This is deliberately editor/tool-agnostic — a
  manual edit in NeoVim, an MCP `note_write`, or a `git` version restore all end up as a file-change
  event, so the index is always eventually consistent regardless of what touched the file.
- **Merging strategy**: Reciprocal Rank Fusion (RRF, k=60) combines full-text and semantic rankings
  for hybrid search.
- **Embeddings**: `Qwen3-Embedding-0.6B` (Apache 2.0, code-aware, Matryoshka/MRL support), run
  in-process entirely in Node via **`@huggingface/transformers`** (Transformers.js), using the
  `onnx-community/Qwen3-Embedding-0.6B-ONNX` build. No Python anywhere in this repo —
  `src/indexer/embed.js` runs the `feature-extraction` pipeline directly.
- **Reindexing**: covered by the `mnotes reindex` CLI command (see below), supported from the start
  to handle future embedding model swaps. The index stores the embedding model name/version alongside
  vectors so a mismatch is detectable rather than silent.

## CLI Tools

Exposes the same underlying functionality as the MCP server, with additional flags for debugging
(e.g. raw score inspection, `--explain` on search). Used both interactively in the terminal and from
NeoVim via `obsidian.nvim`.

Beyond thin wrappers around the MCP tool set, a couple of CLI-only commands:

- **`mnotes reindex [note_title]`** — rebuilds the index. With no argument, walks the entire vault;
  with a note title, reindexes just that note. Idempotent either way — running it twice in a row with
  no intervening file changes produces the same index state, so it's safe to run ad hoc for debugging
  or after a bulk file operation (e.g. a git restore) without worrying about double-counting or
  corrupting the FTS5/vector tables.
- **`mnotes stats`** — reports on both the vault and the index: note count, tag count, total/average
  note length, embedding model name and version currently indexed against, count of notes pending
  re-embedding (if any), index file size, and last reindex time. Useful as a sanity check that the
  daemon is keeping up and that the index actually reflects the vault.

## MCP Server

### Design principles behind the tool set

- **Note title, not file path, is the identifier** across every tool. Obsidian wikilink conventions
  (Title Case, folder paths encoded directly in the title, e.g. `Weekly Notes/2026-W32`) mean Claude
  never has to reason about the filesystem.
- **Content hash is the concurrency guard.** Every mutating tool that touches an existing note
  requires `hash` to match the note's current content hash. No hash + new title = create. No hash +
  existing title = error, directing Claude to read first. Hash mismatch = staleness error. This is a
  deliberate divergence from Claude's native file-editing tools (which assume nothing else touches the
  file mid-session) and is *not* something to normalize away — notes can and do change outside the
  conversation.
- **Metadata (frontmatter) is structured, never raw YAML.** Reads return a parsed `metadata` object;
  writes accept one. Claude never hand-edits YAML frontmatter as text.
- **Fewer tools, parameter-based modes.** `search` takes a `mode` (`fulltext` | `semantic` |
  `hybrid`, default `hybrid`) rather than three separate tools. `grep` stays separate since it
  operates on raw files via ripgrep, not the index, and doesn't produce comparable rank scores.
- **Unsafe operations fail loudly.** No silent partial writes, no silent overwrite of a stale note,
  no silent truncation.
- **No MCP resources.** The marginal convenience of `@`-mention autocomplete didn't justify a second
  code path for hashing/locking/errors alongside the tool-based one. Revisit only if that calculus
  changes.
- **Rank position, not raw scores, in output.** RRF/BM25/cosine scores aren't shown to Claude —
  they're not corpus-normalized and aren't independently interpretable. Rank position (`semantic #1,
  keyword #5`) is.
- **Response format**: pipe-delimited columnar plain text for list-style results (search, grep, tag
  listings) — token-efficient and self-documenting via header row. Structured JSON for `note_read` and
  write responses, since note content is unconstrained text that could collide with any plain-text
  delimiter scheme.
- **No inline line-number prefixes in returned note content** — real risk of Claude writing the
  prefixes back into the file on a subsequent write.
- **Every tool requires a `reason<string>` argument**, mirroring the `description` field on Claude
  Code's native tools (`view`, `create_file`, `str_replace`). Purpose is a pre-action justification:
  it's logged (see [Logging](#logging--log-rotation)) for an audit trail of what Claude did and why,
  and may double as a source for gitwatch-adjacent commit context later. Not currently used to gate or
  alter behavior — just recorded.

### Tools

#### `search`

Searches notes using full-text, semantic, or hybrid (RRF-merged) ranking.

**Input**: `query<string>`, `?mode<fulltext|semantic|hybrid>=hybrid`, `reason<string>`

**Output**: `note_title<string>`, `file_line_count<int>`, `?fulltext_rank<null|int>`, `?semantic_rank<null|int>`

```
Note Title | File Line Count
----
API Migration | 42
GraphQL Notes | 76
Weekly Notes/2026-W32 | 132
```

```
Note Title | File Line Count | Full-text Rank | Semantic Rank
----
API Migration | 42 | 1 | 3
GraphQL Notes | 76 | — | 1
Weekly Notes/2026-W32 | 132 | 2 | 2
```

#### `grep`

Uses ripgrep to search raw note files for a pattern.

**Input**: `pattern<string>`, `?regex<bool>=false`, `?note_title<string>`, `reason<string>`

**Output**: `note_title<string>`, `file_line_count<int>`, `line_matches<list>`

```
Note Title | File Line Count | Lines with Match
----
API Migration | 42 | 2, 5, 8
GraphQL Notes | 76 | 3
Weekly Notes/2026-W32 | 132 | 3, 6, 8, 23, 25, 67, 75, 82, 83, 91 (+ 5 more)
```

#### `tag_list`

Lists all tags in use across the vault.

**Input**: `reason<string>`

**Output**: `tag<string>`, `notes_with_tag<int>`

```
Tag | Notes with Tag
----
bar | 4
foo | 12
```

#### `tag_notes`

Lists all notes carrying a given tag.

**Input**: `tag<string>`, `reason<string>`

**Output**: `note_title<string>`, `file_line_count<int>`

```
Note Title | File Line Count
----
API Migration | 42
GraphQL Notes | 76
Weekly Notes/2026-W32 | 132
```

#### `note_read`

Fetches a note's metadata and content. Supports optional `start_line`/`end_line` for partial reads.

**Input**: `note_title<string>`, `?start_line<int>`, `?end_line<int>`, `reason<string>`

**Output**:

```json
{
  "title": "API Migration",
  "start_line": 1,
  "end_line": 42,
  "total_lines": 42,
  "content_hash": "d64053d34ce12695ffde5f8f5a1571c55ed527b2",
  "metadata": {
    "tags": ["project/api-migration"]
  },
  "content": "# API Migration\n..."
}
```

#### `note_write`

Creates a note, or replaces the full contents of an existing one. No `hash` = create. Modifying an
existing note requires `hash` matching the note's current content hash.

**Input**: `note_title<string>`, `hash<null|string>`, `?metadata<json>`, `content<string>`, `reason<string>`

Rejects writes that drop below ~50% of the prior line count unless `force: true` is explicitly
passed (size-drop guard against accidental content collapse). This is a preventive check, not an
exhaustive one — `gitwatch` is the real recovery backstop (see [Versioning](#versioning)).

#### `note_edit`

Surgical modification of an existing note: replaces `old_txt` with `new_txt`. Modeled on Claude
Code's `str_replace` tool, with `expected_hash` added as a safety layer the native tool doesn't have
(since notes can change outside the session). Fails if `old_txt` doesn't match exactly once.

**Input**: `note_title<string>`, `hash<null|string>`, `old_txt<string>`, `new_txt<string>`, `reason<string>`

#### `note_append`

Adds content to the end of a note.

**Input**: `note_title<string>`, `content<string>`, `reason<string>`

---

## Versioning

`gitwatch` runs as a separate process, watching the vault directory and auto-committing on file
change (debounced via `-s`) — this covers manual edits, MCP writes, and anything else that touches
the files, with zero manual commit steps. It also pushes to a local bare repository, which is in
turn backed up to a OneDrive-synced location.

Two important separations here:

- **`.git` internals never live inside a OneDrive-synced folder.** Rapid small writes to
  `.git/index` and object files are exactly the kind of mid-write state a sync client can corrupt. The
  live repo stays fully local; only a **bare** repo (packfiles, no working tree, no lock-file churn)
  sits in OneDrive as the offsite copy.
- **This versioning setup is for the *notes vault*, not for this code repository.** `moneta-notes`
  itself (this repo) is developed and committed normally by hand — `gitwatch` is never pointed at it.

Because `gitwatch` is the recovery backstop for the vault, the write-safety guards in
`note_write`/`note_edit` (hash checks, size-drop guard) are meant to be *preventive*, not exhaustive
— they don't need to catch every possible bad write, since any of them are recoverable from git
history.

## Configuration & portability

Config lives outside the repo, in the OS-conventional per-machine location, so the same repo works
unmodified on both a personal and a work machine:

```
~/.config/mnotes/config.toml
```

```toml
vault_path = "/Users/aj/Documents/Notes"
db_path = "/Users/aj/Library/Application Support/mnotes/index.db"
embedding_model = "Qwen3-Embedding-0.6B"
```

The repo ships `config.example.toml` as documentation only. The real file is written by hand once
per machine and never committed.

The index database lives outside both the repo and the vault (e.g. `~/Library/Application
Support/mnotes/`) — never inside a git working tree, and never inside a sync-watched folder (a
WAL-mode SQLite file in a synced directory is a corruption risk for the same reason a live `.git`
directory is).

## Vault conventions

- Edited via `obsidian.nvim`, not the Obsidian app.
- Note titles follow Obsidian wikilink conventions: Title Case, folder paths encoded directly in the
  title (e.g. `Weekly Notes/2026-W32`).
- Moving toward a flat structure: root-level notes, plus dedicated `Weekly Notes/` and
  `Daily Notes/` subdirectories — no other nesting.

## Logging & log rotation

*Proposed — not yet locked in, flag if any of this doesn't fit.*

Three long-lived-ish processes need logs: the indexing daemon (`launchd`-managed, runs
indefinitely), the MCP server (runs per Claude session), and tool-call activity from the `reason`
argument on every MCP tool.

- **Location**: `~/Library/Logs/com.ajmichels.mnotes/`, matching macOS convention (visible in Console.app,
  not buried in `~/.config`).
- **Separate files per component**: `indexer.log`, `mcp-server.log`. CLI invocations are interactive
  and don't need persistent logging beyond stdout/stderr, unless a specific need shows up (e.g. `mnotes
  reindex` run headless from `launchd`).
- **Tool-call audit trail**: every MCP tool call logs `{ tool, note_title, reason, timestamp,
  outcome }` — success/failure, not full content — to `mcp-server.log` (or a dedicated
  `tool-calls.log` if that gets noisy enough to want separated).
- **Rotation**: size- and age-based (e.g. 10MB or 7 days, whichever first, keep last 5). A small
  dependency like `pino` (with `pino/file` + `logrotate`-style rolling) or `rotating-file-stream`
  covers this without hand-rolling rotation logic. Given the "plain JS, minimal dependencies" bias
  elsewhere in this project, a lightweight logger without a heavier framework (e.g. `pino` alone, no
  `pino-pretty` in production) is a reasonable default — worth confirming preference before locking
  in.
- **Level**: `info` for tool calls and daemon lifecycle events (started, reindex triggered, reindex
  completed), `warn`/`error` for anything a size-drop guard, hash mismatch, or embedding failure
  trips. Avoid `debug`-level logging of note content itself, to keep logs from becoming a second,
  unmanaged copy of vault data.

## Install/Uninstall

### Installation

- Prompt user for configuration values (with defaults)
- Create Configuration directory and config file from user responses (`~/.config/mnotes/config.toml`)
- Create Application Support directory (`~/Library/Application Support/mnotes`)
- Create Logs directory (`~/Library/Logs/com.ajmichels.mnotes`)
- Create Property List file (`~/Library/LaunchAgents/com.ajmichels.mnotes.plist`)
- Bootstrap `launchd` process (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ajmichels.mnotes.plist`)

### Uninstallation

- Bootstrap `launchd` process (`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ajmichels.mnotes.plist`)
- Delete Property List file (`~/Library/LaunchAgents/com.ajmichels.mnotes.plist`)
- Delete Logs directory (`~/Library/Logs/com.ajmichels.mnotes`)
- Delete Application Support directory (`~/Library/Application Support/mnotes`)
- Delete Configuration directory (`~/.config/mnotes/`)

## Tech stack

| Concern            | Choice |
|--------------------|--------|
| Language           | Node.js, plain JavaScript (no TypeScript) — no Python anywhere in this repo |
| Search index       | SQLite — FTS5 (BM25) + sqlite-vec |
| Hybrid ranking     | Reciprocal Rank Fusion, k=60 |
| Embeddings         | Qwen3-Embedding-0.6B via `@huggingface/transformers` (ONNX, in-process Node) |
| File watching      | fswatch |
| Process management | launchd |
| Grep               | ripgrep |
| Versioning         | gitwatch (vault only, not this repo) |
| Testing            | Vitest, colocated `*.test.js` files |
| Linting            | ESLint |
| Logging            | proposed: pino or similar, size/age-based rotation |

## Status

**Decided**: tool set and schemas above (including `reason` on every tool), storage/search stack,
embedding model and runtime (all-Node via Transformers.js), versioning approach, config/portability
strategy, response formats, `reindex`/`stats` CLI commands, colocated test file convention.

**Open / in progress**:
- Indexing daemon implementation (fswatch loop, embedding pipeline wiring)
- `launchd` plist templating and `scripts/install.sh`
- Logging/rotation implementation details (proposal above needs sign-off)
- MCP prompts: candidates identified (weekly review automation, note triage, stale note detection,
  weekly note scaffolding, orphan note identification) but not yet implemented — these are
  user-triggered (slash commands), architecturally distinct from the tools above
