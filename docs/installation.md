# Installation

Covers `scripts/install.sh` end to end: prerequisites, what it prompts for, what it creates on disk,
and how to verify it worked. The authoritative spec for this behavior is
[S009 — Config & Install](specs/S009-config-and-install.md); this page is the practical walkthrough.

## Prerequisites

Runs on **macOS only (Apple Silicon)** — see [README](../README.md).

Required:

- **Node.js** — the runtime everything executes under.
- **pnpm** — dependency install and the global `pnpm link` step that puts `mnotes` on `PATH`.

Strongly recommended, checked by the installer (warns and continues if missing, doesn't block):

- **[ripgrep](https://github.com/BurntSushi/ripgrep)** (`brew install ripgrep`) — powers `mnotes grep`.
  Without it, every other command still works.
- **fswatch** (`brew install fswatch`) — the indexing daemon's file-watching backend. Without it, the
  daemon will crash-loop under `launchd`.
- **Xcode Command Line Tools** (`xcode-select --install`, gives you `clang`) — used to compile a small
  native launcher so the two background LaunchAgents show up in macOS's Background Task Management UI
  as "Moneta Notes" rather than "Node.js Foundation". Without it, install falls back to a plain shell
  wrapper — everything still works, just with the generic Node identity.

Optional:

- **[Claude Code CLI](https://claude.com/claude-code)** (`claude`) — if present, install registers the
  MCP server automatically. If absent, install prints the manual `claude mcp add` command to run later.

## Running the installer

```sh
git clone <this repo>
cd moneta-notes
pnpm install
./scripts/install.sh
```

`pnpm install` (plain dependency install) is a separate, ordinary step — `install.sh` assumes it's
already been run and doesn't do it for you.

You'll be prompted for two paths, each with a sensible default (press Enter to accept):

```
Vault path [~/Documents/Notes]:
Index DB path [~/Library/Application Support/mnotes/index.db]:
```

Both prompts support `~`-relative paths, relative paths, arrow-key editing, and Tab-completion.
Whatever you type is resolved to an absolute path before use.

## What the installer does

In order:

1. **Preflight checks** — warns (doesn't block) if `rg` or `fswatch` are missing.
2. **Prompts** for vault path and DB path (above).
3. **Writes `~/.config/mnotes/config.toml`** — but only if it doesn't already exist, and only if at
   least one answer differs from its suggested default. If you accept both defaults, **no file is
   written at all** — every value already has a built-in default in `src/config.js`, and the file only
   ever contains genuinely-overridden keys. See [config.example.toml](../config.example.toml) for the
   full schema and every tunable that can go in this file. An existing `config.toml` (e.g. re-running
   install after an upgrade) is always left untouched.
4. **Creates `~/Library/Application Support/mnotes/`** — holds the SQLite index (`index.db`, schema
   created by the daemon on first run, not by this script) and the daemon's Unix socket
   (`daemon.sock`).
5. **Creates `~/Library/Logs/com.ajmichels.mnotes/`** — see [Process Management](process-management.md#logs)
   for what lands here.
6. **Builds a native launcher app bundle** (`MonetaNotes.app`) if `clang` is available, so the two
   LaunchAgents below are correctly attributed in macOS's Background Task Management UI. Falls back to
   a plain wrapper script if not.
7. **Writes both LaunchAgent property lists** to `~/Library/LaunchAgents/`:
   `com.ajmichels.mnotes.plist` (the indexing daemon) and `com.ajmichels.mnotes.logrotate.plist` (log
   rotation, runs on a schedule — see [S008](specs/S008-logging.md)).
8. **Bootstraps both launchd jobs** (`launchctl bootstrap gui/<uid> <plist>`) — both start running
   immediately.
9. **Pre-downloads the embedding model** (`Qwen3-Embedding-0.6B`, quantized) — a one-time download via
   `@huggingface/transformers`, printed as "downloading embedding model, this may take a minute...".
   Doing this at install time means the first real note write doesn't stall on a surprise multi-minute
   download mid-index.
10. **Links the CLI onto `PATH`** via `pnpm link --global` — this is what makes `mnotes`, `mnotes-mcp`,
    and `mnotes-indexer` (the three `bin` entries in `package.json`) resolve as commands. Warns and
    continues on failure (a stale/mismatched global pnpm store is a real, observed failure mode) rather
    than aborting the rest of install.
11. **Registers the MCP server with Claude Code**: `claude mcp add mnotes -s user -- ...`, only if
    `claude` is on `PATH` and not already registered. `-s user` scope means it's available in every
    Claude Code session on this machine, not just one project directory.

## Verifying the install

```sh
mnotes stats          # note/tag counts, daemon status, queue depth
launchctl print gui/$(id -u)/com.ajmichels.mnotes             # confirm the daemon is loaded
launchctl print gui/$(id -u)/com.ajmichels.mnotes.logrotate    # confirm log rotation is loaded
tail -f ~/Library/Logs/com.ajmichels.mnotes/indexer.log        # watch the daemon's first indexing pass
claude mcp list        # confirm "mnotes" is registered, if you use Claude Code
```

`mnotes stats` reporting `daemon running: false` right after install usually means the model download
(step 9) is still in progress, or `fswatch` is missing (see
[Process Management](process-management.md) for troubleshooting).

## Next steps

- [Usage](usage.md) — the full `mnotes` command reference and MCP tool overview.
- [Process Management](process-management.md) — starting/stopping the daemon, logs, troubleshooting.
- [Uninstallation](uninstallation.md) — removing everything this script created.
