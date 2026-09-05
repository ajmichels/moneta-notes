# Installation

Covers `scripts/install.sh` end to end: prerequisites, what it prompts for, what it creates on disk,
and how to verify it worked. The authoritative spec for this behavior is
[S009 — Config & Install](specs/S009-config-and-install.md); this page is the practical walkthrough.

## Prerequisites

Runs on **macOS or Linux**. `scripts/install.sh` detects which one it's running on and behaves
accordingly — see [S009's Platform abstraction](specs/S009-config-and-install.md#platform-abstraction-fencing-not-branching)
for exactly what differs.

Required:

- **Node.js** — the runtime everything executes under.
- **pnpm 11+** — dependency install and the global `pnpm add --global` step that puts `mnotes` on
  `PATH`. The pinned version lives in `package.json`'s `packageManager` field; if you have
  [Corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`), it'll transparently
  fetch and run that exact version for you. If pnpm came from your distro's package manager (Arch's
  `pnpm` package, Debian/Ubuntu's, etc.) rather than Corepack or the official installer, it may not
  have a global bin directory configured — run `pnpm setup` once and restart your shell (or open a
  new one) so `PNPM_HOME` is on `PATH` before running `install.sh`, otherwise step 10 below
  (`pnpm add --global`) will succeed but leave `mnotes` unreachable.

Strongly recommended, checked by the installer (warns and continues if missing, doesn't block):

- **[ripgrep](https://github.com/BurntSushi/ripgrep)** — powers `mnotes grep`. Without it, every other
  command still works. Install via `brew install ripgrep` on macOS, or your distro's package manager on
  Linux (`apt install ripgrep`, `dnf install ripgrep`, `pacman -S ripgrep` — all three are official
  packages, no extra repo needed).
- **fswatch** — the indexing daemon's file-watching backend. Without it, the daemon will crash-loop
  under its service manager. Install via `brew install fswatch` on macOS, or your distro's package
  manager on Linux (`apt install fswatch`, `pacman -S fswatch`; on **RHEL/CentOS/Rocky/AlmaLinux**
  specifically, enable EPEL first — `dnf install epel-release fswatch` — it isn't in the base repos
  there, though it is on plain Fedora).

macOS-only:

- **Xcode Command Line Tools** (`xcode-select --install`, gives you `clang`) — used to compile a small
  native launcher so the two background LaunchAgents show up in macOS's Background Task Management UI
  as "Moneta Notes" rather than "Node.js Foundation". Without it, install falls back to a plain shell
  wrapper — everything still works, just with the generic Node identity. This step doesn't exist on
  Linux — systemd units carry their own identity, so there's nothing to fix.

Linux-only:

- If this machine should keep the daemon running **without an active login session** (a headless/
  always-on box), enable lingering after install: `loginctl enable-linger $(whoami)`. Without it, a
  `systemd --user` instance (and everything in it, including the daemon) stops when your last session
  ends — the installer prints this as a reminder, but doesn't run it for you.

Optional:

- **[Claude Code CLI](https://claude.com/claude-code)** (`claude`) — if present, install registers the
  MCP server automatically. If absent, install prints the manual `claude mcp add` command to run later.

## Running the installer

```sh
git clone <this repo>
cd moneta-notes
pnpm install --prod
./scripts/install.sh
```

`pnpm install` (dependency install) is a separate, ordinary step — `install.sh` assumes it's already
been run and doesn't do it for you. `--prod` skips `devDependencies` (vitest, eslint, husky, ...),
which nothing at runtime needs — `pnpm add --global` (step 10 below) links the CLI straight to this
same `node_modules`, so whatever's installed here is what the running app gets. If you're going to
modify the code, run plain `pnpm install` (no `--prod`) instead so the test/lint tooling is available.

You'll be prompted for two paths, each with a sensible default (press Enter to accept):

```
Vault path [~/Documents/Notes]:
Index DB path [~/Library/Application Support/mnotes/index.db]:    # macOS
Index DB path [~/.local/share/mnotes/index.db]:                    # Linux
```

Both prompts support `~`-relative paths, relative paths, arrow-key editing, and Tab-completion.
Whatever you type is resolved to an absolute path before use.

## What the installer does

In order (macOS/Linux differences noted inline — see S009 for the exact per-OS mechanics):

1. **Preflight checks** — warns (doesn't block) if `rg` or `fswatch` are missing, with the platform-
   appropriate install hint from above.
2. **Prompts** for vault path and DB path (above).
3. **Writes `~/.config/mnotes/config.toml`** — but only if it doesn't already exist, and only if at
   least one answer differs from its suggested default. If you accept both defaults, **no file is
   written at all** — every value already has a built-in default in `src/config.js`, and the file only
   ever contains genuinely-overridden keys. Identical on both OSes. See [Configuration](configuration.md)
   for every tunable that can go in this file (or [config.example.toml](../config.example.toml) for the
   same schema as a copy-pasteable file). An existing `config.toml` (e.g. re-running install after an
   upgrade) is always left untouched.
4. **Creates the app-support directory** — `~/Library/Application Support/mnotes/` on macOS,
   `~/.local/share/mnotes/` on Linux (respects `$XDG_DATA_HOME` if set). Holds the SQLite index
   (`index.db`, schema created by the daemon on first run, not by this script) and the daemon's Unix
   socket (`daemon.sock`).
5. **Creates the logs directory** — `~/Library/Logs/com.ajmichels.mnotes/` on macOS,
   `~/.local/state/mnotes/log/` on Linux (respects `$XDG_STATE_HOME`) — see
   [Process Management](process-management.md#logs) for what lands here.
6. **Prepares the launch executable**: on macOS, builds a native launcher app bundle
   (`MonetaNotes.app`) if `clang` is available, so the two LaunchAgents below are correctly attributed
   in macOS's Background Task Management UI — falls back to a plain wrapper script if not. On Linux,
   this is a no-op — the daemon is launched via `node` directly, no bundle/signing concept applies.
7. **Writes the service definition file(s)**: macOS gets two LaunchAgent property lists in
   `~/Library/LaunchAgents/` (`com.ajmichels.mnotes.plist` for the indexing daemon,
   `com.ajmichels.mnotes.logrotate.plist` for log rotation). Linux gets three systemd user units in
   `~/.config/systemd/user/` (`mnotes.service`, `mnotes-logrotate.service`, `mnotes-logrotate.timer` —
   systemd splits "what runs" from "when," unlike a single plist), followed by
   `systemctl --user daemon-reload`. The daemon's service definition also carries forward `PATH` (so
   its `fswatch` spawn can find it even though services run with a minimal PATH) and, if set in the
   installer's own environment, `NODE_EXTRA_CA_CERTS` — needed if you're behind a TLS-intercepting
   corporate proxy (e.g. Zscaler), since a background service never sees a shell rc file's `export
   NODE_EXTRA_CA_CERTS=...` on its own. If you're on such a network, set it *before* running this
   installer (`export NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem` in your shell profile), then
   re-run `install.sh` to pick it up if you set it afterward.
8. **Activates both services**: macOS runs `launchctl bootstrap gui/<uid> <plist>` for both plists.
   Linux runs `systemctl --user enable --now` for `mnotes.service` and `mnotes-logrotate.timer` — both
   start running immediately either way.
9. **Pre-downloads the embedding model** (`Qwen3-Embedding-0.6B`, quantized) — a one-time download via
   `@huggingface/transformers`, printed as "downloading embedding model, this may take a minute...".
   Doing this at install time means the first real note write doesn't stall on a surprise multi-minute
   download mid-index. Identical on both OSes. Cached under `appSupportDir()/models` (alongside
   `index.db`) rather than inside `node_modules`, so it survives a `pnpm install`/upgrade rather than
   being wiped and needing a network redownload on next daemon start.
10. **Links the CLI onto `PATH`** via `pnpm add --global` — this is what makes `mnotes`, `mnotes-mcp`,
    and `mnotes-indexer` (the three `bin` entries in `package.json`) resolve as commands. (pnpm 11
    removed `pnpm link --global`; `pnpm add --global <path>` is its replacement.) Warns and continues
    on failure (a stale/mismatched global pnpm store, or a missing `PNPM_HOME` — see Prerequisites
    above — are real, observed failure modes) rather than aborting the rest of install.
11. **Registers the MCP server with Claude Code**: `claude mcp add mnotes -s user -- ...`, only if
    `claude` is on `PATH` and not already registered. `-s user` scope means it's available in every
    Claude Code session on this machine, not just one project directory. Identical on both OSes.

## Verifying the install

macOS:

```sh
mnotes stats          # note/tag counts, daemon status, queue depth
launchctl print gui/$(id -u)/com.ajmichels.mnotes             # confirm the daemon is loaded
launchctl print gui/$(id -u)/com.ajmichels.mnotes.logrotate    # confirm log rotation is loaded
tail -f ~/Library/Logs/com.ajmichels.mnotes/indexer.log        # watch the daemon's first indexing pass
claude mcp list        # confirm "mnotes" is registered, if you use Claude Code
```

Linux:

```sh
mnotes stats                                  # note/tag counts, daemon status, queue depth
systemctl --user status mnotes.service        # confirm the daemon is running
systemctl --user list-timers mnotes-logrotate.timer   # confirm log rotation is scheduled
tail -f ~/.local/state/mnotes/log/indexer.log # watch the daemon's first indexing pass
claude mcp list                               # confirm "mnotes" is registered, if you use Claude Code
```

`mnotes stats` reporting `daemon running: false` right after install usually means the model download
(step 9) is still in progress, or `fswatch` is missing (see
[Process Management](process-management.md) for troubleshooting).

## Next steps

- [Configuration](configuration.md) — every `config.toml` option, what it does, and its default.
- [Usage](usage.md) — the full `mnotes` command reference and MCP tool overview.
- [Process Management](process-management.md) — starting/stopping the daemon, logs, troubleshooting.
- [Uninstallation](uninstallation.md) — removing everything this script created.
