#!/usr/bin/env bash
# Linux implementation of the os_* contract — see docs/specs/S009-config-and-install.md's "Platform
# abstraction" section. Every function here is Linux-specific; scripts/install.sh and
# scripts/uninstall.sh never branch on OS themselves, they just call these.

os_app_support_dir() {
    echo "${XDG_DATA_HOME:-$HOME/.local/share}/mnotes"
}

os_log_dir() {
    echo "${XDG_STATE_HOME:-$HOME/.local/state}/mnotes/log"
}

os_service_dir() {
    echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
}

os_fswatch_fallback_dir() {
    # Used only when fswatch isn't found at install time, so a later distro-package install (no
    # reinstall) is still picked up without editing the unit file by hand.
    echo "/usr/local/bin"
}

os_watcher_install_hint() {
    echo "install fswatch via your distro's package manager, e.g. apt install fswatch / pacman -S fswatch; on RHEL/CentOS/Rocky/AlmaLinux enable EPEL first (dnf install epel-release fswatch)"
}

os_ripgrep_install_hint() {
    echo "install ripgrep via your distro's package manager, e.g. apt install ripgrep / dnf install ripgrep / pacman -S ripgrep"
}

# Sets LAUNCH_EXECUTABLE. The Background Task Management identity problem macOS's equivalent step
# solves doesn't exist here — a systemd unit's own Description= is its identity, nothing attributes
# it via a launched binary's code signature — so this is just the node binary directly.
os_prepare_launch_executable() {
    local app_support_dir="$1" node_bin="$2" repo_root="$3"
    LAUNCH_EXECUTABLE="$node_bin"
}

# Renders and writes all three unit files. Expects LAUNCH_EXECUTABLE, DAEMON_SCRIPT,
# LOG_ROTATOR_SCRIPT, LOG_DIR, DAEMON_PATH_ENV, NODE_EXTRA_CA_CERTS, REPO_ROOT set by the caller.
# Sets DAEMON_SERVICE_PATH/LOGROTATE_TIMER_PATH for os_enable_services to use.
os_write_service_files() {
    local service_dir="$1"
    mkdir -p "$service_dir"
    local daemon_unit="$service_dir/mnotes.service"
    local logrotate_service="$service_dir/mnotes-logrotate.service"
    local logrotate_timer="$service_dir/mnotes-logrotate.timer"

    _render_unit() {
        sed \
            -e "s#__LAUNCH_EXECUTABLE__#$LAUNCH_EXECUTABLE#g" \
            -e "s#__DAEMON_SCRIPT_PATH__#$DAEMON_SCRIPT#g" \
            -e "s#__LOG_ROTATOR_SCRIPT_PATH__#$LOG_ROTATOR_SCRIPT#g" \
            -e "s#__LOG_DIR__#$LOG_DIR#g" \
            -e "s#__DAEMON_PATH_ENV__#$DAEMON_PATH_ENV#g" \
            -e "s#__NODE_EXTRA_CA_CERTS__#$NODE_EXTRA_CA_CERTS#g" \
            "$1" > "$2"
    }

    _render_unit "$REPO_ROOT/systemd/mnotes.service.template" "$daemon_unit"
    _render_unit "$REPO_ROOT/systemd/mnotes-logrotate.service.template" "$logrotate_service"
    _render_unit "$REPO_ROOT/systemd/mnotes-logrotate.timer.template" "$logrotate_timer"

    systemctl --user daemon-reload

    DAEMON_SERVICE_PATH="$daemon_unit"
    LOGROTATE_TIMER_PATH="$logrotate_timer"
}

os_enable_services() {
    systemctl --user enable --now mnotes.service
    systemctl --user enable --now mnotes-logrotate.timer
    echo "If this machine should keep the daemon running after you log out (e.g. a headless/always-on box), enable lingering: loginctl enable-linger \$(whoami)"
}

os_disable_services() {
    systemctl --user disable --now mnotes.service 2>/dev/null || true
    systemctl --user disable --now mnotes-logrotate.timer 2>/dev/null || true
}

os_remove_service_files() {
    local service_dir
    service_dir="$(os_service_dir)"
    rm -f "$service_dir/mnotes.service" "$service_dir/mnotes-logrotate.service" "$service_dir/mnotes-logrotate.timer"
    systemctl --user daemon-reload
}
