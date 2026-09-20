#!/usr/bin/env bash
# OS-agnostic helpers shared by scripts/install.sh and scripts/uninstall.sh. Nothing in this file
# reads $(uname -s) or otherwise branches on OS — see docs/specs/S009-config-and-install.md's
# "Platform abstraction" section for the fencing rule this file follows.

resolve_path() {
    local raw="$1"
    # Strip a single matching pair of enclosing quotes — typing a quoted path (natural instinct for
    # a path containing spaces) would otherwise leave literal quote characters embedded in the
    # resolved path, since `read` takes the whole line verbatim with no shell-style word splitting.
    case "$raw" in
        \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
        \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    esac
    case "$raw" in
        "~"*) raw="$HOME${raw#\~}" ;;
    esac
    "$NODE_BIN" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$raw"
}

escape_toml_string() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Delegates to src/config.js's own slugifyVaultName/VAULT_NAME_PATTERN (S009) rather than
# reimplementing the rule in bash — one definition of "how a vault name is derived/validated",
# shared by the installer and loadConfig()'s own legacy-flat-config normalization.
slugify_vault_name() {
    "$NODE_BIN" -e "
import('$REPO_ROOT/src/config.js').then((m) => { process.stdout.write(m.slugifyVaultName(process.argv[1])); });
" "$1"
}

is_valid_vault_name() {
    "$NODE_BIN" -e "
import('$REPO_ROOT/src/config.js').then((m) => { process.exit(m.VAULT_NAME_PATTERN.test(process.argv[1]) ? 0 : 1); });
" "$1"
}
