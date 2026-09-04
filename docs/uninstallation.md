# Uninstallation

```sh
./scripts/uninstall.sh
```

Removes everything `scripts/install.sh` created, on both macOS and Linux. **Never touches the vault
itself** — uninstalling `mnotes` removes the tool's own state (index, config, logs, background
processes), not your notes. Safe to run even if install never fully completed (e.g. `claude` or `pnpm`
were never on `PATH`) — every step tolerates "wasn't there to begin with."

## What it does, in order

1. **Deregisters the MCP server from Claude Code** — `claude mcp remove mnotes -s user`, only if
   `claude` is on `PATH`. Tolerates "not registered."
2. **Unlinks the CLI from `PATH`** — `pnpm uninstall --global moneta-notes`, only if `pnpm` is on
   `PATH`. Tolerates "not linked."
3. **Deactivates both services**: macOS — `launchctl bootout` for `com.ajmichels.mnotes` and
   `com.ajmichels.mnotes.logrotate`. Linux — `systemctl --user disable --now` for `mnotes.service` and
   `mnotes-logrotate.timer`. Tolerates "not currently loaded" either way.
4. **Deletes the service definition file(s)**: both property list files on macOS
   (`~/Library/LaunchAgents/`); all three unit files on Linux (`mnotes.service`,
   `mnotes-logrotate.service`, `mnotes-logrotate.timer` under `~/.config/systemd/user/`), followed by
   `systemctl --user daemon-reload`.
5. **Deletes the logs directory** — `~/Library/Logs/com.ajmichels.mnotes/` on macOS,
   `~/.local/state/mnotes/log/` on Linux — all three log files, gone.
6. **Deletes the app-support directory** — `~/Library/Application Support/mnotes/` on macOS
   (including the launcher app bundle, `MonetaNotes.app`), `~/.local/share/mnotes/` on Linux — the
   SQLite index and the daemon's Unix socket either way. Safe to delete unconditionally: the index is a
   pure derived cache — a future reinstall's daemon rebuilds it from the vault from scratch on first
   run.
7. **Deletes `~/.config/mnotes/`** — including `config.toml`, if one was ever written. Identical on
   both OSes. If you have hand-tuned settings you want to keep, back this file up first
   (`cp ~/.config/mnotes/config.toml ~/config.toml.bak`).

## What it does *not* remove

- **The vault itself** — every note file is untouched.
- **Node, pnpm, ripgrep, fswatch** (and, on macOS, Xcode Command Line Tools) — these are
  general-purpose tools this project depends on, not `mnotes`-specific state. Remove them yourself via
  your platform's package manager if you no longer want them.
- **The cached embedding model** — `@huggingface/transformers`' own model cache (outside this
  project's directories) isn't cleared. Harmless to leave; delete it yourself via that library's cache
  location if you want the disk space back.
- **This git repository** — `scripts/uninstall.sh` removes installed *state*, not the cloned repo
  you ran it from. `rm -rf` the repo directory yourself if you're done with it entirely.
- **On Linux, lingering** (`loginctl enable-linger`), if you enabled it during install — uninstall
  doesn't touch this system-level setting. Disable it yourself with
  `loginctl disable-linger $(whoami)` if you no longer need any per-user service to keep running
  without a login session.

## Reinstalling later

Just re-run `./scripts/install.sh` — see [Installation](installation.md). Since uninstall clears
`~/.config/mnotes/`, a fresh install starts from the built-in defaults again unless you restore a
backed-up `config.toml` first.
