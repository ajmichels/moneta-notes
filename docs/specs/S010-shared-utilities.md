# S010 — Shared Vault-File Utilities

Status: **Approved**
Owns: `src/core/note-fs.js`
Depends on: none
Consumed by: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`, `S006-cli`,
`S007-mcp-server`, `S011-links`

## Purpose

Small, dependency-free primitives for converting between a note's **title** (the tool-facing
identifier, per CLAUDE.md — "note title is the identifier, never the raw file path") and its
vault-relative file path, and for counting a note body's logical lines. Every `core/` module that
touches a note file needs at least one of these, and — before this spec — each reimplemented its own
copy rather than sharing one. This module exists to hold the one correct implementation so nothing
else has to.

Originally every function here was pure (no I/O, no `db` argument) — `titleToPath`/`pathToTitle` are
a deterministic string transform, nothing more. **Title resolution** (added below) is the one
deliberate exception: it needs to know what notes currently exist, so it takes a `db` handle and
queries the `notes` table. It still belongs here rather than in a new module, because it's the same
"title ↔ path" concern this spec already owns — see "Title resolution" below for why a second concern
(disambiguating a title Claude didn't get from an authoritative source) needed to join the first
(converting a title Claude already has into a path).

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
  title becomes a real filesystem path. **Throws if the resulting path resolves outside
  `vaultRoot`** (a title containing `../` segments that walk past the vault root, e.g.
  `../../../../tmp/pwned`) — checked via `relative(vaultRoot, candidate)` starting with `..`. Every
  title-taking tool (`note_read`, `note_write`, `note_edit`, `note_append`, `note_rename`, `grep`'s
  `note_title` scope) routes through this function on both the CLI and MCP surfaces, so this is the
  single choke point for vault containment — nothing else needs its own check. This is a
  containment guarantee, not a style rule: it's distinct from the "flat vault structure" convention
  ([S003](S003-notes.md)), which stays intentionally unenforced — a title can still nest into
  arbitrary subfolders, it just can't resolve outside `vaultRoot` entirely.
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

- **`stripCodeRegions(body) -> string`** — blanks out fenced code blocks (` ```...``` `) and inline
  code spans (`` `...` ``), replacing each match with an equal-length run of spaces so every other
  character's offset in the string is preserved (a caller doing offset-based work afterward, e.g.
  matching against the original string's indices, doesn't need to re-map anything). Originally a
  private `stripCode`/`blank` pair inside `core/tags.js` (S004's inline-`#hashtag` scan); pulled out
  here when S011's wikilink extraction needed the exact same exclusion rule (don't treat `[[...]]`
  found inside a fenced block or inline code span as a real link, for the same reason a `#hashtag`
  inside one isn't a real tag) — this is precisely the kind of duplicated-primitive drift this spec
  exists to prevent (see "Purpose" above). `core/tags.js` now imports this instead of keeping its own
  copy.

## Title resolution

`titleToPath` is a literal join — it has no concept of "close enough." That's correct for a title
Claude got from an authoritative source (`search`, `note_read`'s own returned `title`, a prior
mutation's response), which is always the full, unambiguous vault-relative title. It's the wrong
tool for a title Claude got by reading a `[[wikilink]]` out of a note's body: Obsidian's own default
link behavior ("shortest path when possible," verified against Obsidian's docs and `MetadataCache`
resolver behavior) lets `[[Barbara Garn]]` resolve to `LoonStateHockey/JMS Hockey/Barbara Garn` by
matching the note's **basename** (the last path segment — the same value stored in the `id`
frontmatter field, S003) whenever exactly one note in the vault has that basename. A literal
`titleToPath` join can't do that; it just fails with "note not found."

- **`buildTitleIndex(db) -> { byTitle: Set<string>, byBasename: Map<string, string[]> }`** — reads
  every `notes.path`, and for each derives its title (`stripMdExtension`) and basename (the title's
  last `/`-separated segment). `byTitle` is every title, verbatim, for an O(1) exact-match check.
  `byBasename` maps each basename to the list of titles that share it — length 1 means unambiguous,
  length ≥2 means an ambiguous bare reference. Built fresh per call, deliberately not cached: basename
  uniqueness can flip the moment an unrelated note is added or renamed anywhere in the vault, and
  there's no per-note event that would know to invalidate a cached index when that happens elsewhere.
  At this project's scale (S001: "thousands of notes, not millions"), rebuilding it per call is cheap
  enough not to be worth the staleness risk a cache would introduce.
- **`resolveAgainstIndex(index, rawTitle) -> string | null`** — the actual resolution logic, factored
  out from `buildTitleIndex` so a caller resolving *many* raw strings against the same vault snapshot
  (S011's `getBacklinks`/`getBrokenLinks`/`resolveLinkTargets`, `note_rename`'s link cascade) builds
  the index once and reuses it, rather than re-querying `notes` per string. Exact title match wins
  first; otherwise, a unique basename match; otherwise `null` (not found, or ambiguous — this
  function deliberately doesn't distinguish the two, since both mean "don't guess," and Obsidian
  itself has no published, guaranteed tie-break rule for the ambiguous case — see S011 for where that
  research is captured. Not this function's job to invent one).
- **`resolveTitle(db, rawTitle) -> string | null`** — the single-shot convenience wrapper
  (`resolveAgainstIndex(buildTitleIndex(db), rawTitle)`) for a caller that only needs to resolve one
  title, e.g. `note_read`'s own title argument (S003).

**Which tools use this, and which deliberately don't** — this is the load-bearing distinction, not an
implementation detail:

- **Read-oriented lookups get the fallback**: `note_read`'s `note_title` (S003), `grep`'s `note_title`
  scope (S004), the CLI's `links <title>` (S006). Each accepts an optional `db`; without one, behavior
  is unchanged (exact match only) — the fallback is additive, never a behavior change for a caller
  that doesn't pass `db`.
- **Every mutating tool stays exact-match only, with no fallback at all**: `note_write`, `note_edit`,
  `note_append`, `note_rename` (both `old_title` and `new_title`). This is deliberate, not an
  oversight — see S003's "Title resolution and the read/write split" for the reasoning (in short:
  `note_write`'s create-vs-update branch depends on "does this exact title already exist" meaning
  something unambiguous; silently resolving a mutating call to a different note than the one named is
  a much worse failure mode than a read resolving to the wrong note).
- The mechanism that keeps this safe in practice: `note_read` always returns the **resolved** absolute
  title in its `title` field (S003), never an echo of whatever string was passed in. A caller that
  only has an ambiguous reference reads the note first (getting the real title back), then mutates
  using that — it never needs a mutating tool to resolve anything on its behalf.

**Title is never stored** (S001) — it's always this deterministic, reversible transform over `path`,
never a separately-persisted value that could drift from it.

## Explicitly out of scope here

- **Content hashing** (`hashContent`) — stays in `core/notes.js`. It's a note-*write* concern (content
  integrity for the hash-match guard, S003), not a path/line-counting mechanic every `core/` module
  needs.
- **Anything CLI/MCP-specific** — this module knows nothing about flags, tool schemas, or output
  formatting, same as every other `core/` module (CLAUDE.md).
- **Replicating Obsidian's ambiguous-basename tie-break** — deliberately not attempted. Obsidian
  itself doesn't publish or guarantee one (community/developer analysis of its resolver suggests
  something like same-folder-first then alphabetical, but it isn't documented or stable across
  versions), so there's no "correct" behavior to copy. `resolveAgainstIndex` returns `null` for an
  ambiguous match rather than guessing.
