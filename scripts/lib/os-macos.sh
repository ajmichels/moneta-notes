#!/usr/bin/env bash
# macOS implementation of the os_* contract — see docs/specs/S009-config-and-install.md's "Platform
# abstraction" section. Every function here is macOS-specific; scripts/install.sh and
# scripts/uninstall.sh never branch on OS themselves, they just call these.

os_app_support_dir() {
    echo "$HOME/Library/Application Support/mnotes"
}

os_log_dir() {
    echo "$HOME/Library/Logs/com.ajmichels.mnotes"
}

os_service_dir() {
    echo "$HOME/Library/LaunchAgents"
}

os_fswatch_fallback_dir() {
    # Homebrew's two possible install prefixes — used only when fswatch isn't found at install time,
    # so a later `brew install fswatch` (no reinstall) is still picked up without editing the plist.
    echo "/opt/homebrew/bin:/usr/local/bin"
}

os_watcher_install_hint() {
    echo "brew install fswatch"
}

os_ripgrep_install_hint() {
    echo "brew install ripgrep"
}

# Sets LAUNCH_EXECUTABLE. macOS's Background Task Management attributes a LaunchAgent's "Software
# from X" identity to the code signature of the executable ProgramArguments actually launches —
# pointing it straight at node gets both LaunchAgents attributed to Node.js Foundation's signing
# identity, not to mnotes.
os_prepare_launch_executable() {
    local app_support_dir="$1" node_bin="$2" repo_root="$3"
    local app_bundle_dir="$app_support_dir/MonetaNotes.app"
    local launcher_bin="$app_bundle_dir/Contents/MacOS/moneta-notes-launcher"
    local fallback_wrapper="$app_support_dir/mnotes-node-wrapper.sh"

    if command -v clang >/dev/null 2>&1; then
        mkdir -p "$app_bundle_dir/Contents/MacOS"
        cp "$repo_root/launchd/Info.plist" "$app_bundle_dir/Contents/Info.plist"
        clang -O2 -DNODE_BIN_PATH="\"$node_bin\"" -o "$launcher_bin" "$repo_root/launchd/launcher.c"
        codesign --force --sign - "$app_bundle_dir"
        rm -f "$fallback_wrapper"
        LAUNCH_EXECUTABLE="$launcher_bin"
        echo "Built and signed the Moneta Notes launcher app bundle at $app_bundle_dir."
    else
        echo "WARNING: \`clang\` not found — install Xcode Command Line Tools (\`xcode-select --install\`) for background LaunchAgents to be identified as \"Moneta Notes\" instead of \"Node.js Foundation\". Falling back to a plain wrapper script for now."
        cat > "$fallback_wrapper" << EOF
#!/bin/sh
exec "$node_bin" --disable-warning=ExperimentalWarning "\$@"
EOF
        chmod +x "$fallback_wrapper"
        LAUNCH_EXECUTABLE="$fallback_wrapper"
    fi
}

# Renders and writes both plists. Expects LAUNCH_EXECUTABLE, DAEMON_SCRIPT, LOG_ROTATOR_SCRIPT,
# LOG_DIR, DAEMON_PATH_ENV, NODE_EXTRA_CA_CERTS, REPO_ROOT set by the caller. Sets
# DAEMON_SERVICE_PATH/LOGROTATE_SERVICE_PATH for os_enable_services to use.
os_write_service_files() {
    local service_dir="$1"
    mkdir -p "$service_dir"
    local daemon_plist="$service_dir/com.ajmichels.mnotes.plist"
    local logrotate_plist="$service_dir/com.ajmichels.mnotes.logrotate.plist"

    _render_plist() {
        sed \
            -e "s#__LAUNCH_EXECUTABLE__#$LAUNCH_EXECUTABLE#g" \
            -e "s#__DAEMON_SCRIPT_PATH__#$DAEMON_SCRIPT#g" \
            -e "s#__LOG_ROTATOR_SCRIPT_PATH__#$LOG_ROTATOR_SCRIPT#g" \
            -e "s#__LOG_DIR__#$LOG_DIR#g" \
            -e "s#__DAEMON_PATH_ENV__#$DAEMON_PATH_ENV#g" \
            -e "s#__NODE_EXTRA_CA_CERTS__#$NODE_EXTRA_CA_CERTS#g" \
            "$1" > "$2"
    }

    _render_plist "$REPO_ROOT/launchd/com.ajmichels.mnotes.plist.template" "$daemon_plist"
    _render_plist "$REPO_ROOT/launchd/com.ajmichels.mnotes.logrotate.plist.template" "$logrotate_plist"

    DAEMON_SERVICE_PATH="$daemon_plist"
    LOGROTATE_SERVICE_PATH="$logrotate_plist"
}

os_enable_services() {
    # Bootstrapping an already-loaded label (e.g. a re-run of install.sh picking up a changed
    # plist — a new EnvironmentVariables entry, a rebuilt launcher binary) fails with launchd's
    # notoriously unhelpful "Bootstrap failed: 5: Input/output error" rather than a clear "already
    # loaded" message. Boot out first, tolerating "wasn't loaded" on a first-ever install, so the
    # freshly rendered plist always actually takes effect.
    launchctl bootout "gui/$(id -u)" "$DAEMON_SERVICE_PATH" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)" "$LOGROTATE_SERVICE_PATH" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$DAEMON_SERVICE_PATH"
    launchctl bootstrap "gui/$(id -u)" "$LOGROTATE_SERVICE_PATH"
}

os_disable_services() {
    local service_dir
    service_dir="$(os_service_dir)"
    launchctl bootout "gui/$(id -u)" "$service_dir/com.ajmichels.mnotes.plist" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)" "$service_dir/com.ajmichels.mnotes.logrotate.plist" 2>/dev/null || true
}

os_remove_service_files() {
    local service_dir
    service_dir="$(os_service_dir)"
    rm -f "$service_dir/com.ajmichels.mnotes.plist" "$service_dir/com.ajmichels.mnotes.logrotate.plist"
}
