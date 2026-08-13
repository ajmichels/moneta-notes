#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_SERVER_NAME="mnotes"

# --- Step 1: deregister the MCP server from Claude Code -----------------------

if command -v claude >/dev/null 2>&1; then
    claude mcp remove "$MCP_SERVER_NAME" -s user >/dev/null 2>&1 || true
fi

# --- Step 2: unlink the mnotes CLI from PATH -----------------------------------

if command -v pnpm >/dev/null 2>&1; then
    CLI_PACKAGE_NAME="$(node -e "console.log(require('$REPO_ROOT/package.json').name)")"
    pnpm uninstall --global "$CLI_PACKAGE_NAME" >/dev/null 2>&1 || true
fi

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DAEMON_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.plist"
LOGROTATE_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.logrotate.plist"

# --- Step 3: bootout both launchd jobs ---------------------------------------

launchctl bootout "gui/$(id -u)" "$DAEMON_PLIST" 2>/dev/null || true
launchctl bootout "gui/$(id -u)" "$LOGROTATE_PLIST" 2>/dev/null || true

# --- Step 4: delete both plist files -----------------------------------------

rm -f "$DAEMON_PLIST" "$LOGROTATE_PLIST"

APP_SUPPORT_DIR="$HOME/Library/Application Support/mnotes"
LOG_DIR="$HOME/Library/Logs/com.ajmichels.mnotes"
CONFIG_DIR="$HOME/.config/mnotes"

# --- Step 5: delete Logs directory --------------------------------------------

rm -rf "$LOG_DIR"

# --- Step 6: delete Application Support directory -----------------------------

rm -rf "$APP_SUPPORT_DIR"

# --- Step 7: delete Configuration directory -----------------------------------

rm -rf "$CONFIG_DIR"

echo "mnotes uninstall complete. The vault itself was not touched."
