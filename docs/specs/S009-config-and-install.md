# S009 — Config & Install

Status: **Approved**
Owns: `src/config.js`, `scripts/install.sh`, `scripts/uninstall.sh`, `launchd/*.plist.template`
Depends on: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`,
`S008-logging` (config knobs flagged across all of these land here)

## Purpose

Finalizes `config.toml`'s full shape (collecting every tunable flagged across S002/S003/S004/S005/S008
into one coherent schema), and the install/uninstall flow — now covering **two** LaunchAgents (the
indexing daemon from the README, plus S008's log-rotation agent) instead of one.

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

## Uninstall (`scripts/uninstall.sh`)

1. **Bootout both launchd jobs**: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ajmichels.mnotes.plist`
   and the log-rotation agent's equivalent.
2. **Delete both Property List files**.
3. **Delete Logs directory**.
4. **Delete Application Support directory** (the SQLite index and socket file — safe to delete
   unconditionally since the index is a pure derived cache per S001; nothing here is a data-loss risk,
   a future reinstall's daemon startup just rebuilds it from the vault on first run).
5. **Delete Configuration directory** (`~/.config/mnotes/`).

Never touches the vault itself — uninstalling `mnotes` removes the tool's own state, not your notes.

## Explicitly out of scope here

- **Exact plist XML contents beyond what's specified in S005 (daemon) and S008 (log-rotation
  schedule)** — implementation detail, not further architectural decisions to make.
- **`pnpm install` / dependency management** — ordinary dev workflow, not part of this spec.
