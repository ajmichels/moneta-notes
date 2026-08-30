# Project To-Dos

- Get claude to help define some tests that I can regularly run to check the stability and accuracy
  of the index
- Seems like there should be some kind of "re-install" mechanism to pick up changes that might occur
  as a result of pulling the latest changes from the repo

## Future Features

- additional tooling that can take advantage of Git if the vault is being tracked in a Git repo
  - only enabled when a `.git` directory is detected at/above the vault root
  - `note_history` (CLI + MCP) — read-only git log for a note's path (`--follow` across renames):
    commit hash/date/message list
  - `note_diff` (CLI + MCP) — diff a note's working content against a prior revision or its last
    commit
  - candidates only, not yet speced — needs a real spec (numbering, tool schemas, CLI output format,
    how `note_restore`-type recovery would compose with S003's hash-guard model) before
    implementation
- search results weighting
  - I think weighting results by recency could be really useful
  - having the ability to filter results by a date range could also be really useful
  - notes created after the `created` frontmatter field landed (S003) have a reliable created-at date;
    notes from before that still don't, so this can't assume full coverage yet
- support for linux
