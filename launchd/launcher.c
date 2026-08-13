// Thin native launcher for the mnotes background LaunchAgents (indexing daemon, log-rotation).
//
// launchd attributes a background item's "Software from X" identity to the code signature of the
// executable it actually launches — pointing ProgramArguments straight at `node` gets every agent
// attributed to Node.js Foundation's signing identity, not this tool. Compiling this into its own
// ad-hoc-signed binary (wrapped in a minimal .app bundle by scripts/install.sh so Launch Services can
// resolve CFBundleName) gives each agent its own identity instead.
//
// Usage: moneta-notes-launcher <script.js> [args...]
// Execs: <NODE_BIN_PATH> --disable-warning=ExperimentalWarning <script.js> [args...]
// NODE_BIN_PATH is baked in at compile time via -DNODE_BIN_PATH, matching the __NODE_BIN__
// substitution scripts/install.sh already does for the raw-node plist fallback.

#include <stdio.h>
#include <unistd.h>

#ifndef NODE_BIN_PATH
#error "NODE_BIN_PATH must be defined at compile time (-DNODE_BIN_PATH=\"/path/to/node\")"
#endif

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <script.js> [args...]\n", argv[0]);
        return 1;
    }

    char *newArgv[argc + 2];
    int i = 0;
    newArgv[i++] = NODE_BIN_PATH;
    newArgv[i++] = "--disable-warning=ExperimentalWarning";
    for (int j = 1; j < argc; j++) {
        newArgv[i++] = argv[j];
    }
    newArgv[i] = NULL;

    execv(NODE_BIN_PATH, newArgv);
    perror("moneta-notes-launcher: execv failed");
    return 127;
}
