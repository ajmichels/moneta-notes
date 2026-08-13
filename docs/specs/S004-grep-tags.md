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
  whole vault.
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
     non-word character (never mid-word, and never a URL fragment like
     `https://example.com/page#section` — the `#` there is preceded by a word character).
   - Valid tag characters after the `#`: Unicode letters (any script), digits, `_`, `-`, and `/` (for
     nesting, e.g. `#project/api-migration`). The tag ends at the first character outside this set
     (typically whitespace or punctuation).
   - The tag must contain **at least one non-numeric character** — `#1984` is not a valid tag (matches
     Obsidian's own rule), `#y1984` is.
   - Matches inside fenced code blocks (` ``` `) and inline code spans (`` ` ``) are excluded, to
     avoid false positives from shell shebangs (`#!/bin/bash`), CSS hex colors (`#3498db`), or
     comments referencing issue numbers — none of these are tags, and a code-aware personal-notes
     vault will hit these regularly enough that skipping code regions is worth the extra scan logic.

### Storage

Per S001, `tags.name` is `COLLATE NOCASE` — case-insensitive uniqueness, first-seen casing preserved.
Extraction upserts via `INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING` (the
`NOCASE` collation makes this conflict check case-insensitive), then looks up the row's actual stored
`id`/`name` for the `note_tags` join — so a tag first seen as `#Project` stays `Project` even after a
later note uses `#project`.

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
