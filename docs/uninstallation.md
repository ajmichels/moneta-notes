# Uninstallation

```sh
./scripts/uninstall.sh
```

Removes everything `scripts/install.sh` created. **Never touches the vault itself** — uninstalling
`mnotes` removes the tool's own state (index, config, logs, background processes), not your notes.
Safe to run even if install never fully completed (e.g. `claude` or `pnpm` were never on `PATH`) —
every step tolerates "wasn't there to begin with."

## What it does, in order

1. **Deregisters the MCP server from Claude Code** — `claude mcp remove mnotes -s user`, only if
   `claude` is on `PATH`. Tolerates "not registered."
2. **Unlinks the CLI from `PATH`** — `pnpm uninstall --global moneta-notes`, only if `pnpm` is on
   `PATH`. Tolerates "not linked."
3. **Unloads both LaunchAgents** — `launchctl bootout` for `com.ajmichels.mnotes` and
   `com.ajmichels.mnotes.logrotate`. Tolerates "not currently loaded."
4. **Deletes both property list files** from `~/Library/LaunchAgents/`.
5. **Deletes `~/Library/Logs/com.ajmichels.mnotes/`** — all three log files, gone.
6. **Deletes `~/Library/Application Support/mnotes/`** — the SQLite index, the daemon's Unix socket,
   and the launcher app bundle (`MonetaNotes.app`). Safe to delete unconditionally: the index is a pure
   derived cache — a future reinstall's daemon rebuilds it from the vault from scratch on first run.
7. **Deletes `~/.config/mnotes/`** — including `config.toml`, if one was ever written. If you have
   hand-tuned settings you want to keep, back this file up first (`cp ~/.config/mnotes/config.toml
   ~/config.toml.bak`).

## What it does *not* remove

- **The vault itself** — every note file is untouched.
- **Node, pnpm, ripgrep, fswatch, Xcode Command Line Tools** — these are general-purpose tools this
  project depends on, not `mnotes`-specific state. Remove them yourself via Homebrew
  (`brew uninstall ripgrep fswatch`) if you no longer want them.
- **The cached embedding model** — `@huggingface/transformers`' own model cache (outside this
  project's directories) isn't cleared. Harmless to leave; delete it yourself via that library's cache
  location if you want the disk space back.
- **This git repository** — `scripts/uninstall.sh` removes installed *state*, not the cloned repo
  you ran it from. `rm -rf` the repo directory yourself if you're done with it entirely.

## Reinstalling later

Just re-run `./scripts/install.sh` — see [Installation](installation.md). Since uninstall clears
`~/.config/mnotes/`, a fresh install starts from the built-in defaults again unless you restore a
backed-up `config.toml` first.
