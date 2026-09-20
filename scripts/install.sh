#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"

# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
case "$(uname -s)" in
    Darwin) source "$REPO_ROOT/scripts/lib/os-macos.sh" ;;
    Linux)  source "$REPO_ROOT/scripts/lib/os-linux.sh" ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

DEFAULT_VAULT_PATH="$HOME/Documents/Notes"

# --- Step 1: preflight checks -------------------------------------------------

if ! command -v rg >/dev/null 2>&1; then
    echo "WARNING: ripgrep not found — install via \`$(os_ripgrep_install_hint)\` before using \`mnotes grep\`."
fi

if ! command -v fswatch >/dev/null 2>&1; then
    echo "WARNING: fswatch not found — install via \`$(os_watcher_install_hint)\` before starting the indexing daemon (it will crash-loop without it)."
fi

# --- Step 2: prompt for the primary vault's path/name/description/db_path ---
#
# Multi-vault (S009): this installer only ever sets up one vault (the primary one) — adding a
# *second* vault is a manual config.toml edit afterward (see S009's "Multi-vault" section), not a
# second round of these prompts.

# -e enables GNU Readline for these prompts: arrow-key/Home/End cursor movement, working backspace,
# and (readline's default completer) Tab-completion of file paths — typing a wrong character no
# longer means killing the script and starting the whole prompt sequence over.
read -e -r -p "Vault path [$DEFAULT_VAULT_PATH]: " vault_path_input
vault_path_input="${vault_path_input:-$DEFAULT_VAULT_PATH}"
vault_path="$(resolve_path "$vault_path_input")"

default_vault_name="$(slugify_vault_name "$vault_path")"
while true; do
    read -e -r -p "Vault name [$default_vault_name]: " vault_name_input
    vault_name="${vault_name_input:-$default_vault_name}"
    if is_valid_vault_name "$vault_name"; then
        break
    fi
    echo "Vault name must match ^[a-z0-9][a-z0-9_-]*\$ (lowercase letters/digits/underscore/hyphen, not starting with one) — try again."
done

read -e -r -p "Vault description (optional) []: " vault_description

DEFAULT_DB_PATH="$(os_app_support_dir)/index-$vault_name.db"
read -e -r -p "Index DB path [$DEFAULT_DB_PATH]: " db_path_input
db_path_input="${db_path_input:-$DEFAULT_DB_PATH}"
db_path="$(resolve_path "$db_path_input")"

CONFIG_DIR="$HOME/.config/mnotes"
CONFIG_PATH="$CONFIG_DIR/config.toml"

# --- Step 3: create config.toml only if missing -------------------------------
#
# Unlike a single flat override, this step always writes at least [vaults.<name>]'s path (a vault
# needs somewhere to point) plus default_vault = "<name>" explicitly, even when every prompt above
# was accepted as-is — this is what keeps a *second*, later hand-added [vaults.*] table from
# tripping loadConfig()'s "multiple vaults, no default_vault" error (S009).

if [ -e "$CONFIG_PATH" ]; then
    echo "Config file already exists at $CONFIG_PATH — leaving it untouched."
else
    mkdir -p "$CONFIG_DIR"
    {
        echo "default_vault = \"$(escape_toml_string "$vault_name")\""
        echo ""
        echo "[vaults.$vault_name]"
        echo "path = \"$(escape_toml_string "$vault_path")\""
        if [ -n "$vault_description" ]; then
            echo "description = \"$(escape_toml_string "$vault_description")\""
        fi
        if [ "$db_path" != "$DEFAULT_DB_PATH" ]; then
            echo "db_path = \"$(escape_toml_string "$db_path")\""
        fi
    } > "$CONFIG_PATH"
    echo "Wrote $CONFIG_PATH."
fi

APP_SUPPORT_DIR="$(os_app_support_dir)"
LOG_DIR="$(os_log_dir)"

# --- Step 4: app-support directory --------------------------------------------

mkdir -p "$APP_SUPPORT_DIR"

# --- Step 5: logs directory ----------------------------------------------------

mkdir -p "$LOG_DIR"

DAEMON_SCRIPT="$REPO_ROOT/src/indexer/daemon.js"
LOG_ROTATOR_SCRIPT="$REPO_ROOT/src/log-rotator.js"
SERVICE_DIR="$(os_service_dir)"

# --- Step 6: prepare the launch executable ------------------------------------

os_prepare_launch_executable "$APP_SUPPORT_DIR" "$NODE_BIN" "$REPO_ROOT"

# --- Step 7: write the service definition file(s) -----------------------------
#
# Services run with a minimal PATH that omits wherever fswatch was installed — the daemon's own
# fswatch child-process spawn (S005) would fail to find it there even when it's on PATH in every
# interactive shell, so the daemon's service definition gets an explicit PATH prepending fswatch's
# resolved directory (falls back to a per-OS guessed prefix if fswatch isn't installed yet, so a
# later install — no reinstall — is still found without editing the service file by hand).
if command -v fswatch >/dev/null 2>&1; then
    FSWATCH_DIR="$(dirname "$(command -v fswatch)")"
else
    FSWATCH_DIR="$(os_fswatch_fallback_dir)"
fi
DAEMON_PATH_ENV="$FSWATCH_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

# Same PATH-visibility problem, for a different env var: a TLS-intercepting corporate proxy (e.g.
# Zscaler) needs its root CA handed to Node via NODE_EXTRA_CA_CERTS, or the daemon's first-ever
# model download (step 9 below, and any later redownload after a wiped cache) fails with a fetch
# error. Services run with launchd/systemd's own minimal environment, not the interactive shell's —
# they never see a shell rc file's `export NODE_EXTRA_CA_CERTS=...` — so carry forward whatever this
# installer's own environment has at install time, same as the fswatch PATH fix above.
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}"
if [ -n "$NODE_EXTRA_CA_CERTS" ]; then
    echo "Carrying NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS into the daemon's service environment."
fi

os_write_service_files "$SERVICE_DIR"

# --- Step 8: activate both services --------------------------------------------

os_enable_services

# --- Step 9: pre-download the embedding model ---------------------------------

echo "downloading embedding model, this may take a minute..."
"$NODE_BIN" -e "
import('$REPO_ROOT/src/indexer/embed.js').then((m) => m.embed('warm-up')).then(() => {
    console.log('embedding model ready.');
    process.exit(0);
});
"

# --- Step 10: link the mnotes CLI onto PATH via pnpm ---------------------------
#
# `pnpm link --global` was removed in pnpm 11; `pnpm add --global <path>` is the replacement.

if pnpm add --global "$REPO_ROOT"; then
    echo "Linked mnotes/mnotes-mcp/mnotes-indexer onto PATH via pnpm."
else
    echo "WARNING: \`pnpm add --global $REPO_ROOT\` failed — mnotes/mnotes-mcp/mnotes-indexer will not be on PATH. Retry manually with \`pnpm add --global $REPO_ROOT\` once resolved."
fi

# --- Step 11: register the MCP server with Claude Code -------------------------

MCP_SERVER_NAME="mnotes"
MCP_SERVER_SCRIPT="$REPO_ROOT/src/mcp/server.js"

# claude mcp add's -e flags, if any — same NODE_EXTRA_CA_CERTS passthrough as the daemon's service
# environment above, in case Claude Code itself was launched outside a shell that sourced it.
MCP_ENV_ARGS=()
if [ -n "$NODE_EXTRA_CA_CERTS" ]; then
    MCP_ENV_ARGS=(-e "NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS")
fi

if ! command -v claude >/dev/null 2>&1; then
    echo "WARNING: \`claude\` CLI not found — skipping MCP server registration. Run \`claude mcp add $MCP_SERVER_NAME -s user ${MCP_ENV_ARGS[*]:-} -- $NODE_BIN --disable-warning=ExperimentalWarning $MCP_SERVER_SCRIPT\` manually once Claude Code is installed."
elif claude mcp get "$MCP_SERVER_NAME" >/dev/null 2>&1; then
    echo "MCP server \"$MCP_SERVER_NAME\" already registered with Claude Code — leaving it untouched."
else
    claude mcp add "$MCP_SERVER_NAME" -s user "${MCP_ENV_ARGS[@]}" -- "$NODE_BIN" --disable-warning=ExperimentalWarning "$MCP_SERVER_SCRIPT"
    echo "Registered MCP server \"$MCP_SERVER_NAME\" with Claude Code (user scope)."
fi

echo "mnotes install complete."
