# Note Versioning

Version-controlling the **notes vault** (as distinct from this code repository, covered in
[Contributing](../CONTRIBUTING.md)) is out of scope for `mnotes` itself — the tool has no opinion on
how or whether you back up or version your notes, and doesn't require any particular setup to
function.

That said, it's **strongly recommended** to put the vault under some form of version control, since
`note_write`/`note_edit`'s write-safety guards (hash checks, size-drop guard — see
[S003](specs/S003-notes.md)) are deliberately *preventive* rather than exhaustive: they catch the
common failure modes (stale writes, accidental truncation) but aren't a substitute for being able to
recover a prior version of a note from history.

## One approach: `gitwatch` + a bare offsite copy

This isn't the only option, but it's a low-effort one worth calling out. `gitwatch` runs as a
separate process, watching the vault directory and auto-committing on file change (debounced via
`-s`) — this covers manual edits, MCP writes, and anything else that touches the files, with zero
manual commit steps. It can also push to a local bare repository, in turn backed up to a
cloud-synced location (e.g. OneDrive/Dropbox).

If you go this route, one thing worth getting right:

- **Keep `.git` internals out of any cloud-synced folder.** Rapid small writes to `.git/index` and
  object files are exactly the kind of mid-write state a sync client can corrupt. Keep the live repo
  fully local, and only put a **bare** repo (packfiles, no working tree, no lock-file churn) in the
  synced location as the offsite copy.

Whatever mechanism you choose, `gitwatch` (or any other auto-commit tool) should never be pointed at
the `moneta-notes` code repository itself — this repo is developed and committed normally by hand.
