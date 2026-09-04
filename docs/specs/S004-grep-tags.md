# S004 — Grep & Tags

Status: **Approved**
Owns: `src/core/grep.js`, `src/core/tags.js`
Depends on: `S001-data-model`, `S010-shared-utilities`
Consumed by: `S005-indexing-daemon` (tag extraction, invoked during reindex), `S006-cli`,
`S007-mcp-server`

## Purpose

Defines `grep` (a raw-file ripgrep wrapper, operating on the vault directly rather than the index)
and tag handling (extraction from frontmatter + inline `#hashtags`, plus the `tag_list`/`tag_notes`
query tools). These are grouped together because both are small, standalone concerns relative to
S002/S003, not because they're related to each other.

## `grep`

**Input**: `pattern<string>`, `?regex<bool>=false`, `?note_title<string>`, `reason<string>`.
**Output**: `note_title`, `file_line_count`, `line_matches` (per README).

`grep(vaultRoot, pattern, { regex, noteTitle, lineMatchCap, db })` now also accepts an optional `db`
(S010): when `noteTitle` is provided and doesn't exactly match a file, and `db` was passed, it falls
back to `core/note-fs.js`'s `resolveTitle(db, noteTitle)` (exact-then-unique-basename, same as
`note_read`'s title resolution, S003) before erroring "note not found." Without `db`, behavior is
unchanged — exact match only. This is a **read-oriented lookup**, per S010/S003's read/write split:
`grep`'s `note_title` only scopes a search, it never decides what gets written, so it gets the same
fallback `note_read` does, unlike every mutating tool in S003.

`core/grep.js`'s return value always includes each match's line text (`{ line, text }`) — that's
cheap, already parsed out of ripgrep's own JSON output, and `core/` has no opinion on what a caller
does with it. Whether match text actually reaches an output surface is a formatting decision made
above `core/`, per-surface (see S006/S007): the CLI can opt into showing it via a flag, the MCP tool
never does.

### Implementation

- Shells out to a **system-installed `rg` binary** via `child_process` — not an npm-bundled copy.
  This matches the README's tech stack table, which lists ripgrep as an external tool alongside
  `launchd`/`fswatch`, not a dependency. `core/grep.js` checks `rg` is resolvable on `PATH` and throws
  a clear, actionable error ("ripgrep not found — install via `brew install ripgrep`") if not, rather
  than a raw `ENOENT` from the failed spawn.
- Scope: `--glob '*.md'` (or `-t markdown`), restricting matches to note files — attachments/images
  that may exist in the vault aren't notes, and grepping their binary content is meaningless. If
  `note_title` is provided, the search is scoped to that single file's resolved path instead of the
  whole vault — "resolved" per the title-resolution paragraph above, not just a literal join.
- `regex:false` (default) → fixed-string mode (`rg -F`), so a literal search term with regex
  metacharacters (`.`, `(`, `[`, etc.) matches literally rather than throwing a regex-syntax surprise.
- `regex:true` → ripgrep's default regex engine, unmodified.
- **Smart-case** applies in both modes: case-insensitive if the pattern is all-lowercase,
  case-sensitive if it contains any uppercase — ripgrep's own default (`--smart-case`), which matches
  how a search term is naturally typed (typing `api` finds `API`/`Api`/`api`; typing `API`
  specifically narrows to that casing).
- Line-number output is capped at **10 per note**, with a `(+N more)` suffix beyond that — matches
  the README's output example exactly. The cap applies per note row, not to the total number of notes
  returned; the total note count is unbounded (grep is an exhaustive literal-match tool, not a
  relevance-ranked one, so silently dropping matching notes would be surprising for what's meant to be
  a "find everywhere" primitive). The cap (`10`) is a `config.toml` value — flagged for S009.
- `file_line_count` means the same thing here as everywhere else it appears in the tool surface
  (`search`, `tag_notes`, `stats`, `read`): the frontmatter-stripped body's logical line count, per
  `core/note-fs.js`'s `countLines` contract (S010). Since `grep` reads the vault directly rather than
  through the index (this section's opening line), it can't just read `notes.line_count` — it parses
  each matched file's frontmatter out (via `gray-matter`, same as `noteRead`) before counting, so the
  number means the same thing regardless of which command reported it.
- Line numbers inside `line_matches` are ripgrep's own, unadjusted — they count from the top of the
  **raw file on disk** (frontmatter included), since that's what a match's line number means when you
  open the file in an editor. This is intentionally different from `file_line_count` above, which is
  body-only; the two conventions serve different purposes (locating a match on disk vs. reporting the
  note's overall length) and shouldn't be reconciled to match each other.

## Tags

`core/tags.js` owns two things: the extraction function (pure, used by the indexing daemon during
reindex — see S005) and the two read-only query tools (`tag_list`, `tag_notes`).

### Extraction

Tags come from two sources per note, merged into one set with no source distinction (neither
`tag_list` nor `tag_notes` needs to know where a tag came from — see S001):

1. **Frontmatter**: the `tags` array in parsed YAML metadata (`metadata.tags`, already available from
   the frontmatter parse in S003).
2. **Inline `#hashtags`** in the note body, extracted via a scan with these rules (following
   [Obsidian's own tag rules](https://help.obsidian.md/tags) exactly, since these are Obsidian vault
   notes):
   - A `#` starts a candidate tag only if it's at the start of a line or preceded by whitespace/a
     non-word character — never mid-word. A URL fragment like `https://example.com/page#section` is
     safe for this reason alone (the `#` is preceded by the word character `e`), **not** because the
     scan is URL-aware: `https://example.com/#section` has no protection (the `#` is preceded by `/`,
     a non-word character) and is extracted as tag `section`. This matches a known, unfixed Obsidian
     bug (bare URLs with a `#` right after `/` render as a tag there too) — extraction is not made
     smarter than Obsidian here, per the "match Obsidian exactly" rule above.
   - This boundary check is a **zero-width lookbehind**, not a consuming capture group — it must not
     itself consume the separator character between two adjacent tags. `#foo/#bar/#baz` has to yield
     three tags (`foo/`, `bar/`, `baz`); a consuming-group implementation eats the `/` before each
     interior `#` as "part of the previous match," leaving no boundary character available for the
     next `#` and silently dropping every other tag in the run.
   - Valid tag characters after the `#`: Unicode letters (any script), digits, `_`, `-`, and `/` (for
     nesting, e.g. `#project/api-migration`). The tag ends at the first character outside this set
     (typically whitespace or punctuation).
   - The tag must contain **at least one non-numeric character** — `#1984` is not a valid tag (matches
     Obsidian's own rule), `#y1984` is.
   - A tag **starting with `/`** is rejected — Obsidian does not support nested tags beginning with a
     slash (confirmed unsupported by Obsidian's own developers).
   - A trailing or doubled `/` (e.g. `#5/`, `#foo//bar`) is **not** special-cased and is extracted
     as-is. This looks like junk when it comes from adjacent prose issue references (`#5/#6/#7`
     produces tags `5/` and `6/` — the trailing `#7` has no `/` of its own, so it stays a bare
     numeric ref and is rejected by the rule above), but Obsidian itself parses that same text into
     the same trailing-slash tags — extraction mirrors Obsidian's actual (if odd-looking) behavior
     rather than guessing at author intent. A note author who means a literal issue reference, not a
     tag, can either add whitespace around the `/` (`#5 / #6 / #7` — each `#N` then ends at the
     space, leaving a bare numeric ref that the non-numeric-character rule above already rejects) or
     escape the `#` with a backslash (`\#5`), Obsidian's own escape syntax for suppressing
     tag/heading interpretation.
   - Matches inside fenced code blocks (` ``` `) and inline code spans (`` ` ``) are excluded, to
     avoid false positives from shell shebangs (`#!/bin/bash`), CSS hex colors (`#3498db`), or
     comments referencing issue numbers — none of these are tags, and a code-aware personal-notes
     vault will hit these regularly enough that skipping code regions is worth the extra scan logic.

**Changing these rules requires bumping `EXTRACTION_VERSION`** (`indexer/daemon.js`, S005) — a
parsing-logic fix here doesn't touch any note's file content, so `mnotes reindex` would otherwise
skip every already-indexed note (unchanged `content_hash`) and the old, wrong tags would stick around
forever. Bumping the constant is what makes a plain `mnotes reindex` reach them, exactly like bumping
`embed.js`'s embedding version already does for the embedding pipeline.

### Storage

Per S001, `tags.name` is `COLLATE NOCASE` — case-insensitive uniqueness, first-seen casing preserved.
Extraction upserts via `INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING` (the
`NOCASE` collation makes this conflict check case-insensitive), then looks up the row's actual stored
`id`/`name` for the `note_tags` join — so a tag first seen as `#Project` stays `Project` even after a
later note uses `#project`.

`syncNoteTags` prunes orphaned `tags` rows (`pruneOrphanedTags`) after every resync — nothing else
ever deletes from `tags`, so without this a tag's row would outlive every note referencing it,
inflating `mnotes stats`' `tag_count` forever (`tag_list`/`tag_notes` already filter these out via
their join to `note_tags`, so only `stats`' raw `COUNT(*)` was ever affected). `deleteNoteByPath`
(`indexer/daemon.js`) calls the same prune directly, since deleting a note cascades its `note_tags`
rows via FK without going through `syncNoteTags`.

### `tag_list`

**Input**: `reason<string>`. **Output**: `tag<string>`, `notes_with_tag<int>`.

One row per distinct tag (exact string, as stored — nested tags like `project` and
`project/api-migration` are separate rows), with an exact-match count (not rolled up to include
children). This mirrors Obsidian's own tag pane, where nested tags are shown as distinct entries with
their own counts.

### `tag_notes`

**Input**: `tag<string>`, `reason<string>`. **Output**: `note_title<string>`, `file_line_count<int>`.

**Parent-includes-child matching**: `tag_notes("project")` returns notes tagged exactly `project` OR
any nested child (`project/api-migration`, `project/website`, ...) — a case-insensitive prefix match
(`tag = ? OR tag LIKE ? || '/%'`, using the `NOCASE` collation). This matches Obsidian's own
`tags.contains()`/`hasTag()` behavior (nested-tag-aware since Obsidian 1.9.14) and is more useful in
practice than requiring the exact hierarchical string — "show me everything project-related" is the
natural query, not "show me only the bare #project tag."

This is a deliberate asymmetry with `tag_list` (which shows exact-match counts per row, not rolled
up) — `tag_list` is an inventory view of what tags exist, `tag_notes` is a "find everything under
this tag" query. Both are correct for what they're each for.

## Logging

`core/grep.js` calls `getContextLogger()` for the one real failure mode worth a durable trail: `rg` not
resolvable on `PATH` — `warn`, `"ripgrep not found on PATH"`, no context beyond the message itself (no
user input worth capturing; the pattern/query isn't relevant to *why* the binary is missing), logged
immediately before the actionable error throws. Same caveat as `S002`: this only lands anywhere when a
`runWithLogger` context is active, which per `S007` is true for every MCP tool call (`mcp-server.log`)
but per `S006` is never true for the CLI — a CLI-invoked `grep`/`tag_list`/`tag_notes` gets no logging
at all beyond stderr, since neither tool is a mutation and the CLI never establishes a context. On the
MCP side, `S007`'s per-call `logAudit` already captures the same failure's `error_message` in
`audit.log` regardless of this `warn` line — MCP tool calls are audited whether they read or write
(unlike the CLI, which per `S006` only audits mutations).

No successful-call logging for `grep` (a match/no-match result is the normal range of outcomes, not
worth a line per call) and no logging at all in `core/tags.js` — `tag_list`/`tag_notes` have no failure
mode beyond what SQL already throws, and extraction's own notable events (per-note tag counts, parse
issues during a reindex pass) belong to the daemon's reindex summary logging in `S005`, not to the pure
extraction function itself.

## Explicitly out of scope here

- **When/how extraction runs during reindex** (per-note vs. full-vault, idempotency) — S005.
- **CLI-only `--explain` style debug output for grep or tags** — S006, if it ends up needed there at
  all (neither tool has raw scores to hide in the first place, unlike search).
