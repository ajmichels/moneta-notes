# S008 — Logging

Status: **Approved**
Owns: `src/logger.js`, `src/log-rotator.js`
Depends on: none (used by every other component)
Consumed by: `S005-indexing-daemon`, `S006-cli`, `S007-mcp-server`, `S009-config-and-install`
(rotation LaunchAgent installation)

## Purpose

Finalizes the README's "proposed, not yet locked in" logging section: library choice, rotation
mechanism, file layout, and the audit-trail shape — now covering CLI-sourced mutations too (per
S006), not just MCP tool calls as the README originally framed it.

## Library: pino

Structured JSON-lines logging via `pino`, one shared logger module (`src/logger.js`) that every other
component imports rather than using `console.log` directly — matches CLAUDE.md's existing instruction
that every log line carry a consistent shape (timestamp, component, level, message) regardless of
which part of the system emitted it. Each component (`indexer`, `mcp-server`) gets its own file
destination via a `pino` child logger tagged with a `component` field, rather than separate `pino`
instances.

No `pino-pretty` in production (per the README's own note) — logs are JSON lines, meant to be
`jq`-queried or read via a viewer, not formatted for direct terminal reading. The CLI does not use
this logger for its normal output (that's stdout/stderr per S006); it only writes to the audit log for
mutating commands (see below).

## Rotation: separate LaunchAgent, not in-process, not `newsyslog`

Pino's own maintainers recommend OS-level rotation over an in-process rotation library, to keep the
logging process's own overhead minimal — normally that means `logrotate` (Linux) or `newsyslog`
(macOS). **This project uses neither.** `newsyslog` configuration lives in `/etc/newsyslog.d/`, which
requires admin/sudo access to write — not reliably available on a work machine, which this project
explicitly needs to support (README: "personal or work machine, never both at once").

Instead: a small standalone script (`src/log-rotator.js`) that checks each log file against the
rotation policy and rotates if needed, run on a schedule by its **own separate LaunchAgent**
(`~/Library/LaunchAgents/com.ajmichels.mnotes.logrotate.plist`, installed alongside the main daemon's
plist by `scripts/install.sh` — S009). LaunchAgents (as opposed to LaunchDaemons) install per-user
under `~/Library/LaunchAgents/` and need no admin privileges, the same way the main indexing daemon's
plist already doesn't. This satisfies the "keep rotation logic out of the long-running process" goal
pino's maintainers recommend, without depending on system-level configuration this project can't
assume access to.

- **Check cadence**: `RunAtLoad: true` (a check runs every time the LaunchAgent loads — i.e. every
  login/boot) plus `StartCalendarInterval` entries at four fixed times daily (`00:00`, `06:00`,
  `12:00`, `18:00`). This combination, not `StartInterval`, deliberately: `StartInterval` firings that
  occur while the Mac is asleep are silently dropped on modern macOS with no catch-up, whereas
  `StartCalendarInterval` *does* catch up a missed firing once the machine wakes from sleep (though
  not after being fully powered off). Between `RunAtLoad` (catches every actual use of the machine)
  and the calendar-interval catch-up behavior, a personal machine that isn't always on still gets
  checked reliably — and since log volume is driven by real file-change activity, a machine that's
  off/asleep isn't generating log volume either; the two naturally track each other, so the worst case
  from a missed window is a somewhat-overdue rotation, never unbounded growth. The rotation logic
  itself is idempotent regardless of how long it's been since the last check — it just compares
  current size/age against the threshold whenever it happens to run.
- **Rotation policy** (per log file, config-backed per the established pattern — flagged for S009):
  size threshold **10MB** or age threshold **7 days**, whichever comes first; **keep last 5** rotated
  files, oldest deleted beyond that.
- Rotated files are renamed with a numeric suffix (`indexer.log.1`, `indexer.log.2`, ...), shifting
  existing numbered files up by one and dropping anything beyond the keep-5 window, then the active
  log file is recreated empty — standard `logrotate`-style behavior, just implemented directly rather
  than via the system tool.

## File layout

`~/Library/Logs/com.ajmichels.mnotes/`:

- **`indexer.log`** — daemon lifecycle (started, schema check/rebuild, watermark catch-up results,
  existence-check cleanup count, `fswatch` watcher started) and processing events (queue drain
  activity, embedding model load/idle-unload) at `info`; size-drop-guard-equivalent issues, hash
  mismatches encountered during processing, embedding failures, and permanent queue-item failures
  (retries exhausted, per S005) at `warn`/`error`.
- **`mcp-server.log`** — server lifecycle (started, stdio transport connected/disconnected) at `info`;
  protocol-level errors at `warn`/`error`. Tool-call outcomes do **not** live here — see `audit.log`.
- **`audit.log`** — the tool-call/mutation audit trail, separated out from `mcp-server.log` from the
  start (rather than the README's "maybe split later if noisy" framing) because it now has two
  sources, not one: every MCP tool call (per S007) **and** every CLI mutating command (`write`,
  `edit`, `append`, `rename` — per S006's decision that these get logged too, just without a `reason`).
  Entry shape: `{ tool, note_title, source<"mcp"|"cli">, reason<string|null>, timestamp, outcome }` —
  `reason` is always present for `source: "mcp"` (required by every MCP tool) and always `null` for
  `source: "cli"` (S006 explicitly has no `--reason` flag). `outcome` is `"success"` or `"error"` (with
  the error message, matching S007's error-passthrough approach — an audit trail that hides *why*
  something failed is much less useful). All at `info` level regardless of outcome — a failed mutation
  is still a normal, expected audit event, not a system error.

CLI **read-only** commands (`search`, `grep`, `tags`, `read`) are not logged anywhere beyond their own
stdout/stderr — only mutations go to `audit.log`, matching the README's original "CLI is interactive,
doesn't need persistent logging" framing for the read side, while extending logging to the write side
per S006.

## What never gets logged

Per CLAUDE.md: never full note content, never diffs. `audit.log` entries carry `note_title` (an
identifier, not content) and `reason` (Claude's stated justification, not the note body) — nothing in
this spec's log shapes risks becoming a second, unmanaged copy of vault data.

## Explicitly out of scope here

- **Exact `config.toml` keys for the rotation policy numbers** — S009.
- **`log-rotator.js`'s LaunchAgent plist contents and install-script wiring** — S009.
