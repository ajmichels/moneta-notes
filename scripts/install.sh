#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"

DEFAULT_VAULT_PATH="$HOME/Documents/Notes"
DEFAULT_DB_PATH="$HOME/Library/Application Support/mnotes/index.db"

# --- Step 1: preflight check -------------------------------------------------

if ! command -v rg >/dev/null 2>&1; then
    echo "WARNING: ripgrep not found — install via \`brew install ripgrep\` before using \`mnotes grep\`."
fi

# --- Step 2: prompt for vault_path / db_path, resolve to absolute paths -----

resolve_path() {
    local raw="$1"
    case "$raw" in
        "~"*) raw="$HOME${raw#\~}" ;;
    esac
    "$NODE_BIN" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$raw"
}

read -r -p "Vault path [$DEFAULT_VAULT_PATH]: " vault_path_input
vault_path_input="${vault_path_input:-$DEFAULT_VAULT_PATH}"
vault_path="$(resolve_path "$vault_path_input")"

read -r -p "Index DB path [$DEFAULT_DB_PATH]: " db_path_input
db_path_input="${db_path_input:-$DEFAULT_DB_PATH}"
db_path="$(resolve_path "$db_path_input")"

CONFIG_DIR="$HOME/.config/mnotes"
CONFIG_PATH="$CONFIG_DIR/config.toml"

# --- Step 3: create config.toml only if missing AND something differs -------

escape_toml_string() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ -e "$CONFIG_PATH" ]; then
    echo "Config file already exists at $CONFIG_PATH — leaving it untouched."
else
    overrides=""
    if [ "$vault_path" != "$DEFAULT_VAULT_PATH" ]; then
        overrides="${overrides}vault_path = \"$(escape_toml_string "$vault_path")\"\n"
    fi
    if [ "$db_path" != "$DEFAULT_DB_PATH" ]; then
        overrides="${overrides}db_path = \"$(escape_toml_string "$db_path")\"\n"
    fi

    if [ -n "$overrides" ]; then
        mkdir -p "$CONFIG_DIR"
        printf '%b' "$overrides" > "$CONFIG_PATH"
        echo "Wrote $CONFIG_PATH with the overridden default(s)."
    else
        echo "All defaults accepted — no config.toml written."
    fi
fi

APP_SUPPORT_DIR="$HOME/Library/Application Support/mnotes"
LOG_DIR="$HOME/Library/Logs/com.ajmichels.mnotes"

# --- Step 4: Application Support directory -----------------------------------

mkdir -p "$APP_SUPPORT_DIR"

# --- Step 5: Logs directory ---------------------------------------------------

mkdir -p "$LOG_DIR"

DAEMON_SCRIPT="$REPO_ROOT/src/indexer/daemon.js"
LOG_ROTATOR_SCRIPT="$REPO_ROOT/src/log-rotator.js"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DAEMON_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.plist"
LOGROTATE_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.logrotate.plist"

# --- Step 6: render both plists from templates --------------------------------

render_plist() {
    local template="$1" dest="$2"
    sed \
        -e "s#__NODE_BIN__#$NODE_BIN#g" \
        -e "s#__DAEMON_SCRIPT_PATH__#$DAEMON_SCRIPT#g" \
        -e "s#__LOG_ROTATOR_SCRIPT_PATH__#$LOG_ROTATOR_SCRIPT#g" \
        -e "s#__LOG_DIR__#$LOG_DIR#g" \
        "$template" > "$dest"
}

mkdir -p "$LAUNCH_AGENTS_DIR"
render_plist "$REPO_ROOT/launchd/com.ajmichels.mnotes.plist.template" "$DAEMON_PLIST"
render_plist "$REPO_ROOT/launchd/com.ajmichels.mnotes.logrotate.plist.template" "$LOGROTATE_PLIST"

# --- Step 7: bootstrap both launchd jobs --------------------------------------

launchctl bootstrap "gui/$(id -u)" "$DAEMON_PLIST"
launchctl bootstrap "gui/$(id -u)" "$LOGROTATE_PLIST"

# --- Step 8: pre-download the embedding model ---------------------------------

echo "downloading embedding model, this may take a minute..."
"$NODE_BIN" -e "
import('$REPO_ROOT/src/indexer/embed.js').then((m) => m.embed('warm-up')).then(() => {
    console.log('embedding model ready.');
    process.exit(0);
});
"

# --- Step 9: link the mnotes CLI onto PATH via pnpm ---------------------------

if pnpm link --global -C "$REPO_ROOT"; then
    echo "Linked mnotes/mnotes-mcp/mnotes-indexer onto PATH via pnpm."
else
    echo "WARNING: \`pnpm link --global\` failed — mnotes/mnotes-mcp/mnotes-indexer will not be on PATH. Retry manually with \`pnpm link --global -C $REPO_ROOT\` once resolved."
fi

# --- Step 10: register the MCP server with Claude Code -------------------------

MCP_SERVER_NAME="mnotes"
MCP_SERVER_SCRIPT="$REPO_ROOT/src/mcp/server.js"

if ! command -v claude >/dev/null 2>&1; then
    echo "WARNING: \`claude\` CLI not found — skipping MCP server registration. Run \`claude mcp add $MCP_SERVER_NAME -s user -- $NODE_BIN --disable-warning=ExperimentalWarning $MCP_SERVER_SCRIPT\` manually once Claude Code is installed."
elif claude mcp get "$MCP_SERVER_NAME" >/dev/null 2>&1; then
    echo "MCP server \"$MCP_SERVER_NAME\" already registered with Claude Code — leaving it untouched."
else
    claude mcp add "$MCP_SERVER_NAME" -s user -- "$NODE_BIN" --disable-warning=ExperimentalWarning "$MCP_SERVER_SCRIPT"
    echo "Registered MCP server \"$MCP_SERVER_NAME\" with Claude Code (user scope)."
fi

echo "mnotes install complete."
