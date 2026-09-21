# S009 — Config & Install

Status: **Approved**
Owns: `src/config.js`, `src/platform/index.js`, `src/platform/darwin.js`, `src/platform/linux.js`,
`scripts/install.sh`, `scripts/uninstall.sh`, `scripts/lib/common.sh`, `scripts/lib/os-macos.sh`,
`scripts/lib/os-linux.sh`, `launchd/*.plist.template`, `launchd/launcher.c`, `launchd/Info.plist`,
`systemd/*.template`
Depends on: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`, `S006-cli`,
`S007-mcp-server`, `S008-logging`, `S012-attachments` (config knobs flagged across all of these land
here; S005/S006/S008 also consume the platform abstraction defined below for daemon paths, `mnotes
daemon` control, and log-rotation scheduling respectively)

## Purpose

Finalizes `config.toml`'s full shape (collecting every tunable flagged across
S002/S003/S004/S005/S008/S012 into one coherent schema — including **multi-vault support**: naming,
defaulting, and backward compatibility for running more than one vault off a single daemon, see below),
the **cross-platform abstraction** that lets this project run on both macOS and Linux without OS checks
scattered through the codebase, and the install/uninstall flow — now covering **two** background
services (the indexing daemon from the README, plus S008's log-rotation job) instead of one, plus
registering (and deregistering) `mnotes-mcp` as an actual Claude Code MCP server and linking (and
unlinking) the `mnotes` CLI onto `PATH` — rather than leaving either step manual.

## Supported platforms

**macOS (Apple Silicon) and Linux (x86_64 or arm64).** Both run Node natively — there's no WSL-specific
branch, because WSL2 presents a real Linux kernel and userspace to Node, so it's just Linux from this
project's point of view (the daemon's file-watching backend and service-manager assumptions both hold
under WSL2 the same as bare-metal/VM Linux). Anything else (Windows without WSL, BSD, etc.) is
unsupported — `src/platform/index.js` throws rather than silently guessing.

## Platform abstraction: fencing, not branching

The rule this project follows: **OS-specific logic lives in exactly one file per OS, never inline
behind an `if` in a shared file.** A single, small dispatcher per language picks which file runs; every
other file only ever calls the shared, OS-agnostic contract those files both implement. This is
deliberate — the alternative (one `daemon.js`/`install.sh` sprinkled with
`process.platform === 'darwin'` / `case "$(uname -s)" in Darwin)` branches at each divergence point)
makes it easy for the two platforms' logic to silently entangle (a Linux-only fix leaking an assumption
into a shared branch) and hard to see, at a glance, everything a given OS needs. Fencing means adding a
third platform later (or dropping one) is a matter of adding/removing one file that satisfies the
existing contract, not auditing every call site for a missed branch.

### JS layer: `src/platform/`

```
src/platform/index.js   — selects darwin.js or linux.js by process.platform; the ONLY file that reads
                           process.platform. Throws `Unsupported platform: ${process.platform}` for
                           anything else. Re-exports the winner's named exports unchanged.
src/platform/darwin.js  — macOS implementation of the contract below.
src/platform/linux.js   — Linux implementation of the contract below.
```

Both `darwin.js` and `linux.js` export the **same names with the same signatures** — that identical
shape is the contract, enforced by convention (and by every call site working against either one
interchangeably), not by a shared TypeScript interface (this project has no TypeScript, per CLAUDE.md):

| Export | Returns | macOS | Linux |
|---|---|---|---|
| `appSupportDir()` | absolute path | `~/Library/Application Support/mnotes` | `${XDG_DATA_HOME:-~/.local/share}/mnotes` |
| `logDir()` | absolute path | `~/Library/Logs/com.ajmichels.mnotes` | `${XDG_STATE_HOME:-~/.local/state}/mnotes/log` |
| `daemonServiceName()` | string identifier (logging/error messages only) | `com.ajmichels.mnotes` | `mnotes.service` |
| `startDaemonService(deps)` | `Promise<void>` | `launchctl bootstrap gui/<uid> <plist>` | `systemctl --user start mnotes.service` |
| `stopDaemonService(deps)` | `Promise<void>` | `launchctl bootout gui/<uid>/com.ajmichels.mnotes` | `systemctl --user stop mnotes.service` |
| `restartDaemonService(deps)` | `Promise<void>` | `launchctl kickstart -k gui/<uid>/com.ajmichels.mnotes` | `systemctl --user restart mnotes.service` |

`appSupportDir()`/`logDir()` are consumed by `src/logger.js` (`defaultLogDir()`), `src/config.js`
(`defaultDbPath()`), and `src/indexer/daemon.js` (`defaultAppSupportDir()`, hence `defaultSocketPath()`
too) — all four currently hardcode a `~/Library/...` path directly; this spec replaces each with a call
into `src/platform`. `startDaemonService`/`stopDaemonService`/`restartDaemonService` replace the
`launchctl`-shelling logic currently inline in `src/cli/daemon.js` (S006) — that file keeps its
`deps`-injection pattern (an `execFileFn` override for tests) by threading `deps` straight through to
whichever platform module's function it calls, unchanged from today's test-doubling approach.

**`configDir()` (`~/.config/mnotes/config.toml`) deliberately does *not* move into `src/platform`.** It
already resolves identically on both OSes — `~/.config` is a CLI-tool convention this project already
follows on macOS, not a Library-folder concession — so there's nothing to fence. `src/config.js` keeps
computing it directly. Don't "helpfully" route an already-portable path through the platform module
just for symmetry; that would just be indirection with no behavioral payoff.

**fswatch needs no `src/platform` entry at all.** It's a portable CLI binary (kqueue-backed on macOS,
inotify-backed on Linux) already available via both platforms' package managers, and
`src/indexer/daemon.js`'s `spawnFswatch`/`assertFswatchAvailable` shell out to it identically either
way — S005 requires zero code changes for Linux support. Only the install-time "how do I get this"
messaging differs (see Install below), which is a `scripts/lib/os-*.sh` concern, not a JS one.

### Shell layer: `scripts/lib/`

```
scripts/lib/common.sh    — OS-agnostic steps and helpers: resolve_path, escape_toml_string, the
                            vault path/name/description/db_path prompts, config.toml writing, embedding-model
                            pre-download, pnpm global add/uninstall, Claude Code MCP
                            registration/deregistration.
                            Sourced by scripts/install.sh and scripts/uninstall.sh directly.
scripts/lib/os-macos.sh   — macOS implementation of the contract below.
scripts/lib/os-linux.sh   — Linux implementation of the contract below.
```

`scripts/install.sh`/`scripts/uninstall.sh` dispatch once, at the top, via `case "$(uname -s)" in
Darwin) source .../os-macos.sh ;; Linux) source .../os-linux.sh ;; *) echo "unsupported OS: $(uname -s)"
>&2; exit 1 ;; esac` — the only `uname` check in either script. Every step after that calls one of the
functions below; neither script's linear step sequence (see Install/Uninstall) branches on OS again.
Both `os-*.sh` files implement every function, even where one side's implementation is a one-liner (see
`os_prepare_launch_executable` below) — a missing function in one file is a bug, not an intentionally
absent case, so the contract stays a flat list of names both files must define:

| Function | Does | macOS | Linux |
|---|---|---|---|
| `os_app_support_dir` | prints the app-support path | `~/Library/Application Support/mnotes` | `${XDG_DATA_HOME:-$HOME/.local/share}/mnotes` |
| `os_log_dir` | prints the log path | `~/Library/Logs/com.ajmichels.mnotes` | `${XDG_STATE_HOME:-$HOME/.local/state}/mnotes/log` |
| `os_service_dir` | prints the dir service definition files live in | `~/Library/LaunchAgents` | `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user` |
| `os_prepare_launch_executable` | builds/resolves the executable the service(s) launch, sets `LAUNCH_EXECUTABLE` | builds+signs the native launcher bundle, or falls back to a wrapper script (unchanged from today) | one-liner: `LAUNCH_EXECUTABLE="$NODE_BIN"` — no bundle/signing concept exists on this path (see below) |
| `os_write_service_files` | renders and writes both service definitions, given `LAUNCH_EXECUTABLE`, the two script paths, the log dir, and the resolved `fswatch` directory | renders both `.plist.template`s from `launchd/` | renders `mnotes.service`, `mnotes-logrotate.service`, and `mnotes-logrotate.timer` from `systemd/`; also runs `systemctl --user daemon-reload` |
| `os_enable_services` | activates both services persistently | `launchctl bootout gui/<uid> <plist>` ×2 (tolerating "not loaded"), then `bootstrap` ×2 — bootstrapping an already-loaded label fails opaquely, so a re-run always unloads first | `systemctl --user enable --now <unit>` ×2 — already idempotent against a re-run, no bootout-equivalent needed |
| `os_disable_services` | deactivates both services (uninstall) | `launchctl bootout gui/<uid>/<label>` ×2, tolerating "not loaded" | `systemctl --user disable --now <unit>` ×2, tolerating "not loaded" |
| `os_remove_service_files` | deletes the service definition files (uninstall) | `rm -f` both plists | `rm -f` all three unit files, then `systemctl --user daemon-reload` |
| `os_watcher_install_hint` | prints the human-facing install command for the preflight warning | `` `brew install fswatch` `` | generic multi-distro line, no detection (see below) |
| `os_ripgrep_install_hint` | same, for `rg` | `` `brew install ripgrep` `` | generic multi-distro line, no detection (see below) |

These two are plain **hints**, static strings rather than scripts that shell out to detect anything — same posture as the existing macOS `brew` warnings, which never invoke Homebrew on the user's behalf either, and the same one-liner-function simplicity as `os_prepare_launch_executable`'s Linux branch. `os-linux.sh` doesn't attempt to detect which package manager is present and pick a single command; a user running any of these distros already knows which package manager they run and how to use it, so the win from detection logic wouldn't be worth the extra fenced-off code path it'd need. Instead each hint is one static, generic line naming all three:

- `os_ripgrep_install_hint`: `"install ripgrep via your distro's package manager, e.g. apt install ripgrep / dnf install ripgrep / pacman -S ripgrep"` — verified as an official package with no extra repo needed on Debian/Ubuntu (`apt`), Fedora (`dnf`), and Arch (`pacman -S ripgrep`, `extra` repo).
- `os_watcher_install_hint`: `"install fswatch via your distro's package manager, e.g. apt install fswatch / pacman -S fswatch; on RHEL/CentOS/Rocky/AlmaLinux enable EPEL first (dnf install epel-release fswatch)"` — verified as an official package on Debian/Ubuntu (`apt`) and Arch (`pacman -S fswatch`, promoted out of the AUR into `extra`, so no AUR helper is needed) and on plain Fedora (`dnf install fswatch` works directly there); RHEL-family enterprise clones (RHEL/CentOS/Rocky/AlmaLinux, as opposed to Fedora itself) only carry it in EPEL, not the base repos, so the hint calls that out explicitly rather than implying a bare `dnf install fswatch` always works. This distinction is worth keeping in the hint text itself (not just this spec) since "RHEL-based" plausibly means the enterprise clones, not Fedora.

### Concept mapping

| Concept | macOS | Linux |
|---|---|---|
| Service manager | `launchd`, per-user `gui/<uid>` domain | `systemd` user instance, `systemctl --user` |
| Service definition format | one XML plist per service (`ProgramArguments`, `RunAtLoad`, `KeepAlive`, `StartCalendarInterval`) | one `.service` (+ `.timer` for scheduled jobs) `ini`-style unit per service |
| "Keep it running" | `KeepAlive: true` | `Restart=always` |
| "Run at login" | `RunAtLoad: true` | `WantedBy=default.target` + `enable` |
| Log-rotation scheduling | one plist's `StartCalendarInterval` (four fixed times) covers both "what" and "when" | systemd splits it: `mnotes-logrotate.service` (what) triggered by `mnotes-logrotate.timer` (when, via `OnCalendar=`) — see S008 |
| Catch-up after sleep/off | `StartCalendarInterval`'s built-in wake catch-up | `Persistent=true` on the `.timer` unit (functionally equivalent) |
| Background-task identity fix | `launchd/launcher.c` + ad-hoc `codesign`, wrapped in `MonetaNotes.app` — needed because macOS's Background Task Management attributes a LaunchAgent's displayed identity to its launched binary's code signature, which otherwise resolves to Node.js Foundation's | **doesn't exist as a problem.** systemd units carry their own `Description=` string as their identity; nothing attributes identity via a binary's signature, so `ExecStart` just points straight at `node` — no bundle, no signing step, no fallback-wrapper case to speak of |
| `fswatch` PATH visibility | plist's `EnvironmentVariables` dict (services run with a minimal PATH lacking Homebrew's prefix) | unit's `Environment=PATH=...` line (same underlying problem — a systemd user service's default PATH is similarly minimal) |
| TLS-intercepting proxy visibility (e.g. Zscaler) | plist's `EnvironmentVariables` dict carries `NODE_EXTRA_CA_CERTS` | unit's `Environment=NODE_EXTRA_CA_CERTS=...` line (same underlying problem as the PATH row above, for a different env var: a corporate proxy's root CA lands in the OS/browser trust store, but Node's `fetch` doesn't consult it, and neither service sees a shell rc file's `export NODE_EXTRA_CA_CERTS=...` — install.sh carries forward whatever value is in its own environment at install time, empty string if unset, which Node treats as a no-op) |
| Running without an active login session | not supported — LaunchAgents require an active GUI session (`gui/<uid>`) | not supported by default either — a systemd *user* instance normally only runs during an active login session. A headless/always-on Linux box needs `loginctl enable-linger $(whoami)` to keep it running unattended; `scripts/install.sh`'s Linux path prints this as an install-time hint (same "warn and continue" posture as the `rg`/`fswatch` preflight checks), not something it runs automatically |

The native-launcher row is the one place this project has genuinely asymmetric logic, not just a
different implementation of the same idea — Linux's `os_prepare_launch_executable` isn't "the Linux
version of code-signing," it's a no-op, because the problem the launcher solves is macOS-specific from
the ground up. `launchd/launcher.c`, `launchd/Info.plist`, and the `.app`-bundle build step are
macOS-only artifacts with no Linux counterpart.

## `config.toml` schema

```toml
default_vault = "notes"
embedding_model = "Qwen3-Embedding-0.6B"

[vaults.notes]
path = "/Users/aj/Documents/Notes"
description = "Personal notes and knowledge base"

[vaults.dnd]
path = "/Users/aj/Documents/DnD"
description = "D&D campaign notes"

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

[attachments]
max_read_bytes = 10000000    # S012 — attachment_read's include_content size cap

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

Each `[vaults.<name>]` table's `path` is required; `db_path` is optional per vault, defaulting to
`<appSupportDir()>/index-<name>.db` when omitted (`appSupportDir()` per Platform abstraction above —
`index-notes.db`/`index-dnd.db` alongside each other on macOS, same computation under Linux's
`${XDG_DATA_HOME:-~/.local/share}/mnotes/`). `description` is optional free text surfaced by the
`mnotes vaults` CLI command and the MCP `list_vaults` tool (S006/S007) so a caller (human or Claude) can
tell vaults apart by purpose without knowing their on-disk paths. `exclude_from_defaults` is an optional
boolean, defaulting to `false`, that opts a vault out of the cross-vault fan-out described below — see
"Cross-vault fan-out for read/list tools" for its exact effect. `embedding_model` stays a single
top-level value, along with everything under `[search]`/`[notes]`/`[grep]`/`[attachments]`/`[vectors]`/
`[index]`/`[logging]` — there is one shared daemon process and one shared embedding pipeline across
every configured vault (see S005's amendment below), so none of that tuning is per-vault.

### Multi-vault: naming, defaults, and backward compatibility

**Vault names** are TOML table keys under `[vaults.*]`, not a separate `name` field — the key *is* the
identifier a caller passes as `--vault <name>`/the MCP `vault` argument (S006/S007), and it also
determines the derived `db_path` above. Because of both uses, a vault name (whether install-prompted or
hand-written into `config.toml`) must match `^[a-z0-9][a-z0-9_-]*$` — `loadConfig()` throws a specific
error naming the offending key otherwise, per CLAUDE.md's fail-loudly rule, rather than letting an
invalid name silently produce a broken filename or an unparseable CLI argument later.

**`default_vault`** names which configured vault a call resolves to when no `--vault`/`vault` argument
is given. Resolution order, applied once by `resolveVault(config, name)` (`src/config.js`, per the
Wiring section below):

1. An explicit `name` argument always wins, and is a hard error if it doesn't match any configured
   vault (fail loudly, not a silent fallback to the default).
2. Otherwise, `default_vault` if the key is present in `config.toml`.
3. Otherwise, if exactly one vault is configured, that one — this is what makes a single-vault setup
   (the common case) require no `default_vault` key at all.
4. Otherwise (two or more vaults configured, no `default_vault` key) — `resolveVault` throws
   (`"multiple vaults configured (<list>) but no default_vault key — pass name explicitly or set
   default_vault"`), rather than guessing via table order. TOML table order becoming load-bearing for
   something this consequential is exactly the kind of ambiguity CLAUDE.md's fail-loudly rule exists to
   reject.

**This is a call-time error, thrown by `resolveVault` itself — not a `loadConfig()`-time validation.**
A `config.toml` declaring 2+ vaults with no `default_vault` key is entirely valid on its own; whether
it's a problem depends on what's actually called afterward. This matters once "Cross-vault fan-out for
read/list tools" (below) exists: a deliberate no-`default_vault` multi-vault setup is a legitimate
configuration under that design (every fan-out tool — `search`, `grep`, etc. — works with zero
`--vault` needed, covering every vault by default; every single-vault-target tool — `note_read`, the
mutating tools, `stats`, `tag_list`, `metadata_keys` — simply requires an explicit `--vault`/`vault` on
every call, since there's genuinely nothing to default to). Rejecting that shape at `loadConfig()` time,
before anything has actually tried to resolve an ambiguous call, would block a valid setup for reasons
that only apply to some of what it's used for.

**Backward compatibility — the old flat shape is permanently valid input, not a deprecated one.** A
`config.toml` predating this feature has top-level `vault_path`/`db_path` keys and no `[vaults]` table
at all. Per this spec's existing "never touch an existing config.toml" rule, `install.sh` never rewrites
it and no migration step runs — `loadConfig()` (`src/config.js`) instead normalizes it in memory, every
time it loads: if `vault_path` is present and no `[vaults.*]` table exists, it synthesizes a single
vault entry from those two keys (`db_path` defaulting the same way as above if absent) named by
slugifying `vault_path`'s final path segment — lowercase, non-alphanumeric runs collapsed to a single
`-`, leading/trailing `-` trimmed (`~/Documents/Notes` → `"notes"`, `~/Documents/D&D` → `"d-d"`). Since
this produces exactly one vault, resolution rule 3 above makes it the default automatically — an
existing user's config keeps working with zero required edits, and the synthesized name only surfaces
at all in a `mnotes vaults`/`list_vaults` listing, never in a `--vault` flag they'd need to type (there's
nothing else to disambiguate against). A `config.toml` is invalid if it mixes the old flat keys *and* a
`[vaults]` table — `loadConfig()` throws rather than guessing which one wins.

**`config.toml` on disk is a sparse override file, not a full dump.** Every value shown above is also
baked into `src/config.js` as an in-code default (one JS object mirroring this exact schema, with a
single `vaults: { notes: { path: defaultVaultPath() } }` entry and no `default_vault` key — resolution
rule 3 covers it). `src/config.js` deep-merges `~/.config/mnotes/config.toml` (if it exists) over those
built-in defaults — a config file containing only a single overridden vault path is entirely valid,
with every other value falling through to its code-level default. This means a hand-edited `config.toml`
that predates a new tunable being added doesn't need manual updates to pick up the new default (it was
never in the file to begin with), and — per the install flow below — a user who accepts every suggested
default during install ends up with **no config.toml file at all**, since there'd be nothing to
override.

`config.example.toml` still documents the full shape (every key shown, for discoverability, including
the two-vault `[vaults.*]` example above) — documentation only, never copied to produce the real file,
which (if written at all) only ever contains the genuinely-overridden keys per above.

## Install (`scripts/install.sh`)

Assumes `pnpm install` has already been run (dependency installation is a separate, ordinary dev-setup
step, not part of this script) — `pnpm install --prod` is enough for running the installed app, since
step 10's `pnpm add --global` links the CLI to this same `node_modules` rather than resolving its own;
`devDependencies` are only needed if you're modifying the code. Steps, in order:

1. **Preflight check**: `which rg` — if missing, print a clear warning ("ripgrep not found — install
   via `<os_ripgrep_install_hint>` before using `mnotes grep`") and continue (not a hard blocker; every
   other tool still works without it). Same for `fswatch` (`<os_watcher_install_hint>` — see Platform
   abstraction above for both hints' exact wording per OS). Everything from here through step 3 is
   common code in `scripts/lib/common.sh`; step 4 onward starts calling into whichever `os-*.sh` the
   top-of-script dispatch sourced.
2. **Prompt** for the primary vault's `path`, `name`, and `description`, plus `db_path`, each showing
   a **smart suggested default** — `Vault path [~/Documents/Notes]:`, `Vault name [notes]:` (suggested
   by slugifying whatever path was just entered, per the slugify rule below), `Vault description
   (optional):`, and `Index DB path [~/Library/Application Support/mnotes/index-notes.db]:` on macOS or
   `Index DB path [~/.local/share/mnotes/index-notes.db]:` on Linux (via `src/platform`'s
   `appSupportDir()`) — so accepting every default is just pressing Enter four times. No other value is
   prompted for (everything else already has a code-level default, per the schema above); adding a
   *second* vault is a manual `config.toml` edit afterward (see "Multi-vault" above), not a second round
   of install prompts — this keeps install.sh's own flow linear and matches the existing
   sparse-override-file philosophy for every other advanced setting.
   - Whatever the user types for `path`/`db_path` (a bare Enter for the default, a `~`-relative path, or
     a relative path) is **resolved to an absolute path** before use — `~` expanded via `os.homedir()`,
     relative paths resolved via `path.resolve()`. `config.toml` (if written at all) never contains an
     unexpanded `~` or a relative path.
   - `name` is validated against the same `^[a-z0-9][a-z0-9_-]*$` rule `loadConfig()` enforces (see
     "Multi-vault" above) — a re-prompt with the specific rejection reason, not a silent slugify-and-
     continue, since a name typed directly (as opposed to the suggested default, which is already
     slugified) is a deliberate choice worth confirming back.
3. **Create config file** (`~/.config/mnotes/config.toml`) — **only if it doesn't already exist.**
   Unlike a single flat override, this step always writes at least `[vaults.<name>]`'s `path` (a vault
   needs somewhere to point), plus `default_vault = "<name>"` explicitly — set unconditionally on a
   fresh install, per the "first configured vault is the default" rule, rather than left to
   `loadConfig()`'s single-vault fallback (rule 3 above) to infer; this is what keeps a *second*,
   later hand-added `[vaults.*]` table from tripping the "multiple vaults, no default_vault" load
   error, since the key is already there from install. `name`/`db_path`/`description` are included
   only when they differ from their suggested defaults, same sparse-override principle as every other
   key. An existing `config.toml` (e.g. re-running install after an upgrade) is always left completely
   untouched regardless, so a reinstall never silently discards hand-edited tuning values or a
   hand-added second vault.
4. **Create the app-support directory** (`os_app_support_dir`: `~/Library/Application Support/mnotes/`
   on macOS, `${XDG_DATA_HOME:-~/.local/share}/mnotes/` on Linux) — holds each configured vault's
   SQLite index (`index-<name>.db`, schema created by the daemon's own startup sequence per S005, not
   by this script — no duplicate schema-creation logic between install and the daemon) and the single,
   shared S005 Unix socket (`daemon.sock`).
5. **Create the logs directory** (`os_log_dir`: `~/Library/Logs/com.ajmichels.mnotes/` on macOS,
   `${XDG_STATE_HOME:-~/.local/state}/mnotes/log/` on Linux).
6. **Prepare the launch executable** (`os_prepare_launch_executable`):
   - **macOS**: build the native launcher app bundle. Per the Background Task Management identity issue
     above, the attributed identity shows up in both the Login Items & Extensions listing and the
     transient "App Background Activity" notification — pointing `ProgramArguments` straight at `node`
     gets both LaunchAgents (daemon and log-rotation) attributed to Node.js Foundation's signing
     identity, not to `mnotes`. `which clang` — if present (Xcode Command Line Tools; near-universal on
     a dev Mac), compile `launchd/launcher.c` (a ~20-line native launcher that `execv`s `<node>
     --disable-warning=ExperimentalWarning <script> [args...]`, with the `node` path baked in at compile
     time via `-DNODE_BIN_PATH`) into
     `<app-support-dir>/MonetaNotes.app/Contents/MacOS/moneta-notes-launcher`, copy `launchd/Info.plist`
     (static `CFBundleName`/`CFBundleIdentifier` metadata, no templating needed) alongside it as
     `Contents/Info.plist` so Launch Services can resolve a bundle name, then ad-hoc sign the bundle
     (`codesign --sign -` — no paid Apple Developer ID needed, since this binary is compiled and run
     locally, never distributed, so Gatekeeper's quarantine flow never triggers). If `clang` is missing,
     warn (warn-and-continue, naming `xcode-select --install` as the fix) and fall back to writing a
     plain `<app-support-dir>/mnotes-node-wrapper.sh` (`exec node --disable-warning=... "$@"`) instead —
     functionally equivalent (the LaunchAgent still works, warning still suppressed), just without the
     corrected BTM identity.
   - **Linux**: a one-liner — `LAUNCH_EXECUTABLE="$NODE_BIN"`. The BTM identity problem this step solves
     on macOS doesn't exist on Linux (see Concept mapping above), so there's no bundle to build, no
     signing step, and no fallback-wrapper case.
   - Either way, this step's output is a single **launch executable path** that step 7 points the
     daemon's service definition at.
7. **Write the service definition file(s)** (`os_write_service_files`):
   - **macOS**: both Property List files, from templates — the indexing daemon's plist (existing, per
     README) and the log-rotation LaunchAgent's plist (S008: `RunAtLoad: true` + `StartCalendarInterval`
     at `00:00`/`06:00`/`12:00`/`18:00`). Both templates' `ProgramArguments` are `[launch executable from
     step 6, script path]` — two elements, not three — since the `--disable-warning` flag and the real
     `node` path are both already baked into whichever launch executable step 6 produced, rather than
     being separate array entries pointing at `node` directly.
   - **Linux**: three unit files from `systemd/` templates — `mnotes.service` (`ExecStart=<node bin>
     --disable-warning=ExperimentalWarning <daemon.js path>`, `Restart=always`, `RestartSec=5` — without
     an explicit `RestartSec=`, systemd's 100ms default burns through the default 5-starts-per-10s
     `StartLimitBurst`/`StartLimitIntervalSec` in under a second whenever the daemon fails fast (e.g. no
     `fswatch` on `PATH`), landing the unit in `failed (start-limit-hit)` — a state that refuses *any*
     start, manual included, until `systemctl --user reset-failed`; spacing restarts 5s apart keeps it
     under that limit indefinitely instead), `mnotes-logrotate.service`
     (`ExecStart=... <log-rotator.js path>`, no `Restart=` — it's meant to run once per trigger, not stay
     up), and `mnotes-logrotate.timer` (`OnCalendar=*-*-* 00,06,12,18:00:00`, `Persistent=true` — S008).
     All three go under `os_service_dir` (`${XDG_CONFIG_HOME:-~/.config}/systemd/user/`), followed by
     `systemctl --user daemon-reload` so systemd notices the new/changed files.
   - Both OSes' daemon service definition also carries the `fswatch`-directory PATH fix (macOS:
     `EnvironmentVariables` plist dict; Linux: `Environment=PATH=...` unit line — see Concept mapping
     above for why both need it): `FSWATCH_DIR` (resolved via `command -v fswatch`, common to both OSes)
     gets prepended to the service's minimal PATH, rendered into each platform's own format.
   - Same mechanism, for `NODE_EXTRA_CA_CERTS` (see Concept mapping above): if set in install.sh's own
     environment, its value is rendered into the same plist dict / unit `Environment=` line, empty
     string otherwise (a harmless no-op for Node). This is an install-time snapshot, same limitation as
     the PATH fix — changing the value later means re-running `install.sh` to pick it up.
8. **Activate both services** (`os_enable_services`): macOS —
   `launchctl bootout gui/$(id -u) <plist path>` (tolerating "wasn't loaded" — a first-ever install has
   nothing to boot out) then `launchctl bootstrap gui/$(id -u) <plist path>` for both plists. The
   bootout-first step exists because `launchctl bootstrap` on an already-loaded label — which a re-run
   of `install.sh` after a plist change (e.g. a new `EnvironmentVariables` entry, a rebuilt launcher
   binary) always hits — fails with launchd's notoriously unhelpful `Bootstrap failed: 5: Input/output
   error` rather than a clear "already loaded" message; unloading first makes the freshly rendered
   plist actually take effect instead of silently no-op'ing against the stale loaded one. Linux —
   `systemctl --user enable --now <unit>` for both `mnotes.service` and `mnotes-logrotate.timer` (not
   `mnotes-logrotate.service` directly — the timer is what's enabled/persistent; it triggers the service
   on its own schedule). On a headless/always-on box with no login session expected to stay active (see
   Concept mapping above), also print a hint to run `loginctl enable-linger $(whoami)`
   (warn-and-continue, not run automatically).
9. **Pre-download the embedding model**: a one-line pipeline warm-up call (loads the `q8` model per
   the now-created config, triggering `@huggingface/transformers`' download-and-cache) as the final
   step, with a visible "downloading embedding model, this may take a minute..." message — so the
   first real note write after install doesn't stall on a surprise multi-minute download in the middle
   of the daemon's first indexing pass.
10. **Link the CLI onto `PATH`**: `pnpm add --global <repo root>` — this is what actually makes
    `package.json`'s `bin` entries (`mnotes`, `mnotes-mcp`, `mnotes-indexer`) resolve as commands; a
    plain local `pnpm install` (this script's own prerequisite, per the top of this section) never puts
    a package's own `bin` entries on `PATH` on its own, only this or an actual global install does.
    (pnpm 11 removed `pnpm link --global`, which this used to be — `pnpm add --global <path>` is the
    documented replacement and behaves the same way for this use case.) If the command fails (e.g. a
    stale/mismatched global pnpm store on this machine, or a missing `PNPM_HOME` on a distro-packaged
    pnpm that never ran `pnpm setup` — both real, observed failure modes, unrelated to anything this
    script controls), print a warning with the exact command to retry by hand and continue (same "warn
    and continue" posture as step 1's `rg` check) rather than aborting the rest of install over it.
11. **Register the MCP server with Claude Code**: `which claude` — if missing, print a clear warning
    (the same "warn and continue" posture as step 1's `rg` check — Claude Desktop users or anyone
    registering the server by hand don't need the CLI present) naming the manual `claude mcp add`
    command to run later. If `claude` is present, check first via `claude mcp get mnotes` — if it
    already exists (exit `0`), leave it untouched and say so (same never-clobber posture as step 3's
    config file); otherwise register it with
    `claude mcp add mnotes -s user -- <node> --disable-warning=ExperimentalWarning <repo>/src/mcp/server.js`
    (`-s user`: available in every Claude Code session on this machine, not just one project directory
    — matching how the daemon, config, and index are already all machine-level, not project-level,
    resources). This step invokes `node`/the script path directly, not the step 6 launch executable —
    the MCP server is spawned per-session by Claude Code itself, never registered as its own background
    service on either OS, so there's no separate identity to fix here (macOS's BTM concern or otherwise),
    only the same `ExperimentalWarning` suppression already applied everywhere else. This step is
    independent of step 10's `mnotes-mcp` having successfully landed on `PATH` — a step 10 failure
    shouldn't cascade into step 11 also failing. If `NODE_EXTRA_CA_CERTS` is set in install.sh's own
    environment (same check as step 7), it's also passed as `-e NODE_EXTRA_CA_CERTS=...` on this
    `claude mcp add` call — Claude Code may itself have been launched outside a shell that sourced it,
    the same visibility gap the background services have.

On macOS, `launchd/launcher.c` and the two `.plist.template` files use a single shared launcher, not one
compiled binary per agent — the launcher's first argument is always the target script path (`daemon.js`
or `log-rotator.js`), so both plists point `ProgramArguments[1]` at their own script but share
`ProgramArguments[0]` (the same launcher/wrapper path from step 6). On Linux there's no shared-launcher
concept to speak of — each unit's `ExecStart` just names `node` plus its own script path directly, since
step 6 there is a no-op.

## Uninstall (`scripts/uninstall.sh`)

1. **Deregister the MCP server from Claude Code**: `claude mcp remove mnotes -s user`, only if
   `claude` is present on `PATH` — tolerating "not registered" the same way step 3 below tolerates
   "not currently loaded" for the background services, since uninstall must be safe to run even if
   install never got that far (or `claude` was never installed on this machine at all).
2. **Unlink the CLI from `PATH`**: `pnpm uninstall --global <package name>` (read from the repo's own
   `package.json`, not hardcoded, so a future rename can't silently desync install/uninstall), only if
   `pnpm` is present on `PATH` — tolerating "not linked" the same way step 1 tolerates "not registered."
3. **Deactivate both services** (`os_disable_services`): macOS —
   `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ajmichels.mnotes.plist` and the
   log-rotation agent's equivalent, tolerating "not currently loaded." Linux —
   `systemctl --user disable --now mnotes.service` and `mnotes-logrotate.timer`, tolerating "not
   currently loaded/enabled" the same way.
4. **Delete the service definition file(s)** (`os_remove_service_files`): both plists on macOS; all
   three unit files (`mnotes.service`, `mnotes-logrotate.service`, `mnotes-logrotate.timer`) on Linux,
   followed by `systemctl --user daemon-reload` so systemd forgets them.
5. **Delete the logs directory** (`os_log_dir`).
6. **Delete the app-support directory** (`os_app_support_dir` — every configured vault's SQLite index
   and the shared socket file, plus `MonetaNotes.app` on macOS if it was built — safe to delete
   unconditionally since every index is a pure derived cache per S001; nothing here is a data-loss
   risk, a future reinstall's daemon startup just
   rebuilds it from the vault on first run).
7. **Delete Configuration directory** (`~/.config/mnotes/` — identical on both OSes, see Platform
   abstraction above).

Never touches the vault itself — uninstalling `mnotes` removes the tool's own state, not your notes.

## Wiring vaults into the daemon, CLI, and MCP server

`src/config.js` existing in isolation isn't enough — something has to actually call `loadConfig()` and
use its result. `src/indexer/daemon.js`'s `main()`, `src/cli/main.js`'s command handlers, and
`src/mcp/server.js`'s tool dispatch all now do exactly that, replacing the `MNOTES_VAULT_ROOT`/
`MNOTES_DB_PATH` environment-variable stand-ins each of S005/S006/S007 introduced with an explicit
"stand-in for `config.toml`'s `vault_path` until S009 lands" comment. Concretely:

- `src/config.js` exports `resolveVault(config, name = null)`, implementing the resolution order from
  "Multi-vault" above (explicit `name` → `default_vault` → sole vault → throw). It returns
  `{ name, path, dbPath, description }` for one vault — `path`/`dbPath` already absolute, `dbPath`
  already defaulted to `<appSupportDir()>/index-<name>.db` if the config didn't override it. This is
  the one place vault resolution logic lives, per CLAUDE.md's "don't duplicate logic" rule — `cli/
  main.js` and `mcp/tools.js` both call it rather than each re-implementing the fallback order.
  `src/config.js` also exports `listVaults(config)` (`{ name, description, isDefault }[]`, no `path` —
  see S007's `list_vaults` tool for why the path itself is deliberately withheld from that output) for
  the `mnotes vaults`/`list_vaults` surfaces (S006/S007), and `resolveVaultsForQuery(config, name)` for
  the five tools that fan out across every vault instead of resolving to one when `name` is omitted —
  see "Cross-vault fan-out for read/list tools" below.
- **The daemon watches every configured vault, not one.** `daemon.js`'s `main()` calls `loadConfig()`
  once, calls `listVaults(config)` to get every configured vault (not just the default), resolves each
  one fully via `resolveVault(config, name)`, and starts one independent watch-and-drain pipeline per
  vault (its own `fswatch` process, its own `index_queue`-drain loop, its own SQLite connection at its
  own `dbPath`) inside a single daemon process — full details in S005's amendment. The embedding
  pipeline stays a single process-wide singleton shared across every vault's pipeline (S005 already
  lazy-loads/idle-unloads it; nothing here changes that), which is the whole resource-sharing point of
  running one daemon instead of one per vault.
- **The CLI and MCP server resolve one vault per call.** Every vault-scoped CLI command gains an
  optional `--vault <name>` flag; every vault-scoped MCP tool gains an optional `vault<string>`
  argument (S006/S007). Both resolve to a full vault descriptor via `resolveVault(config, name)` —
  `cli/main.js`'s `buildRealDeps()` no longer resolves a single `vaultRoot`/`dbPath` once at startup;
  instead each command handler calls `resolveVault` itself with whatever `--vault` value (or `null`) it
  parsed, and `mcp/tools.js`'s `callTool` wrapper does the same with the tool input's `vault` field
  before invoking the tool's `core/` call. An unresolvable name (per rule 1 above) surfaces as a normal
  thrown error — the CLI's existing `mnotes: <message>` stderr wrapper and the MCP server's existing
  error-passthrough (S007) both already handle an arbitrary thrown `Error` with no new plumbing needed.
- The previous "no `MNOTES_VAULT_ROOT`, hard error" behavior in `cli/main.js`/`mcp/server.js` is gone
  — a vault always resolves to *something* (the computed `~/Documents/Notes` default at minimum) unless
  the caller names an unknown vault explicitly, since `config.js`'s `buildDefaultConfig()` guarantees at
  least one vault even with no `config.toml` on disk at all. A vault path that doesn't actually exist on
  disk still fails, just later and more specifically, at the point a `core/` module tries to read/write
  against it — consistent with "fail loudly" (CLAUDE.md), just no longer front-loaded into
  `resolveVault()` itself.
- Env-var overrides are gone entirely, not layered on top of `config.toml` — `MNOTES_VAULT_ROOT`/
  `MNOTES_DB_PATH` are no longer read anywhere. This was a clean replacement, not backwards-compatible
  shimming, per the "stand-in... until S009 lands" framing already in the code being replaced.

## Cross-vault fan-out for read/list tools

Five tools/commands — `search`, `grep`, `tag_notes`, `metadata_query`, and the CLI-only `links broken`
— treat an omitted vault differently from every other vault-scoped operation: instead of resolving
through `default_vault`, an omitted vault **fans out across every configured vault** and merges the
results, tagging every row with the vault it came from. Everything else stays single-vault-target
(resolved via plain `resolveVault`, per above): `note_read`, every mutating tool, `stats`, `tag_list`,
`metadata_keys`, and `mnotes vectors`. The distinction is whether merging is lossless — `search`/`grep`/
`tag_notes`/`metadata_query`/`links broken` just concatenate independent rows, nothing is lost by
combining them; `tag_list`/`metadata_keys` report counts/examples over what's actually a *separate*
vocabulary per vault (S001), so merging them would blend two unrelated vocabularies into a misleading
combined figure — a future, explicitly-designed per-vault-breakdown report, not a default to reach for
here. `note_read`/the mutating tools operate on exactly one note; picking one arbitrarily across vaults
(or erroring on a same-titled collision) is a worse failure mode than simply requiring an explicit
vault, per CLAUDE.md's hash-guard/fail-loud philosophy already governing every other ambiguity in those
tools. `stats` reports single-vault inventory numbers with no meaningful merged figure without becoming
a different report than what's already specified. `mnotes vectors` already rejects cross-vault
comparison outright (S013) — embeddings from two different vaults' corpora (potentially different
models entirely) have no meaningful relationship to compare.

`links <title>` (the single-note backlinks/forward-links lookup, distinct from `links broken`) is a
single-vault-target command too, resolved the same way `note_read` is — it's about one specific note,
not a corpus-wide list, so fanning it out has the same "which vault's note did you mean" problem
`note_read` has.

`src/config.js` exports `resolveVaultsForQuery(config, name = null)` → `{ vaults: VaultDescriptor[] }`:

- `name` given → `{ vaults: [resolveVault(config, name)] }` — same hard error on an unknown name
  `resolveVault` already has; explicit `--vault`/`vault` always means exactly one target vault, on a
  fan-out tool the same as everywhere else.
- `name` omitted, exactly one vault configured → `{ vaults: [resolveVault(config, null)] }` — identical
  to today's single-vault behavior, byte-for-byte. A single-vault setup (the common case) never
  triggers any of this machinery, regardless of which of the five tools is called.
- `name` omitted, 2+ vaults configured → every configured vault **except one with
  `exclude_from_defaults = true`** in its `[vaults.<name>]` table, in `listVaults`'s existing
  name-sorted order, resolved via `resolveVault(config, v.name)` for each survivor —
  `default_vault` plays no role in this branch at all. This is the one place `resolveVault`'s own
  "ambiguous, no default" error (see "Multi-vault: naming, defaults, and backward compatibility" above)
  is deliberately bypassed: fan-out doesn't need a single answer, so a 2+-vault config with no
  `default_vault` set is a perfectly valid, sometimes deliberate shape under this design (every fan-out
  tool works with zero `--vault` needed; every single-vault-target tool simply requires one explicitly,
  every time). If every configured vault is excluded, the result is an empty vault list — the five
  fan-out tools treat that the same as "target doesn't resolve in any vault" below (empty results, not
  an error), not a special case worth its own error path.

**`exclude_from_defaults` only ever changes what an *omitted* `--vault`/`vault` resolves to.** An
explicit `--vault dnd`/`vault: "dnd"` targets an excluded vault exactly as it would any other — the flag
opts a vault out of the *implicit* multi-vault default, not out of being addressable at all, which is
why it lives in `resolveVaultsForQuery`'s 2+-vault branch and nowhere near `resolveVault` itself. It's
also a no-op in the single-vault-configured branch above: with only one vault, "fan out" and "resolve
that vault" are the same operation, so a lone vault stays reachable with no `--vault` needed even if
someone sets the flag on it — the byte-for-byte backward-compatibility guarantee for single-vault setups
takes precedence over honoring the flag there. `listVaults(config)` surfaces the flag as
`excludedFromDefaults` on each entry (alongside `isDefault`), and `mnotes vaults`/`list_vaults`
(S006/S007) render it as a column/field the same way — an excluded vault is still listed, just marked,
since it remains a fully valid `--vault` target and hiding it from the listing would make it
undiscoverable as one.

**Output shape**: the `vault` field/column is present **exactly when `resolveVaultsForQuery` returned
more than one vault** — i.e., the caller omitted `vault`/`--vault` *and* more than one vault is
configured. An explicit `vault`/`--vault` never adds it (any vault count); a single-vault setup calling
with it omitted never adds it either — every existing single-vault installation's output shape is
completely unchanged by this feature. This mirrors the present-only-when-true convention `readonly`
(S015) and `chunk_line_start`/`chunk_line_end` (S002) already use, rather than introducing a new kind of
conditional field shape.

**Fan-out mechanics**: `cli/main.js`/`mcp/tools.js` (never `core/`, which stays vault-agnostic per
CLAUDE.md) loop over `resolveVaultsForQuery(...).vaults`, opening each vault's own `db` and calling the
exact same `core/` function used today with the exact same options, tagging every returned row with
`vault: name` before concatenating each vault's own result array, in vault order. A target-scoping
input that doesn't resolve in a particular vault during fan-out (e.g. `grep --note=<title>` naming a
title only some vaults have) simply contributes zero rows from that vault, rather than aborting the
whole call — only an explicit single-vault `--vault` call still hard-errors on an unresolvable target,
matching that command's existing single-vault behavior exactly.

There is **no cross-vault merge of scores or ranks** — `search`'s fan-out output is **grouped by vault,
ranked within each** (each vault's own top-`limit` block, back-to-back, in `listVaults` order) rather
than a single globally re-sorted list. RRF/BM25/cosine are all corpus-relative; a fused cross-vault
ordering would imply a comparability those scores don't actually have, and this applies identically
across `fulltext`/`semantic`/`hybrid` mode — none of the three ever attempts a cross-vault comparison
under this design, so there's no mode-specific special case to make. `--limit` (S002) is a **per-vault**
limit under fan-out, exactly as if that vault had been searched alone — total row count scales with
vault count, it is never split across vaults. `--explain`'s fan-out output (S006, CLI-only) is each
vault's own pipeline-summary-line-then-table printed in sequence, one block per vault, rather than an
attempted merge of pipeline summaries that don't describe the same query execution.

**A genuine per-vault failure aborts the whole fan-out call immediately — it never returns a partial
result.** The "target doesn't resolve in this vault" case above (an empty per-vault result) is not a
failure; a real thrown error from a vault's `core/` call (a malformed FTS5 expression, a corrupt index,
etc.) is. Per CLAUDE.md's fail-loud rule against partial/best-effort results, the loop stops at the
first such error and the whole call fails with that error — rows already collected from vaults processed
earlier in the loop are discarded, never returned alongside an error. This is a deliberate difference
from continuing the loop and reporting a mixed success/failure outcome, which would mean Claude or a
script sometimes has to distinguish "these are all the results" from "these are only some of the
results, look at the error too" — a distinction CLAUDE.md's fail-loud philosophy exists specifically to
avoid making a caller reason about.

**Audit logging (S008) for a fan-out MCP tool call reflects this**: on success, one `audit.log` entry
per vault actually delivered results (all of them, since success means every resolved vault was
processed), each carrying that vault's own name — this preserves `mnotes logs --vault=<name>`'s
exact-match filtering with no new parsing logic, at the cost of one call producing multiple audit lines
instead of the usual one. On the abort-on-first-error path above, exactly **one** entry is logged,
naming the vault whose error aborted the call — not one entry per vault attempted, since the vaults that
succeeded before the abort never actually delivered anything to the caller (per "no partial result"
above), so logging them as successes would misrepresent what happened. This is the one case in this
project where a single tool call produces more than one `audit.log` line; every other tool (fan-out or
not) still logs exactly one.

## Wiring `[search]`/`[notes]`/`[grep]`/`[attachments]`/`[index]`/`[logging]` into `core/`, the daemon, and log-rotator

The remaining sections are now read too — no `config.toml` key is decorative. `core/search.js`,
`core/notes.js`, `core/grep.js`, and `core/attachments.js` stay config-ignorant per CLAUDE.md's
architecture rules (they take plain JS options with the same defaults they always had —
`search`/`explainSearch` accept `limitDefault`/`limitMax`/`overfetchMultiplier`/`overfetchCap`/`rrfK`;
`noteWrite`/`noteEdit` accept `sizeDropThreshold`; `grep` already accepted `lineMatchCap`;
`readAttachment` accepts `maxReadBytes`); it's `cli/main.js`, `mcp/tools.js`, `mcp/server.js`, and
`indexer/daemon.js` that call `loadConfig()` and pass the relevant section's values down as options on
every call.

- `cli/main.js`'s `buildRealDeps()` and `mcp/server.js`'s `main()` each call `loadConfig()` once and
  thread the resulting `config` object through `deps.config`, rather than re-reading the file per
  command/tool invocation. `resolveConfig(deps)` (`src/config.js`) reads `deps.config`, falling back to
  `buildDefaultConfig()` when absent — this is what lets test doubles that build a bare `deps` object
  (no `config` field) still exercise the same built-in defaults `config.toml`'s absence would produce,
  without every test having to construct a full config object.
- `[index]`'s `embedding_dtype`/`model_idle_unload_minutes` don't flow through a per-call options
  object like the others — `indexer/embed.js`'s `getSharedEmbedder()` is a lazily-created module-level
  singleton (shared across every `embed()` call in a process). `configureEmbedder(options)` sets the
  options that singleton is created with; every entry point (`daemon.js`, `cli/main.js`,
  `mcp/server.js`'s `main()`s) calls it once, before the first real embed, with
  `dtype: config.index.embedding_dtype` and `idleTimeoutMs: config.index.model_idle_unload_minutes * 60 * 1000`.
- `[index]`'s `debounce_ms` and `retry_backoff_seconds` flow into `startDaemon()`'s `debounceMs`/
  `backoffSchedule` options (the latter converted from the config's seconds to the milliseconds
  `recordFailure` already worked in) — `debounceMs` reaches `createDebouncer` via `defaultCreateWatcher`,
  `backoffSchedule` reaches `recordFailure` via `deps`. `retry_max_attempts` stays derived
  (`backoffSchedule.length + 1`, computed where `recordFailure` already computed it) rather than becoming
  a second, independently-settable knob that could disagree with the array length — the config comment
  ("initial attempt + len(retry_backoff_seconds)") already documented it as derived, not independent.
- `[logging]`'s three keys build the rotation policy object `log-rotator.js`'s `main()` passes to
  `rotateLogDirectory()`, replacing the hardcoded `DEFAULT_ROTATION_POLICY` (still exported, now just a
  fallback for direct `rotateLogDirectory()` callers that don't pass a policy).

## Logging

`scripts/install.sh`/`scripts/uninstall.sh` are bash, not Node — they print directly to the terminal
(the "clear warning" for a missing `rg`, the path prompts, the model-download progress message) and
never touch `src/logger.js`, which doesn't exist yet from bash's perspective at install time anyway.
Their one connection to `S008` is purely mechanical: installing the log-rotation service definition
(step 7 — the LaunchAgent plist on macOS, the `.service`/`.timer` pair on Linux) is what makes
`src/log-rotator.js`'s already-built `main()` (S008 Task 8) actually run on a schedule — there's no new
logging behavior to design here, just wiring up what S008 shipped.

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

- **Exact plist XML / systemd unit-file contents beyond what's specified in S005 (daemon) and S008
  (log-rotation schedule)** — implementation detail, not further architectural decisions to make.
- **`pnpm install` / dependency management** — ordinary dev workflow, not part of this spec.
- **Package availability of the native deps (`sqlite-vec`, `@huggingface/transformers`/
  `onnxruntime-node`) on Linux** — both already publish Linux x86_64/arm64 prebuilt binaries upstream;
  nothing in this project's own code needs to account for that, so it isn't a design decision this spec
  makes.
- **Windows (including non-WSL) support** — not a target platform; `src/platform/index.js` throwing on
  anything other than `darwin`/`linux` is deliberate, not a gap to fill later without a separate
  decision to do so.
