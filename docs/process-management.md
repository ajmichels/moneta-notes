# Process Management

Two long-running background processes are installed per-user (no admin/sudo needed) — as macOS
`launchd` LaunchAgents, or Linux `systemd --user` units — see
[S005 — Indexing Daemon](specs/S005-indexing-daemon.md), [S008 — Logging](specs/S008-logging.md), and
[S009 — Config & Install](specs/S009-config-and-install.md) for full design detail:

| macOS LaunchAgent label | Linux systemd unit(s) | Runs | Purpose |
|---|---|---|---|
| `com.ajmichels.mnotes` | `mnotes.service` | `src/indexer/daemon.js` | Watches the vault (`fswatch`), keeps the SQLite FTS5 + vector index in sync, serves the IPC socket (reindex requests, and query embedding for `search --mode=semantic\|hybrid` from both the CLI and the MCP server). |
| `com.ajmichels.mnotes.logrotate` | `mnotes-logrotate.service` + `mnotes-logrotate.timer` | `src/log-rotator.js` | Rotates the three log files on a schedule (login/boot + four times daily). |

Both keep the daemon running if it dies (`KeepAlive: true` on macOS, `Restart=always` + `RestartSec=5`
on Linux) — a plain `kill`/signal just gets it relaunched, which is why stopping it requires the
commands below, not a signal.

## `mnotes daemon <start|stop|restart>`

The everyday interface — a thin wrapper around `src/platform` (S009), which targets the indexing
daemon's service directly (not the log-rotation one, which isn't meant to be manually started/stopped).

```sh
mnotes daemon start     # macOS: launchctl bootstrap gui/<uid> <plist>   Linux: systemctl --user start mnotes.service
mnotes daemon stop      # macOS: launchctl bootout gui/<uid>/com.ajmichels.mnotes   Linux: systemctl --user stop mnotes.service
mnotes daemon restart   # macOS: launchctl kickstart -k gui/<uid>/com.ajmichels.mnotes   Linux: systemctl --user restart mnotes.service
```

Use `restart` after editing `~/.config/mnotes/config.toml` — the daemon reads config once at startup,
so a running daemon won't pick up an edited file on its own.

The underlying service manager's own stderr is surfaced directly in the error message on failure (its
exact wording isn't stable across OS/distro versions, so it's passed through as-is rather than
reworded).

This is distinct from **`mnotes reindex`**, which talks to the *already-running* daemon over its IPC
socket to trigger a reindex pass — it doesn't start or stop anything. See [Usage](usage.md#mnotes-reindex-title)
for that command; if it fails with a "could not connect to the daemon" error, the daemon process itself
isn't running — use `mnotes daemon start` first.

## Checking status

```sh
mnotes stats
```

Reports daemon status (best-effort: attempts a socket connection to `daemon.sock`, non-blocking on
failure) and current queue depth (`index_queue` row count) alongside index stats. A large or growing
queue depth means the daemon is behind or stuck — check the logs below.

Lower-level, direct from the service manager:

```sh
# macOS
launchctl print gui/$(id -u)/com.ajmichels.mnotes
launchctl print gui/$(id -u)/com.ajmichels.mnotes.logrotate

# Linux
systemctl --user status mnotes.service
systemctl --user list-timers mnotes-logrotate.timer
```

## Logs

All three log files live under one directory — `~/Library/Logs/com.ajmichels.mnotes/` on macOS,
`~/.local/state/mnotes/log/` on Linux (respects `$XDG_STATE_HOME`) — plain single-line text (not JSON —
chosen specifically so `tail -f` / `grep` work directly, no log processor needed):

| File | Contents |
|---|---|
| `indexer.log` | Daemon lifecycle (started, schema check, `fswatch` watcher started), queue drain activity, embedding model load/idle-unload, hash mismatches, permanent queue-item failures. |
| `mcp-server.log` | MCP server lifecycle (started, stdio transport connected/disconnected), protocol-level errors. Tool-call outcomes are **not** here. |
| `audit.log` | Every note/attachment mutation — MCP tool calls (`note_write`/`note_edit`/`note_append`/`note_rename`/`attachment_write`) and CLI mutating commands (`write`/`edit`/`append`/`rename`/`attachment write`) — with outcome and, for MCP calls, the caller's stated `reason`. |

```sh
tail -f <log dir>/indexer.log
grep ERROR <log dir>/indexer.log
grep 'outcome=error' <log dir>/audit.log
```

Rotation (handled by the log-rotation service, not the daemon itself): each file rotates at 10MB or
7 days, whichever comes first, keeping the last 5 rotated files (`indexer.log.1`, `indexer.log.2`, ...).
On macOS this runs off `StartCalendarInterval`'s built-in wake catch-up; on Linux, the equivalent is the
timer unit's `Persistent=true`. Rotation policy is config-backed — see `[logging]` in
[Configuration](configuration.md#logging).

## Troubleshooting

- **Daemon crash-looping / not running after install** — almost always a missing `fswatch` (install it
  per [Installation](installation.md#prerequisites) for your OS, then `mnotes daemon restart`). Check
  `indexer.log` for the actual startup error.
- **`mnotes reindex`, or `search --mode=semantic|hybrid` (CLI or MCP), fails with "could not connect
  to the daemon"** — the daemon process isn't running. `mnotes daemon start`, then retry. Semantic/
  hybrid search has no local-model fallback (S005) — it always needs the daemon up.
- **Daemon not picking up a config change** — `mnotes daemon restart` (config is read once at
  startup).
- **(macOS) Background Task Management shows "Node.js Foundation" instead of "Moneta Notes"** — the
  native launcher wasn't built at install time (no `clang`). Install Xcode Command Line Tools
  (`xcode-select --install`) and re-run `./scripts/install.sh` — it's safe to re-run. Doesn't apply to
  Linux — systemd units don't have an equivalent identity concept.
- **(Linux) Daemon stops when you log out** — a `systemd --user` instance normally only runs during an
  active login session. For a headless/always-on box, enable lingering:
  `loginctl enable-linger $(whoami)`.
- **First note write after install seems to hang** — the embedding model may still be downloading if
  step 9 of install didn't finish cleanly; check `indexer.log` for download progress.

See [Installation](installation.md) for initial setup and [Uninstallation](uninstallation.md) for
tearing everything down.
