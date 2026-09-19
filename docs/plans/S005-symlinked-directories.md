# Plan: Symlinked-directory indexing (S005)

Disposable execution checklist for implementing the "Symlinked directories" section of
`docs/specs/S005-indexing-daemon.md`. Don't use checkbox state here to judge completion — verify
against the actual repo (code exists, matches the spec, tests pass). Delete this file once that's
true. Background/rationale lives in the spec and in GitHub issue #11 (comment with the scoping
findings) — don't duplicate it here.

TDD per CLAUDE.md: write the test first for each task, watch it fail for the right reason, then
implement. All new tests are colocated in `src/indexer/daemon.test.js`, using real temp
directories/real symlinks (`symlinkSync`) — no mocking the filesystem, matching this file's
existing style (see `watermarkCatchup`'s describe block for the pattern).

## Task 1 — Symlink-aware `walkVaultForMarkdown`

Modify `visitEntry`/`walk` (`src/indexer/daemon.js:326-354`) so a `Dirent` that
`entry.isSymbolicLink()` is no longer silently invisible:

- `realpathSync` + `statSync` the target.
  - Directory → recurse into it via the **symlink's own path** (`full`, not the realpath), so every
    relative path computed under it stays alias-based (`Memory/foo.md`, never a realpath).
  - Regular file → skip (symlinked files aren't indexed — Obsidian doesn't support them).
  - Target doesn't exist (dangling) → catch and skip; must not throw and abort the whole walk.
- Cycle detection: track visited realpaths in a `Set` scoped to one `walkVaultForMarkdown` call, keyed
  each time a directory (real or symlinked) is entered. A symlink whose realpath is already in the set
  is skipped rather than recursed into again.
- `ignoreMatcher` checks apply identically to paths reached through a symlinked directory — no special
  casing needed, since these are still plain vault-relative strings by the time they hit the matcher.

**Tests to add** (`describe('watermarkCatchup')` or a new `describe('walkVaultForMarkdown: symlinks')`
using the existing `makeTempVault`/`writeNote` helpers plus `symlinkSync`):
- a `.md` file inside a symlinked directory gets enqueued under the alias path (`Memory/Note.md`, not
  the realpath).
- a symlinked file (leaf-level) is never enqueued.
- a dangling symlink doesn't throw and is simply absent from results.
- a symlink nested inside another symlinked directory is walked recursively.
- a symlink cycle (directory symlinked to one of its own ancestors) terminates instead of looping.
- `.mnotesignore` patterns still exclude paths reached through a symlinked directory.

## Task 2 — Realpath ↔ alias registry and path rewriting

Add pure, independently-testable functions to `src/indexer/daemon.js`:

- `buildSymlinkRegistry(vaultRoot, ignoreMatcher)` — walks the vault (reuse/extend Task 1's walker
  rather than duplicating traversal logic) and returns every discovered symlinked directory as
  `Map<aliasRelPath, realpath>`, recursively including nested ones.
- `rewriteEventPath(absPath, registry)` — given an absolute path reported by a per-symlink `fswatch`
  child, finds the **longest-matching** realpath prefix in the registry and returns the rewritten
  vault-relative alias path. No match → this is a bug (an event from a watcher whose own registration
  was already torn down, or a genuine logic error) — log at `error` and drop the event rather than
  enqueueing a path that could be a raw realpath (fail loud, per CLAUDE.md, rather than silently
  corrupting `notes.path`).

**Tests**: pure unit tests, no real `fswatch` process needed — synthetic realpaths/registries in,
rewritten alias paths out. Cover: single match, longest-prefix disambiguation when one realpath is a
parent of another watched realpath, and the no-match/drop-and-log case.

## Task 3 — Multi-process watcher lifecycle

Refactor around `spawnFswatch` (`src/indexer/daemon.js:440-452`) and `defaultCreateWatcher`
(`src/indexer/daemon.js:582-617`):

- Call `assertFswatchAvailable()` once at watcher startup, not once per spawned child.
- Factor the "recheck reality after debounce settles" logic (currently inline in
  `defaultCreateWatcher`, `src/indexer/daemon.js:585-598`) into a standalone function both the main
  watcher and every per-symlink watcher call — there should be exactly one implementation of
  "existsSync → enqueue-or-delete", not two copies.
- `defaultCreateWatcher` becomes the orchestrator: builds the initial registry (Task 2), starts the
  main `fswatch -r vaultRoot` process plus one `fswatch -r <realpath>` child per registry entry, each
  piping its `onPath` output through `rewriteEventPath` before it reaches the shared settle logic.
  Track every child (main + N symlink children) so `stop()` kills all of them, not just one.

**Tests**: extend the existing `spawnFswatch (real binary)` integration test
(`src/indexer/daemon.test.js:826`) with an analogous real-binary test that creates a symlinked
directory in a temp vault, starts the full watcher, touches a file inside the **symlink's target**
(not the alias path), and asserts the resulting `index_queue`/`notes` row uses the alias path — this
is the end-to-end proof that the rewrite layer actually works against the real binary, not just
mocked logic. Override `debounceMs` to keep the test fast, matching how other debounce-dependent
tests avoid the real 15s default.

## Task 4 — Live discovery and teardown

Extend Task 3's shared settle-logic function with the branches described in the spec's "Live
discovery and teardown" section:

- Settled path is now a symlink → `realpathSync`/`statSync` target → directory: register (add to
  registry, spawn its `fswatch` child via Task 3's spawn helper, and enqueue its existing contents —
  a scoped call into Task 1's walker rooted at just that alias path); file or dangling: skip, tearing
  down any prior registration at that alias first.
- Settled path no longer exists and was a registered alias → kill its child, remove it (and any
  nested registrations under it) from the registry, and bulk-delete indexed notes under it.
- Add `deleteNotesByPathPrefix(db, aliasPrefix)` next to `deleteNoteByPath`
  (`src/indexer/daemon.js:179`) — select every `notes.path` equal to or starting with
  `${aliasPrefix}/`, and call the existing `deleteNoteByPath` per row rather than duplicating its
  cascade-delete SQL (per CLAUDE.md's no-duplicate-logic rule).

**Tests**: real-binary integration tests (extending Task 3's) covering: creating a new symlinked
directory live (`symlinkSync` after the watcher is already running) results in its contents getting
indexed without a restart; removing a registered symlink live results in its notes being purged and
its child process killed; replacing a symlinked directory in place with a symlinked file (or vice
versa) settles into the correct final state.

## Task 5 — Process resilience (exit handler + respawn)

Add an `'exit'` handler to every spawned `fswatch` child (main and per-symlink alike):

- Guard against reacting to an intentional `stop()`-triggered kill, using the same kind of `stopped`
  boolean `defaultCreateWatcher` already uses for debounce firings after shutdown
  (`src/indexer/daemon.js:589-591`).
- On an unexpected exit, respawn using the **same exponential backoff schedule** the queue drainer
  uses for failed reindex attempts (30s/2m/10m, 4 attempts total) — reuse that schedule/constant
  rather than introducing a second one.
- Before respawning a per-symlink child specifically, recheck its realpath still resolves to a
  directory; if not, route through Task 4's teardown path instead of retrying into certain failure.
- Log per the spec's Logging section additions: `"fswatch watcher exited unexpectedly"` (`warn`, each
  attempt) and `"fswatch watcher permanently failed"` (`error`, backoff exhausted).

**Tests**: inject a fake/killable child process (however the existing test suite fakes `spawn` for
non-real-binary daemon tests — check `startDaemon`'s `createWatcher` injection pattern,
`src/indexer/daemon.test.js:1057+`) to simulate an unexpected exit and assert a respawn attempt
happens on schedule, and that a deliberate `stop()` does **not** trigger a respawn.

## Task 6 — Logging

Add the log lines specified in S005's updated Logging section (`"fswatch watcher started"` now
carrying `watched_path`, `"symlinked directory registered"`, `"symlinked directory removed"`, the two
exit/respawn lines from Task 5) using `getContextLogger()`, matching this file's existing call
pattern (e.g. `src/indexer/daemon.js:368`, `380`).

## Explicitly out of scope for this plan

- **Linux/inotify verification** — the design here is validated against macOS/kqueue only, per the
  spec's platform caveat. Verify empirically before considering this feature done cross-platform, but
  don't block this plan's tasks on setting up Linux CI for it.
- **No CLI/MCP surface changes** — `mnotes reindex` and startup catch-up pick up symlinked content
  automatically via Task 1's walker; no new command, flag, or MCP tool. No `docs/usage.md` update is
  triggered by CLAUDE.md's rules for this reason, though a short mention in the README's feature list
  (symlinked directories are indexed like native vault content) is worth adding once this ships — not
  required by CLAUDE.md's explicit doc-sync triggers, just good practice.
- **Issue #12 (glob-based read-only)** — intentionally not implemented here; the point of this design
  is that it composes with #12 later with no changes needed to this work.
- **A cap on the number of symlinked directories** — explicitly decided against; see the spec's
  Process resilience section for the measured overhead that justified this.
