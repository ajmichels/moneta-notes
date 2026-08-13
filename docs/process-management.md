# Process Management

Two long-running background processes are installed as per-user macOS `launchd` LaunchAgents (no
admin/sudo needed) — see [S005 — Indexing Daemon](specs/S005-indexing-daemon.md),
[S008 — Logging](specs/S008-logging.md), and [S009 — Config & Install](specs/S009-config-and-install.md)
for full design detail:

| LaunchAgent label | Runs | Purpose |
|---|---|---|
| `com.ajmichels.mnotes` | `src/indexer/daemon.js` | Watches the vault (`fswatch`), keeps the SQLite FTS5 + vector index in sync, serves the reindex IPC socket. |
| `com.ajmichels.mnotes.logrotate` | `src/log-rotator.js` | Rotates the three log files on a schedule (`RunAtLoad` + four times daily). |

Both are `KeepAlive: true` — if the daemon process dies, `launchd` relaunches it automatically. This
matters for the commands below: a plain `kill`/signal just gets immediately relaunched, which is why
stopping it requires `launchctl bootout`, not a signal.

## `mnotes daemon <start|stop|restart>`

The everyday interface — a thin wrapper around `launchctl`, targeting the indexing daemon's LaunchAgent
directly (`com.ajmichels.mnotes`, not the log-rotation agent, which isn't meant to be manually
started/stopped).

```sh
mnotes daemon start     # launchctl bootstrap gui/<uid> <plist>    — loads the agent (no-op if already loaded)
mnotes daemon stop      # launchctl bootout gui/<uid>/com.ajmichels.mnotes — unloads it until the next start/login
mnotes daemon restart   # launchctl kickstart -k gui/<uid>/com.ajmichels.mnotes — kill + relaunch in place
```

Use `restart` after editing `~/.config/mnotes/config.toml` — the daemon reads config once at startup,
so a running daemon won't pick up an edited file on its own.

`launchctl`'s own stderr is surfaced directly in the error message on failure (its exact wording isn't
stable across macOS versions, so it's passed through as-is rather than reworded).

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

Lower-level, direct from `launchd`:

```sh
launchctl print gui/$(id -u)/com.ajmichels.mnotes
launchctl print gui/$(id -u)/com.ajmichels.mnotes.logrotate
```

## Logs

All three log files live in `~/Library/Logs/com.ajmichels.mnotes/`, plain single-line text (not JSON —
chosen specifically so `tail -f` / `grep` work directly, no log processor needed):

| File | Contents |
|---|---|
| `indexer.log` | Daemon lifecycle (started, schema check, `fswatch` watcher started), queue drain activity, embedding model load/idle-unload, hash mismatches, permanent queue-item failures. |
| `mcp-server.log` | MCP server lifecycle (started, stdio transport connected/disconnected), protocol-level errors. Tool-call outcomes are **not** here. |
| `audit.log` | Every note mutation — MCP tool calls (`note_write`/`note_edit`/`note_append`/`note_rename`) and CLI mutating commands (`write`/`edit`/`append`/`rename`) — with outcome and, for MCP calls, the caller's stated `reason`. |

```sh
tail -f ~/Library/Logs/com.ajmichels.mnotes/indexer.log
grep ERROR ~/Library/Logs/com.ajmichels.mnotes/indexer.log
grep 'outcome=error' ~/Library/Logs/com.ajmichels.mnotes/audit.log
```

Rotation (handled by the log-rotation LaunchAgent, not the daemon itself): each file rotates at 10MB or
7 days, whichever comes first, keeping the last 5 rotated files (`indexer.log.1`, `indexer.log.2`, ...).
Rotation policy is config-backed — see `[logging]` in [config.example.toml](../config.example.toml).

## Troubleshooting

- **Daemon crash-looping / not running after install** — almost always a missing `fswatch`
  (`brew install fswatch`, then `mnotes daemon restart`). Check `indexer.log` for the actual startup
  error.
- **`mnotes reindex` fails with "could not connect to the daemon"** — the daemon process isn't running.
  `mnotes daemon start`, then retry.
- **Daemon not picking up a config change** — `mnotes daemon restart` (config is read once at
  startup).
- **Background Task Management shows "Node.js Foundation" instead of "Moneta Notes"** — the native
  launcher wasn't built at install time (no `clang`). Install Xcode Command Line Tools
  (`xcode-select --install`) and re-run `./scripts/install.sh` — it's safe to re-run.
- **First note write after install seems to hang** — the embedding model may still be downloading if
  step 9 of install didn't finish cleanly; check `indexer.log` for download progress.

See [Installation](installation.md) for initial setup and [Uninstallation](uninstallation.md) for
tearing everything down.
