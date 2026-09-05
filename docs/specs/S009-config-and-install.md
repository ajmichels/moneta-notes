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
S002/S003/S004/S005/S008/S012 into one coherent schema), the **cross-platform abstraction** that lets
this project run on both macOS and Linux without OS checks scattered through the codebase, and the
install/uninstall flow — now covering **two** background services (the indexing daemon from the
README, plus S008's log-rotation job) instead of one, plus registering (and deregistering)
`mnotes-mcp` as an actual Claude Code MCP server and linking (and unlinking) the `mnotes` CLI onto
`PATH` — rather than leaving either step manual.

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
                            vault_path/db_path prompts, config.toml writing, embedding-model
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
| `os_enable_services` | activates both services persistently | `launchctl bootstrap gui/<uid> <plist>` ×2 | `systemctl --user enable --now <unit>` ×2 |
| `os_disable_services` | deactivates both services (uninstall) | `launchctl bootout gui/<uid>/<label>` ×2, tolerating "not loaded" | `systemctl --user disable --now <unit>` ×2, tolerating "not loaded" |
| `os_remove_service_files` | deletes the service definition files (uninstall) | `rm -f` both plists | `rm -f` all three unit files, then `systemctl --user daemon-reload` |
| `os_watcher_install_hint` | prints the human-facing install command for the preflight warning | `` `brew install fswatch` `` | generic multi-distro line, no detection (see below) |
| `os_ripgrep_install_hint` | same, for `rg` | `` `brew install ripgrep` `` | generic multi-distro line, no detection (see below) |

These two are plain **hints** — same posture as the existing macOS `brew` warnings, which never invoke Homebrew on the user's behalf either. `os-linux.sh` doesn't attempt to detect which package manager is present and pick a single command; a user running any of these distros already knows which package manager they run and how to use it, so the win from detection logic wouldn't be worth the extra fenced-off code path it'd need. Instead each hint is one static, generic line naming all three:

- `os_ripgrep_install_hint`: `"install ripgrep via your distro's package manager, e.g. apt install ripgrep / dnf install ripgrep / pacman -S ripgrep"` — verified as an official package with no extra repo needed on Debian/Ubuntu (`apt`), Fedora (`dnf`), and Arch (`pacman -S ripgrep`, `extra` repo).
- `os_watcher_install_hint`: `"install fswatch via your distro's package manager, e.g. apt install fswatch / pacman -S fswatch; on RHEL/CentOS/Rocky/AlmaLinux enable EPEL first (dnf install epel-release fswatch)"` — verified as an official package on Debian/Ubuntu (`apt`) and Arch (`pacman -S fswatch`, promoted out of the AUR into `extra`, so no AUR helper is needed) and on plain Fedora (`dnf install fswatch` works directly there); RHEL-family enterprise clones (RHEL/CentOS/Rocky/AlmaLinux, as opposed to Fedora itself) only carry it in EPEL, not the base repos, so the hint calls that out explicitly rather than implying a bare `dnf install fswatch` always works. This distinction is worth keeping in the hint text itself (not just this spec) since "RHEL-based" plausibly means the enterprise clones, not Fedora.

Both hints are static strings, not scripts that shell out to detect anything — same one-liner-function simplicity as `os_prepare_launch_executable`'s Linux branch.

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
| Running without an active login session | not supported — LaunchAgents require an active GUI session (`gui/<uid>`) | not supported by default either — a systemd *user* instance normally only runs during an active login session. A headless/always-on Linux box needs `loginctl enable-linger $(whoami)` to keep it running unattended; `scripts/install.sh`'s Linux path prints this as an install-time hint (same "warn and continue" posture as the `rg`/`fswatch` preflight checks), not something it runs automatically |

The native-launcher row is the one place this project has genuinely asymmetric logic between the two
platforms, not just a different implementation of the same idea — Linux's `os_prepare_launch_executable`
isn't "the Linux version of code-signing," it's a no-op because the problem the launcher solves is
macOS-specific from the ground up. `launchd/launcher.c`, `launchd/Info.plist`, and the `.app`-bundle
build step stay macOS-only artifacts with no parallel structure created on the Linux side.

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

`db_path`'s example above is the **macOS** default (`platform.appSupportDir() + '/index.db'`); on
Linux it's `${XDG_DATA_HOME:-~/.local/share}/mnotes/index.db` — same computation, different
`src/platform` implementation (see Platform abstraction above). `config.example.toml` documents
whichever platform it's generated/checked on; a user on the other OS overriding `db_path` by hand isn't
copying a wrong-OS path from this file's built-in default either way, since an unset `db_path` already
resolves correctly for their own platform.

`vault_path`, `db_path`, and `embedding_model` are the three values already documented in the
README/`config.example.toml`; everything under
`[search]`/`[notes]`/`[grep]`/`[attachments]`/`[index]`/`[logging]` is new, collecting every value
flagged as config-backed across S002-S005/S008/S012.

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
step, not part of this script) — `pnpm install --prod` is enough for running the installed app, since
step 10's `pnpm add --global` links the CLI to this same `node_modules` rather than resolving its own;
`devDependencies` are only needed if you're modifying the code. Steps, in order:

1. **Preflight check**: `which rg` — if missing, print a clear warning ("ripgrep not found — install
   via `<os_ripgrep_install_hint>` before using `mnotes grep`") and continue (not a hard blocker; every
   other tool still works without it). Same for `fswatch` (`<os_watcher_install_hint>` — see Platform
   abstraction above for both hints' exact wording per OS). Everything from here through step 3 is
   common code in `scripts/lib/common.sh`; step 4 onward starts calling into whichever `os-*.sh` the
   top-of-script dispatch sourced.
2. **Prompt** for `vault_path` and `db_path`, each showing a **smart suggested default** computed from
   the current user (via `os.homedir()`) — e.g. `Vault path [~/Documents/Notes]:`, and
   `Index DB path [~/Library/Application Support/mnotes/index.db]:` on macOS or
   `Index DB path [~/.local/share/mnotes/index.db]:` on Linux (via `src/platform`'s `appSupportDir()`)
   — so accepting the default is just pressing Enter. No other value is prompted for (everything else
   already has a code-level default, per the schema above).
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
4. **Create the app-support directory** (`os_app_support_dir`: `~/Library/Application Support/mnotes/`
   on macOS, `${XDG_DATA_HOME:-~/.local/share}/mnotes/` on Linux) — holds the SQLite index (`index.db`,
   schema created by the daemon's own startup sequence per S005, not by this script — no duplicate
   schema-creation logic between install and the daemon) and the S005 Unix socket (`daemon.sock`).
5. **Create the logs directory** (`os_log_dir`: `~/Library/Logs/com.ajmichels.mnotes/` on macOS,
   `${XDG_STATE_HOME:-~/.local/state}/mnotes/log/` on Linux).
6. **Prepare the launch executable** (`os_prepare_launch_executable`):
   - **macOS**: build the native launcher app bundle. macOS's Background Task Management attributes a
     LaunchAgent's "Software from X" identity (both the Login Items & Extensions listing and the
     transient "App Background Activity" notification) to the code signature of the executable
     `ProgramArguments` actually launches — pointing it straight at `node` gets both LaunchAgents
     attributed to Node.js Foundation's signing identity, not to `mnotes`. `which clang` — if present
     (Xcode Command Line Tools; near-universal on a dev Mac), compile `launchd/launcher.c` (a ~20-line
     native launcher that `execv`s `<node> --disable-warning=ExperimentalWarning <script> [args...]`,
     with the `node` path baked in at compile time via `-DNODE_BIN_PATH`) into
     `<app-support-dir>/MonetaNotes.app/Contents/MacOS/moneta-notes-launcher`, copy `launchd/Info.plist`
     (static `CFBundleName`/`CFBundleIdentifier` metadata, no templating needed) alongside it as
     `Contents/Info.plist` so Launch Services can resolve a bundle name, then ad-hoc sign the bundle
     (`codesign --sign -` — no paid Apple Developer ID needed, since this binary is compiled and run
     locally, never distributed, so Gatekeeper's quarantine flow never triggers). If `clang` is missing,
     warn (same "warn and continue" posture as step 1's `rg` check, naming `xcode-select --install` as
     the fix) and fall back to writing a plain `<app-support-dir>/mnotes-node-wrapper.sh`
     (`exec node --disable-warning=... "$@"`) instead — functionally equivalent (the LaunchAgent still
     works, warning still suppressed), just without the corrected BTM identity.
   - **Linux**: a one-liner — `LAUNCH_EXECUTABLE="$NODE_BIN"`. The Background Task Management identity
     problem this step solves on macOS doesn't exist on Linux (see Platform abstraction above): a
     systemd unit's own `Description=` is its identity, nothing attributes it via a launched binary's
     code signature, so there's no bundle to build, no signing step, and no fallback-wrapper case.
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
   - Both OSes' daemon service definition also carries the `fswatch`-directory PATH fix from the
     existing behavior below (macOS: `EnvironmentVariables` plist dict; Linux: `Environment=PATH=...`
     unit line) — services on both platforms run with a minimal PATH that omits wherever `fswatch` was
     installed, so `FSWATCH_DIR` (resolved via `command -v fswatch`, common to both OSes) gets prepended
     either way, just rendered into each platform's own format.
8. **Activate both services** (`os_enable_services`): macOS —
   `launchctl bootstrap gui/$(id -u) <plist path>` for both plists. Linux —
   `systemctl --user enable --now <unit>` for both `mnotes.service` and `mnotes-logrotate.timer` (not
   `mnotes-logrotate.service` directly — the timer is what's enabled/persistent; it triggers the service
   on its own schedule). On a machine with no active login session expected to stay logged in (a
   headless/always-on box), also print a hint to run `loginctl enable-linger $(whoami)` — without it, a
   `systemd --user` instance (and everything in it) stops when the last session for that user ends, the
   same restriction a macOS LaunchAgent has under `gui/<uid>` needing an active GUI session; this is
   informational only, same "warn and continue" posture as the `rg`/`fswatch`/`clang` checks, not
   something this script runs on the user's behalf.
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
    shouldn't cascade into step 11 also failing.

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
6. **Delete the app-support directory** (`os_app_support_dir` — the SQLite index and socket file, plus
   `MonetaNotes.app` on macOS if it was built — safe to delete unconditionally since the index is a pure
   derived cache per S001; nothing here is a data-loss risk, a future reinstall's daemon startup just
   rebuilds it from the vault on first run).
7. **Delete Configuration directory** (`~/.config/mnotes/` — identical on both OSes, see Platform
   abstraction above).

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
