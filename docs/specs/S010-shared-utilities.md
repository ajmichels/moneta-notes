# S010 — Shared Vault-File Utilities

Status: **Approved**
Owns: `src/core/note-fs.js`
Depends on: none
Consumed by: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`, `S006-cli`, and
(once built) `S007-mcp-server`

## Purpose

Small, pure, dependency-free primitives for converting between a note's **title** (the tool-facing
identifier, per CLAUDE.md — "note title is the identifier, never the raw file path") and its
vault-relative file path, and for counting a note body's logical lines. Every `core/` module that
touches a note file needs at least one of these, and — before this spec — each reimplemented its own
copy rather than sharing one. This module exists to hold the one correct implementation so nothing
else has to.

This spec was split out after implementing S006 surfaced two real problems with the un-shared state:

1. **`core/grep.js` counted lines differently from everywhere else.** `core/notes.js`'s line counting
   (used, via `noteRead`/`notes.line_count`, by `search`, `tag_notes`, `stats`, and `read`) counts the
   **frontmatter-stripped body**. `core/grep.js`'s own copy counted the **raw file including
   frontmatter**, with no trailing-newline adjustment. The same note's `file_line_count` therefore
   disagreed depending on which command reported it, for any note with frontmatter and/or a trailing
   newline — a real, user-visible bug, not just latent drift risk. Fixed by making `grep` parse
   frontmatter out (via `gray-matter`, same as `noteRead`) before counting, using this module's shared
   `countLines`.
2. **Title↔path conversion was reimplemented independently in ~5 places** (`core/notes.js`,
   `core/grep.js`, `core/search.js`, `core/tags.js`, `indexer/daemon.js`), one of which
   (`core/grep.js`'s) normalized path separators (`split(sep).join('/')`) that the others didn't — a
   dormant behavioral fork (currently a no-op on this project's macOS-only target, since `sep` is
   already `/`, but still duplicated logic that could silently diverge).

## Contract

- **`titleToPath(vaultRoot, title) -> string`** — `join(vaultRoot, `${title}.md`)`. The one place a
  title becomes a real filesystem path.
- **`pathToTitle(vaultRoot, filePath) -> string`** — the inverse: an **absolute** filesystem path
  (e.g. from a directory walk or a ripgrep match) becomes a title. Normalizes path separators to `/`
  before stripping the `.md` extension, so the result is always identical regardless of platform path
  separator conventions.
- **`stripMdExtension(relativePath) -> string`** — the lower-level primitive `pathToTitle` is built on.
  Callers that already hold a vault-relative path with no need to `relative()`-compute one — most
  commonly the `notes.path` DB column (S001), which is always stored vault-relative with `/`
  separators already (per `indexer/daemon.js`'s `toVaultRelativePath`) — call this directly instead of
  routing through `pathToTitle` with a reconstructed absolute path.
- **`countLines(content) -> number`** — the canonical `file_line_count` semantics used everywhere in
  the tool surface: counts logical lines in a string, without counting a single trailing newline as an
  extra line (`'a\nb\nc\n'` is 3 lines, not 4). **This function is content-shape-agnostic — the caller
  is responsible for passing frontmatter-stripped body content, never raw file bytes.** This matches
  what `notes.line_count` (S001) stores and what `noteRead`'s `total_lines` (S003) returns. Every
  caller of `file_line_count` in the tool surface (`search`, `tag_notes`, `stats`, `read`, `grep`) must
  mean the same thing by it; `core/grep.js` — the one caller reading straight off disk instead of
  through the index — parses frontmatter out via `gray-matter` before calling this, specifically so its
  output means the same thing as every other command's despite `grep` intentionally bypassing the
  index (S004's "operating on the vault directly rather than the index").

**Title is never stored** (S001) — it's always this deterministic, reversible transform over `path`,
never a separately-persisted value that could drift from it.

## Explicitly out of scope here

- **Content hashing** (`hashContent`) — stays in `core/notes.js`. It's a note-*write* concern (content
  integrity for the hash-match guard, S003), not a path/line-counting mechanic every `core/` module
  needs.
- **Anything CLI/MCP-specific** — this module knows nothing about flags, tool schemas, or output
  formatting, same as every other `core/` module (CLAUDE.md).
