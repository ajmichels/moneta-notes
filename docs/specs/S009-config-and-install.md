# S009 — Config & Install

Status: **Approved**
Owns: `src/config.js`, `scripts/install.sh`, `scripts/uninstall.sh`, `launchd/*.plist.template`
Depends on: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`, `S007-mcp-server`,
`S008-logging` (config knobs flagged across all of these land here)

## Purpose

Finalizes `config.toml`'s full shape (collecting every tunable flagged across S002/S003/S004/S005/S008
into one coherent schema), and the install/uninstall flow — now covering **two** LaunchAgents (the
indexing daemon from the README, plus S008's log-rotation agent) instead of one, plus registering (and
deregistering) `mnotes-mcp` as an actual Claude Code MCP server and linking (and unlinking) the `mnotes`
CLI onto `PATH` — rather than leaving either step manual.

## `config.toml` schema

```toml
vault_path = "/Users/aj/Documents/Notes"
db_path = "/Users/aj/Library/Application Support/mnotes/index.db"
embedding_model = "Qwen3-Embedding-0.6B"

[search]
limit_default = 20          # S002
limit_max = 100              # S002
overfetch_multiplier = 5     # S002
overfetch_cap = 500          # S002
rrf_k = 60                   # S002 (README-stated default)

[notes]
size_drop_threshold = 0.50   # S003 — reject a write/edit dropping below this fraction of prior line count

[grep]
line_match_cap = 10          # S004 — line numbers shown per note before "(+N more)"

[index]
debounce_ms = 15000                    # S005 — per-path fswatch debounce window
model_idle_unload_minutes = 10         # S005
embedding_dtype = "q8"                 # S005 — fp32 | fp16 | q8
retry_backoff_seconds = [30, 120, 600] # S005 — one entry per retry after the initial attempt
retry_max_attempts = 4                 # S005 — initial attempt + len(retry_backoff_seconds)

[logging]
rotation_max_size_mb = 10    # S008
rotation_max_age_days = 7    # S008
rotation_keep = 5            # S008
```

`vault_path`, `db_path`, and `embedding_model` are the three values already documented in the
README/`config.example.toml`; everything under `[search]`/`[notes]`/`[grep]`/`[index]`/`[logging]` is
new, collecting every value flagged as config-backed across S002-S005/S008.

**`config.toml` on disk is a sparse override file, not a full dump.** Every value shown above is also
baked into `src/config.js` as an in-code default (one JS object mirroring this exact schema).
`src/config.js` deep-merges `~/.config/mnotes/config.toml` (if it exists) over those built-in
defaults — a config file containing only `vault_path` is entirely valid, with every other value
falling through to its code-level default. This means a hand-edited `config.toml` that predates a new
tunable being added doesn't need manual updates to pick up the new default (it was never in the file
to begin with), and — per the install flow below — a user who accepts every suggested default during
install ends up with **no config.toml file at all**, since there'd be nothing to override.

`config.example.toml` still documents the full shape (every key shown, for discoverability) —
documentation only, never the real config, per the existing convention. It's not what gets copied to
produce the real file; the real file (if written) only ever contains genuinely-overridden keys.

## Install (`scripts/install.sh`)

Assumes `pnpm install` has already been run (dependency installation is a separate, ordinary dev-setup
step, not part of this script). Steps, in order:

1. **Preflight check**: `which rg` — if missing, print a clear warning ("ripgrep not found — install
   via `brew install ripgrep` before using `mnotes grep`") and continue (not a hard blocker; every
   other tool still works without it).
2. **Prompt** for `vault_path` and `db_path`, each showing a **smart suggested default** computed from
   the current user (via `os.homedir()`) — e.g. `Vault path [~/Documents/Notes]:`,
   `Index DB path [~/Library/Application Support/mnotes/index.db]:` — so accepting the default is just
   pressing Enter. No other value is prompted for (everything else already has a code-level default,
   per the schema above).
   - Whatever the user types (a bare Enter for the default, a `~`-relative path, or a relative path)
     is **resolved to an absolute path** before use — `~` expanded via `os.homedir()`, relative paths
     resolved via `path.resolve()`. `config.toml` (if written at all) never contains an unexpanded `~`
     or a relative path.
3. **Create config file** (`~/.config/mnotes/config.toml`) — **only if it doesn't already exist, and
   only if at least one answer differs from its suggested default.** If every prompt was accepted
   as-is, no file is written at all (the built-in defaults in `src/config.js` already cover it). If
   the file is written, it contains **only the overridden keys** — e.g. just `vault_path` if that's
   the only thing that differs, not a full dump of every value. An existing `config.toml` (e.g.
   re-running install after an upgrade) is always left completely untouched regardless, so a reinstall
   never silently discards hand-edited tuning values.
4. **Create Application Support directory** (`~/Library/Application Support/mnotes/`) — holds the
   SQLite index (`index.db`, schema created by the daemon's own startup sequence per S005, not by this
   script — no duplicate schema-creation logic between install and the daemon) and the S005 Unix
   socket (`daemon.sock`).
5. **Create Logs directory** (`~/Library/Logs/com.ajmichels.mnotes/`).
6. **Create both Property List files** from templates: the indexing daemon's plist (existing, per
   README) and the **new** log-rotation LaunchAgent's plist (S008: `RunAtLoad: true` +
   `StartCalendarInterval` at `00:00`/`06:00`/`12:00`/`18:00`).
7. **Bootstrap both launchd jobs**: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ajmichels.mnotes.plist`
   and the equivalent for `com.ajmichels.mnotes.logrotate.plist`.
8. **Pre-download the embedding model**: a one-line pipeline warm-up call (loads the `q8` model per
   the now-created config, triggering `@huggingface/transformers`' download-and-cache) as the final
   step, with a visible "downloading embedding model, this may take a minute..." message — so the
   first real note write after install doesn't stall on a surprise multi-minute download in the middle
   of the daemon's first indexing pass.
9. **Link the CLI onto `PATH`**: `pnpm link --global` (run against the repo root) — this is what
   actually makes `package.json`'s `bin` entries (`mnotes`, `mnotes-mcp`, `mnotes-indexer`) resolve
   as commands; a plain local `pnpm install` (this script's own prerequisite, per the top of this
   section) never puts a package's own `bin` entries on `PATH` on its own, only `pnpm link --global`
   or an actual global install does. If the command fails (e.g. a stale/mismatched global pnpm store
   on this machine — a real, observed failure mode, unrelated to anything this script controls), print
   a warning with the exact command to retry by hand and continue (same "warn and continue" posture as
   step 1's `rg` check) rather than aborting the rest of install over it.
10. **Register the MCP server with Claude Code**: `which claude` — if missing, print a clear warning
    (the same "warn and continue" posture as step 1's `rg` check — Claude Desktop users or anyone
    registering the server by hand don't need the CLI present) naming the manual `claude mcp add`
    command to run later. If `claude` is present, check first via `claude mcp get mnotes` — if it
    already exists (exit `0`), leave it untouched and say so (same never-clobber posture as step 3's
    config file); otherwise register it with
    `claude mcp add mnotes -s user -- <node> <repo>/src/mcp/server.js` (`-s user`: available in every
    Claude Code session on this machine, not just one project directory — matching how the daemon,
    config, and index are already all machine-level, not project-level, resources). This step invokes
    `node`/the script path directly rather than depending on step 9's `mnotes-mcp` having successfully
    landed on `PATH` — the two steps are independent, and a step 9 failure shouldn't cascade into
    step 10 also failing.

## Uninstall (`scripts/uninstall.sh`)

1. **Deregister the MCP server from Claude Code**: `claude mcp remove mnotes -s user`, only if
   `claude` is present on `PATH` — tolerating "not registered" the same way step 3 below tolerates
   "not currently loaded" for the launchd jobs, since uninstall must be safe to run even if install
   never got that far (or `claude` was never installed on this machine at all).
2. **Unlink the CLI from `PATH`**: `pnpm uninstall --global <package name>` (read from the repo's own
   `package.json`, not hardcoded, so a future rename can't silently desync install/uninstall), only if
   `pnpm` is present on `PATH` — tolerating "not linked" the same way step 1 tolerates "not registered."
3. **Bootout both launchd jobs**: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ajmichels.mnotes.plist`
   and the log-rotation agent's equivalent.
4. **Delete both Property List files**.
5. **Delete Logs directory**.
6. **Delete Application Support directory** (the SQLite index and socket file — safe to delete
   unconditionally since the index is a pure derived cache per S001; nothing here is a data-loss risk,
   a future reinstall's daemon startup just rebuilds it from the vault on first run).
7. **Delete Configuration directory** (`~/.config/mnotes/`).

Never touches the vault itself — uninstalling `mnotes` removes the tool's own state, not your notes.

## Wiring `vault_path`/`db_path` into the daemon, CLI, and MCP server

`src/config.js` existing in isolation isn't enough — something has to actually call `loadConfig()` and
use its result. `src/indexer/daemon.js`'s `main()`, `src/cli/main.js`'s `resolveVaultRoot()`/
`resolveDbPath()`, and `src/mcp/server.js`'s (module-local) `resolveVaultRoot()`/`resolveDbPath()` all
now do exactly that, replacing the `MNOTES_VAULT_ROOT`/`MNOTES_DB_PATH` environment-variable stand-ins
each of S005/S006/S007 introduced with an explicit "stand-in for `config.toml`'s `vault_path` until
S009 lands" comment. Concretely:

- `resolveVaultRoot(config = loadConfig())`/`resolveDbPath(config = loadConfig())` in `cli/main.js` and
  `mcp/server.js` now return `config.vault_path`/`config.db_path` directly — the default parameter
  means a real invocation (`resolveVaultRoot()`, no argument) resolves against the real
  `~/.config/mnotes/config.toml`, while tests pass an explicit plain object
  (`resolveVaultRoot({ vault_path: '/tmp/vault' })`) without touching the filesystem.
- `daemon.js`'s `main()` calls `loadConfig()` once and passes `config.vault_path`/`config.db_path`
  into `startDaemon()`.
- The previous "no `MNOTES_VAULT_ROOT`, hard error" behavior in `cli/main.js`/`mcp/server.js` is gone
  — `vault_path` now always resolves to *something* (the computed `~/Documents/Notes` default at
  minimum), since `config.js`'s `buildDefaultConfig()` guarantees a value even with no `config.toml` on
  disk at all. A vault path that doesn't actually exist on disk still fails, just later and more
  specifically, at the point a `core/` module tries to read/write against it — consistent with "fail
  loudly" (CLAUDE.md), just no longer front-loaded into `resolveVaultRoot()` itself.
- Env-var overrides are gone entirely, not layered on top of `config.toml` — `MNOTES_VAULT_ROOT`/
  `MNOTES_DB_PATH` are no longer read anywhere. This was a clean replacement, not backwards-compatible
  shimming, per the "stand-in... until S009 lands" framing already in the code being replaced.

**Still out of scope, unchanged from before:** the other `config.toml` sections
(`[search]`/`[notes]`/`[grep]`/`[index]`/`[logging]`) are not read by `search.js`/`notes.js`/`grep.js`/
`daemon.js`'s indexing internals/`log-rotator.js` yet — those modules keep using their own hardcoded
`DEFAULT_*` constants, so editing those sections of `config.toml` currently has no effect. Unlike
`vault_path`, none of those gaps are blocking (every one has a working hardcoded default), so this pass
closes only the `vault_path`/`db_path` gap that actually prevented pointing the tool at a real vault.

## Logging

`scripts/install.sh`/`scripts/uninstall.sh` are bash, not Node — they print directly to the terminal
(the "clear warning" for a missing `rg`, the path prompts, the model-download progress message) and
never touch `src/logger.js`, which doesn't exist yet from bash's perspective at install time anyway.
Their one connection to `S008` is purely mechanical: installing the log-rotation LaunchAgent's plist
(step 6) is what makes `src/log-rotator.js`'s already-built `main()` (S008 Task 8) actually run on a
schedule — there's no new logging behavior to design here, just wiring up what S008 shipped.

`src/config.js` is a regular Node module loaded early by every entry point (daemon, CLI, MCP server).
`getContextLogger()` inside `loadConfig()` only actually writes anywhere when the caller has already
established a `runWithLogger` context — true for the daemon (S005), not true for the CLI (S006) or, as
discovered while wiring `resolveVaultRoot()`/`resolveDbPath()` above, the MCP server either: neither
`cli/main.js` nor `mcp/server.js` calls `runWithLogger` anywhere, so `getContextLogger()` resolves to
the silent no-op logger in both. This isn't a `config.js` bug — `getContextLogger()`'s no-op fallback
is deliberate (S008) precisely so a missing context degrades to "no log line," never a crash — but it
does mean the three log lines below are presently observable in `indexer.log` only, not
`mcp-server.log`, contrary to what an earlier draft of this section claimed. Wiring
`mcp/server.js`'s `main()` to establish a `runWithLogger` context is S007's gap to close, not S009's —
flagged here since it surfaced during this section's own work, not fixed as part of it.

- **Config file found and merged** — `debug`, `"loaded config overrides"`, context
  `{ overridden_keys }` (just the key names actually present in `config.toml`, never their values —
  `vault_path`/`db_path` are filesystem locations, not secrets, but there's no reason to echo full
  paths into a log line when the key list alone answers "is my override taking effect").
- **No `config.toml` found** — `debug`, `"no config.toml found, using built-in defaults"`. Not a
  warning — this is the expected, common case per "Install" step 3 above (a user who accepted every
  suggested default ends up with no file at all).
- **Unrecognized key in `config.toml`** (present in the file, not part of the schema on this page) —
  `warn`, `"unrecognized config key"`, context `{ key }` — the one genuinely diagnostic case, since a
  typoed key (e.g. `limt_default`) would otherwise silently fall through to the built-in default with
  no indication the override was ignored.

The CLI is the one entry point where this needs a caveat matching `S006`'s Logging section: the CLI
never establishes a `runWithLogger` context, so all three lines above are no-ops for `mnotes` command
invocations — config still loads and merges correctly, it just doesn't leave a trail. Only the daemon's
config load is actually observable in `indexer.log` today (see above).

## Explicitly out of scope here

- **Exact plist XML contents beyond what's specified in S005 (daemon) and S008 (log-rotation
  schedule)** — implementation detail, not further architectural decisions to make.
- **`pnpm install` / dependency management** — ordinary dev workflow, not part of this spec.
