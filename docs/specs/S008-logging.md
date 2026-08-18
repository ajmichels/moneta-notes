# S008 — Logging

Status: **Approved**
Owns: `src/logger.js`, `src/log-rotator.js`
Depends on: none (used by every other component)
Consumed by: `S005-indexing-daemon`, `S006-cli`, `S007-mcp-server`, `S009-config-and-install`
(rotation LaunchAgent installation), `S012-attachments` — and, via `getContextLogger()`, every `core/`
module (`S001`-`S004`), per CLAUDE.md's instruction that `core/` use the shared logger instead of ad hoc
`console.log`.

## Purpose

Finalizes the README's "proposed, not yet locked in" logging section: library choice, rotation
mechanism, file layout, and the audit-trail shape — now covering CLI-sourced mutations too (per
S006), not just MCP tool calls as the README originally framed it.

## Library: none — hand-rolled plain-text writer

No third-party logging library. One shared module (`src/logger.js`) that every other component
imports rather than using `console.log` directly — matches CLAUDE.md's existing instruction that
every log line carry a consistent shape (timestamp, component, level, message) regardless of which
part of the system emitted it. `getLogger(component, logDir)` is an explicit factory: callers name
their own component (`'indexer'`, `'mcp-server'`, `'audit'`) and get back a small object, one method
per level, bound to `<logDir>/<component>.log`.

Plain, single-line, human-readable text — not JSON lines. Chosen over `pino`/structured JSON
deliberately: these logs are read directly (`tail -f`, `grep`) far more often than fed through a JSON
log processor, and `pino`'s dependency weight and binary-line format aren't worth it for this
project's log volume. See "Log line format" below for the exact grammar — still consistently
parseable, just without a JSON parser. The CLI does not use this logger for its normal output (that's
stdout/stderr per S006); it only writes to the audit log for mutating commands (see below).

Each entry point (indexer daemon, MCP server, CLI) sets its own `process.title` at startup (e.g.
`mnotes-indexer`), purely so it's identifiable in Activity Monitor/`ps`. This is unrelated to logging
— `src/logger.js` never reads `process.title`. The log file path always comes from the explicit
`component` argument passed to `getLogger`, never inferred from the process.

## Context propagation into `core/`: `runWithLogger` / `getContextLogger`

`core/` modules (`S001`-`S004`) throw on error and never touch CLI flags, MCP tool schemas, or output
formatting — but per CLAUDE.md they still shouldn't reach for ad hoc `console.log` when something
worth a line in the log is happening below the level of a thrown error (e.g. a schema migration
applied, a drift condition detected and repaired). Passing an explicit `logger` parameter through
every `core/` function would leak a boundary-layer concern (which log file, which component) into
signatures that are supposed to stay plain-JS-in, plain-JS-out. Instead, `src/logger.js` exports a
`node:async_hooks` `AsyncLocalStorage`-backed context:

- `runWithLogger(logger, fn)` — each boundary layer calls this once, wrapping its main entry point
  (the indexer daemon's run loop, the MCP server's per-request handler, the CLI's command dispatch),
  passing the `getLogger(component, logDir)` instance for its own component. Every `core/` call made
  underneath — including across `await` boundaries — sees that same logger.
- `getContextLogger()` — what `core/` code calls instead of importing `getLogger` directly. Returns
  the logger passed to the nearest enclosing `runWithLogger`, or a no-op logger (every level resolves
  immediately, writes nothing) when called with no such context — the case for `core/`'s own unit
  tests, which call `core/` functions directly without any boundary layer running, per CLAUDE.md's
  "unit-test `core/` directly" testing philosophy. `core/` code never has to special-case "am I being
  tested" — the fallback makes that invisible.

Log lines written this way land in whichever file the calling boundary layer already owns
(`indexer.log`, `mcp-server.log`, or — for CLI mutating commands — the CLI's own logger instance,
see `S006`) under that same component name; `core/` never creates or names its own log file. This
keeps the "one log file per boundary-layer component" file layout below intact — `core/` only ever
borrows the active context's destination, it doesn't add new destinations.

## Log line format

Every log line shares the same prefix, followed by optional trailing context:

```
<ISO-8601 timestamp> <LEVEL padded to 5 chars> [<component>] <message> [<key>=<value> ...]
```

Example:
```
2026-08-13T18:22:10.512Z INFO  [indexer] daemon started
2026-08-13T18:23:01.004Z WARN  [indexer] hash mismatch during processing note_title="Weekly Notes/2026-W32"
```

- **Level** is upper-cased and right-padded with spaces to 5 characters (`INFO `, `WARN `, `ERROR`,
  `DEBUG`, `TRACE`, `FATAL`) so columns line up under `tail -f`.
- **Trailing context** — an optional plain object passed alongside the message — renders as
  `key=value` pairs in the object's own key order, space-separated. String values are always
  double-quoted (internal `"` escaped as `\"`) so the grammar never has to guess whether a value needs
  quoting from its content; non-string values (numbers, booleans) render bare. **Keys whose value is
  `null`/`undefined` are omitted from the line entirely** — no placeholder token — so, e.g., a CLI
  audit entry with no `reason` doesn't carry a dangling `reason=` field.
- Fully `grep`/`awk`-able as plain text: `grep ERROR indexer.log`, `grep 'outcome=error' audit.log`.
- **Write failures never throw or crash the process.** A failed `appendFile` (disk full, permissions)
  is reported via `console.error` — safe under MCP's stdio transport, since stdout is reserved for
  JSON-RPC frames and stderr is the standard side channel for logs/diagnostics — and then swallowed;
  the calling component keeps running. Each logger method returns the write's promise, so tests can
  `await` a call and immediately read the file, but that promise always resolves, never rejects — a
  production call site that doesn't await it (the normal fire-and-forget path) can never see an
  unhandled rejection from a log call. This is distinct from `logAudit`'s shape-validation errors
  (below), which throw synchronously and immediately — a malformed audit entry is a programming error
  caught before any I/O is attempted, and CLAUDE.md's "fail loudly" applies there, not to I/O faults.

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
  `edit`, `append`, `rename`, `attachment write` — per S006's decision that these get logged too, just
  without a `reason`). `tool` is the line's message; `note_title` (or, for `attachment_write`/
  `attachment_read`, `attachment_path` — S012 — same slot, named for whichever identifier the tool
  actually takes), `source<"mcp"|"cli">`, `reason<string, present only when source:"mcp">`,
  `outcome<"success"|"error">`, and `error_message<string, present only when outcome:"error">` are
  trailing context fields per the Log line format above, e.g.:
  ```
  2026-08-13T18:24:00.113Z INFO  [audit] note_write note_title="Weekly Notes/2026-W32" source=mcp reason="testing redaction" outcome=success
  2026-08-13T18:24:05.221Z INFO  [audit] write note_title="Test.md" source=cli outcome=error error_message="hash mismatch"
  2026-08-13T18:24:11.402Z INFO  [audit] attachment_write attachment_path="Attachments/receipt.pdf" source=mcp reason="saving expense receipt" outcome=success
  ```
  `reason` is required by every MCP tool call and rendered only for `source: "mcp"`; it's always absent
  for `source: "cli"` (S006 explicitly has no `--reason` flag). `error_message` is required and
  rendered only when `outcome: "error"` (matching S007's error-passthrough approach — an audit trail
  that hides *why* something failed is much less useful). All at `info` level regardless of outcome —
  a failed mutation is still a normal, expected audit event, not a system error.

CLI **read-only** commands (`search`, `grep`, `tags`, `read`, `attachment read`) are not logged anywhere
beyond their own stdout/stderr — only mutations go to `audit.log`, matching the README's original "CLI
is interactive, doesn't need persistent logging" framing for the read side, while extending logging to
the write side per S006.

## What never gets logged

Per CLAUDE.md: never full note content, never diffs. `audit.log` entries carry `note_title`/
`attachment_path` (an identifier, not content) and `reason` (Claude's stated justification, not the
note body) — nothing in this spec's log shapes risks becoming a second, unmanaged copy of vault data.
Extended by S012: never the attachment's bytes or base64 content either, same rationale.

## Explicitly out of scope here

- **Exact `config.toml` keys for the rotation policy numbers** — S009.
- **`log-rotator.js`'s LaunchAgent plist contents and install-script wiring** — S009.
