#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_SERVER_NAME="mnotes"

case "$(uname -s)" in
    Darwin) source "$REPO_ROOT/scripts/lib/os-macos.sh" ;;
    Linux)  source "$REPO_ROOT/scripts/lib/os-linux.sh" ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

# --- Step 1: deregister the MCP server from Claude Code -----------------------

if command -v claude >/dev/null 2>&1; then
    claude mcp remove "$MCP_SERVER_NAME" -s user >/dev/null 2>&1 || true
fi

# --- Step 2: unlink the mnotes CLI from PATH -----------------------------------

if command -v pnpm >/dev/null 2>&1; then
    CLI_PACKAGE_NAME="$(node -e "console.log(require('$REPO_ROOT/package.json').name)")"
    pnpm uninstall --global "$CLI_PACKAGE_NAME" >/dev/null 2>&1 || true
fi

# --- Step 3: deactivate both services -------------------------------------------

os_disable_services

# --- Step 4: delete the service definition file(s) ------------------------------

os_remove_service_files

APP_SUPPORT_DIR="$(os_app_support_dir)"
LOG_DIR="$(os_log_dir)"
CONFIG_DIR="$HOME/.config/mnotes"

# --- Step 5: delete the logs directory ------------------------------------------

rm -rf "$LOG_DIR"

# --- Step 6: delete the app-support directory -----------------------------------

rm -rf "$APP_SUPPORT_DIR"

# --- Step 7: delete Configuration directory -------------------------------------

rm -rf "$CONFIG_DIR"

echo "mnotes uninstall complete. The vault itself was not touched."
