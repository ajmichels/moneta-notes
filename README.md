# Moneta Notes (mnotes)

A personal notes system built around an Obsidian vault, providing fast full-text and semantic search
plus safe, structured note read/write access for Claude via MCP.

Three components, one shared core library:

1. **Indexing Subsystem** — a background daemon that keeps a SQLite index (FTS5 + sqlite-vec) in
   sync with the vault on disk.
2. **CLI Tools** — terminal commands for manual/debug search and note access, used directly and from
   NeoVim.
3. **MCP Server** — exposes search, read, and write capabilities to Claude Code / Claude Desktop.

The CLI and MCP server are thin wrappers around one shared `core` library. Neither implements
search, hashing, or file I/O logic itself — that guarantees the two surfaces can never drift out of
sync.

Runs on macOS or Linux, on either a personal or work machine, never both at once. Each machine gets its
own vault, its own index, and its own config.

This file is a maintainer-facing overview — architecture, tech stack, dev conventions. **Detailed,
binding functional specs live in `docs/specs/`** and are the actual source of truth for what this
project does; if anything here conflicts with a spec, the spec wins.

---

## Name

*Moneta* was an epithet of the Roman goddess Juno — Juno Moneta, "Juno who warns/reminds," from the
Latin verb *monere* (to remind, to warn, to advise). Her temple on the Capitoline Hill also housed
Rome's mint, which is why *moneta* is the root of "money" and "mint" in English and the Romance
languages. The reminding/advising sense is the one that gave this project its name.

---

## Documentation

| Guide | Covers |
|---|---|
| [Installation](docs/installation.md) | Prerequisites, running `scripts/install.sh`, what it creates, verifying the install |
| [Configuration](docs/configuration.md) | Every `config.toml` option: what it does, its default |
| [Usage](docs/usage.md) | The full `mnotes` CLI command reference plus the MCP tool surface |
| [Process Management](docs/process-management.md) | Starting/stopping/restarting the indexing daemon, log locations, troubleshooting |
| [Uninstallation](docs/uninstallation.md) | Running `scripts/uninstall.sh`, what it removes, what it leaves alone |

---

## Prerequisites

Runs on **macOS or Linux**. Required: Node.js, pnpm. Strongly recommended: ripgrep, fswatch (on macOS,
also Xcode Command Line Tools). Optional: the Claude Code CLI, for automatic MCP registration.
See [Installation](docs/installation.md#prerequisites) for what each is for, what's macOS-only, and
what happens if something's missing.

---

## License & Contributing

Licensed under [Apache-2.0](LICENSE). Contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for signed-commit and DCO sign-off requirements, and
[Architecture § Development](docs/architecture.md#development) for running tests/lint and what the
Husky hooks enforce.

---

## Specs

| Spec | Covers |
|---|---|
| [S001 — Data Model](docs/specs/S001-data-model.md) | SQLite schema: notes, FTS5, chunks/vectors, tags, links, index queue, migrations |
| [S002 — Search](docs/specs/S002-search.md) | Fulltext/semantic/hybrid ranking, RRF merge, chunk collapse |
| [S003 — Notes](docs/specs/S003-notes.md) | Note CRUD, hashing, frontmatter/metadata, the `id`/`created` fields, rename (incl. link cascade), backlinks |
| [S004 — Grep & Tags](docs/specs/S004-grep-tags.md) | Ripgrep wrapper, tag extraction and listing |
| [S005 — Indexing Daemon](docs/specs/S005-indexing-daemon.md) | fswatch loop, embedding pipeline, queue/retry, daemon↔CLI IPC |
| [S006 — CLI](docs/specs/S006-cli.md) | `mnotes` command surface and output formats |
| [S007 — MCP Server](docs/specs/S007-mcp-server.md) | Tool schemas, transport, error mapping |
| [S008 — Logging](docs/specs/S008-logging.md) | Logger, rotation, audit trail |
| [S009 — Config & Install](docs/specs/S009-config-and-install.md) | `config.toml` schema, install/uninstall, launchd |
| [S010 — Shared Utilities](docs/specs/S010-shared-utilities.md) | Title↔path conversion, line counting, code-region stripping |
| [S011 — Links](docs/specs/S011-links.md) | Wikilink extraction, backlinks, rename link-cascade, broken-link detection |
| [S012 — Attachments](docs/specs/S012-attachments.md) | Reading/writing binary vault files (images, PDFs) by vault-relative path, unindexed |
| [S013 — Vector Tools](docs/specs/S013-vector-tools.md) | `mnotes vectors` namespace: compare/nearest/cluster/reduce/tag-fit/tag-redundancy/outliers/calibrate over the embedding space |
| [S014 — Metadata Search](docs/specs/S014-metadata-search.md) | Frontmatter field filtering (`metadata_keys`/`metadata_query`), JSON1 storage, tag interception |

Specs are numbered (`S001`, `S002`, ...) and named with a short kebab-case topic. A spec may amend an
earlier one (noted at the top of the file) as later design work surfaces a gap — e.g. S004 amends
S001's `tags` table collation, S005 amends S001 with the `index_queue` table.

**Not yet speced**: MCP prompts (weekly review automation, note triage, stale/orphan note detection,
weekly note scaffolding — candidates named below, design deferred to a future spec once the core tool
set is built and in use).

---

## Architecture

Three components share one `core/` library — `cli/` and `mcp/` are thin wrappers that do their own
argument parsing / protocol plumbing and then call the same functions underneath, so the two surfaces
can never drift out of sync. Plain JS, no build step.

See [Architecture](docs/architecture.md) for the full directory layout and tech stack table.

---

## Note Versioning

Version-controlling the notes vault (as distinct from this code repository) is out of scope for
`mnotes` itself, but strongly recommended — `note_write`/`note_edit`'s write-safety guards are
preventive, not a substitute for being able to recover a prior version of a note. See
[Note Versioning](docs/note-versioning.md) for a recommended, low-effort setup.

## Status

**Fully speced** (see `docs/specs/`): data model, search, notes, grep/tags, indexing daemon, CLI, MCP
server, logging, config & install, links, attachments, vector tools, metadata search.

**Not yet speced**: MCP prompts (weekly review automation, note triage, stale note detection, weekly
note scaffolding, orphan note identification) — candidates identified, design deferred until the core
tool set above is built and in use.

**Not yet implemented**: everything — specs are complete, implementation hasn't started.
