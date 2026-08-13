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

This file is a maintainer-facing overview — architecture, tech stack, dev conventions. **Detailed,
binding functional specs live in `docs/specs/`** and are the actual source of truth for what this
project does; if anything here conflicts with a spec, the spec wins.

---

## Documentation

| Guide | Covers |
|---|---|
| [Installation](docs/installation.md) | Prerequisites, running `scripts/install.sh`, what it creates, verifying the install |
| [Usage](docs/usage.md) | The full `mnotes` CLI command reference plus the MCP tool surface |
| [Process Management](docs/process-management.md) | Starting/stopping/restarting the indexing daemon, log locations, troubleshooting |
| [Uninstallation](docs/uninstallation.md) | Running `scripts/uninstall.sh`, what it removes, what it leaves alone |

---

## Specs

| Spec | Covers |
|---|---|
| [S001 — Data Model](docs/specs/S001-data-model.md) | SQLite schema: notes, FTS5, chunks/vectors, tags, index queue, migrations |
| [S002 — Search](docs/specs/S002-search.md) | Fulltext/semantic/hybrid ranking, RRF merge, chunk collapse |
| [S003 — Notes](docs/specs/S003-notes.md) | Note CRUD, hashing, frontmatter/metadata, the `id` field, rename |
| [S004 — Grep & Tags](docs/specs/S004-grep-tags.md) | Ripgrep wrapper, tag extraction and listing |
| [S005 — Indexing Daemon](docs/specs/S005-indexing-daemon.md) | fswatch loop, embedding pipeline, queue/retry, daemon↔CLI IPC |
| [S006 — CLI](docs/specs/S006-cli.md) | `mnotes` command surface and output formats |
| [S007 — MCP Server](docs/specs/S007-mcp-server.md) | Tool schemas, transport, error mapping |
| [S008 — Logging](docs/specs/S008-logging.md) | Logger, rotation, audit trail |
| [S009 — Config & Install](docs/specs/S009-config-and-install.md) | `config.toml` schema, install/uninstall, launchd |

Specs are numbered (`S001`, `S002`, ...) and named with a short kebab-case topic. A spec may amend an
earlier one (noted at the top of the file) as later design work surfaces a gap — e.g. S004 amends
S001's `tags` table collation, S005 amends S001 with the `index_queue` table.

**Not yet speced**: MCP prompts (weekly review automation, note triage, stale/orphan note detection,
weekly note scaffolding — candidates named below, design deferred to a future spec once the core tool
set is built and in use).

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
├── docs/
│   └── specs/              # binding functional specs — see table above
├── src/
│   ├── config.js           # loads ~/.config/mnotes/config.toml — S009
│   ├── logger.js           # shared logger — S008
│   ├── log-rotator.js      # log rotation, run by its own LaunchAgent — S008
│   ├── core/
│   │   ├── db.js           # schema, connection, migrations — S001
│   │   ├── db.test.js
│   │   ├── search.js       # fts5 + sqlite-vec + rrf — S002
│   │   ├── search.test.js
│   │   ├── notes.js        # note_read/write/edit/append/rename, hashing — S003
│   │   ├── notes.test.js
│   │   ├── grep.js         # ripgrep wrapper — S004
│   │   ├── grep.test.js
│   │   ├── tags.js         # extraction + tag_list/tag_notes — S004
│   │   └── tags.test.js
│   ├── indexer/
│   │   ├── daemon.js       # fswatch loop, queue drainer, IPC socket — S005
│   │   ├── daemon.test.js
│   │   ├── embed.js        # feature-extraction via @huggingface/transformers — S005
│   │   └── embed.test.js
│   ├── cli/
│   │   ├── main.js         # arg parsing, calls core/* — S006
│   │   ├── reindex.js      # `mnotes reindex` — S005/S006
│   │   ├── daemon.js       # `mnotes daemon start|stop|restart` — S005/S006
│   │   ├── stats.js        # `mnotes stats` — S006
│   │   └── *.test.js
│   └── mcp/
│       ├── server.js       # server bootstrap, @modelcontextprotocol/sdk — S007
│       ├── server.test.js
│       ├── tools.js        # tool defs — S007
│       ├── tools.test.js
│       ├── prompts.js      # stub — prompts not yet speced
│       └── prompts.test.js
├── launchd/
│   ├── *.plist.template    # daemon + log-rotation agent templates — S009
│   ├── launcher.c          # native launcher, gives each agent its own BTM identity — S009
│   └── Info.plist          # launcher .app bundle metadata — S009
└── scripts/
    ├── install.sh          # S009
    └── uninstall.sh        # S009
```

Test files live next to the code they test (`src/core/search.js` / `src/core/search.test.js`), not
in a separate `test/` tree.

`core/` has zero knowledge of CLI flags or MCP tool schemas — it takes plain arguments and returns
plain data. `cli/main.js` and `mcp/server.js` each do their own argument parsing / protocol plumbing
and then call the same functions underneath.

Plain JS, no build step — `node src/indexer/daemon.js` runs directly, no `tsc`, no `dist/`.

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

Because `gitwatch` is the recovery backstop for the vault, the write-safety guards in `note_write`/
`note_edit` (hash checks, size-drop guard — [S003](docs/specs/S003-notes.md)) are meant to be
*preventive*, not exhaustive — they don't need to catch every possible bad write, since any of them
are recoverable from git history.

## Vault conventions

- Edited via `obsidian.nvim`, not the Obsidian app.
- Note titles follow Obsidian wikilink conventions: Title Case, folder paths encoded directly in the
  title (e.g. `Weekly Notes/2026-W32`).
- Moving toward a flat structure: root-level notes, plus dedicated `Weekly Notes/` and
  `Daily Notes/` subdirectories — no other nesting (not tool-enforced; see
  [S003](docs/specs/S003-notes.md)).
- Every note carries a system-managed `id` frontmatter field (matches `obsidian.nvim`'s own
  convention) — see [S003](docs/specs/S003-notes.md).

## Tech stack

| Concern            | Choice |
|--------------------|--------|
| Language           | Node.js, plain JavaScript (no TypeScript) — no Python anywhere in this repo |
| Search index       | SQLite — FTS5 (BM25, contentless) + sqlite-vec |
| Hybrid ranking     | Reciprocal Rank Fusion, k=60 (config-backed) |
| Embeddings         | Qwen3-Embedding-0.6B via `@huggingface/transformers` (ONNX, q8, in-process Node) |
| Chunking           | Token-based, ~512 tokens / ~15% overlap |
| File watching      | fswatch, unified per-path debounce |
| Indexing queue     | SQLite-backed (`index_queue`), retry with backoff |
| CLI↔daemon IPC     | Unix domain socket |
| Process management | launchd (indexing daemon + log-rotation agent) |
| Grep               | ripgrep (system-installed) |
| Logging            | pino (structured JSON), rotation via a dedicated LaunchAgent |
| Versioning         | gitwatch (vault only, not this repo) |
| CLI parsing        | Node's built-in `util.parseArgs` |
| Testing            | Vitest, colocated `*.test.js` files |
| Linting            | ESLint |

## Status

**Fully speced** (see `docs/specs/`): data model, search, notes, grep/tags, indexing daemon, CLI, MCP
server, logging, config & install.

**Not yet speced**: MCP prompts (weekly review automation, note triage, stale note detection, weekly
note scaffolding, orphan note identification) — candidates identified, design deferred until the core
tool set above is built and in use.

**Not yet implemented**: everything — specs are complete, implementation hasn't started.
