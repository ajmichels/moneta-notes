# S011 — Links

Status: **Approved**
Owns: `src/core/links.js`
Depends on: `S001-data-model`, `S010-shared-utilities`
Consumed by: `S003-notes` (`note_read`'s backlinks/forward-links output, `note_rename`'s link-cascade
rewrite), `S005-indexing-daemon` (link extraction, invoked during reindex, same slot as S004's tag
extraction), `S006-cli` (`mnotes links broken` and `mnotes stats`' `broken_link_count`, both via
`getBrokenLinks`)

## Purpose

Defines Obsidian wikilink extraction, the `note_links` table this feeds (S001), and the two
operations built on top of it: **backlinks** (which notes reference a given note — read-only, index-
backed, surfaced through `note_read`) and the **rename cascade** (rewriting `[[OldTitle]]` occurrences
across the vault when a note is renamed through `note_rename`). This spec owns the parsing/query
primitives; the tool-facing behavior that calls them is specified in S003.

## Wikilink syntax matched

Obsidian's bracket-link forms, all four combinations of an optional heading anchor and an optional
display alias:

```
[[Target]]
[[Target#Heading]]
[[Target|Alias]]
[[Target#Heading|Alias]]
```

Embeds (`![[Target]]`) parse identically — the leading `!` sits outside the `[[...]]` span the regex
below matches, so embeds and plain links are treated the same for backlink/rename purposes with no
separate tracking of which form was used (see "Explicitly out of scope").

Match pattern: `/\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g` — group 1 (trimmed) is the target title,
group 2 (if present) the heading anchor including its `#`, group 3 (if present) the alias including
its `|`. Only group 1 is ever stored or compared; groups 2/3 exist so the rewrite helper below can
preserve them verbatim.

**Code-region exclusion**: matches inside fenced code blocks and inline code spans are excluded, same
rationale as S004's tag scan (a `[[...]]`-shaped string in a code sample isn't a real link). Body text
is run through `core/note-fs.js`'s shared `stripCodeRegions` (S010) before matching — the same
primitive S004's tag extraction now also uses, rather than each module reimplementing the exclusion.

## `extractLinkTargets(body) -> string[]`

Returns the **distinct** set of target titles (group 1, trimmed) found in `body`, order of first
appearance. Distinct because a note either links to a target or it doesn't — `note_links`' composite
primary key (S001) enforces the same collapse at storage time, so extraction and storage agree.

Scans the note **body only**, not frontmatter — wikilinks are a body-content convention in this vault;
a frontmatter property that happens to contain bracket-shaped text (not a documented convention here)
isn't scanned. This mirrors tags' "two sources" design in reverse: tags deliberately merge frontmatter
+ inline because both are real, common ways a tag gets set; links have exactly one real source.

## Storage: `syncNoteLinks(db, noteId, targetTitles)`

```sql
DELETE FROM note_links WHERE source_note_id = ?;
INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?);  -- one per target
```

Delete-then-reinsert, same idempotent-reindex pattern as `note_tags`/`notes_fts` (S001). Simpler than
`syncNoteTags`: there's no shared vocabulary table to upsert into first (`target_title` is stored
directly on the row, per S001's "no `links`-table analogous to `tags`" rationale), so this is a
straight two-statement replace.

Invoked from the per-note reindex step (S005), in the same place S004's tag extraction runs, using the
same freshly-read body.

## Target resolution (S010) — why these queries changed shape

Everything below resolves `target_title` against the vault the same way `note_read`'s own title
lookup does (S003/S010): exact title match, else a unique-basename match, else unresolved. This
matters because a stored `target_title` is raw, as-typed link text (`syncNoteLinks`, above) — it might
already be a full title, or it might be Obsidian's shortest-path short form (`[[Barbara Garn]]` for a
note actually at `LoonStateHockey/JMS Hockey/Barbara Garn`). Comparing it against `notes.path` with a
plain SQL equality/`LEFT JOIN` (this section's original design) gets the short-form case wrong in both
directions — `getBacklinks` misses real backlinks written in short form, and `getBrokenLinks` flags a
perfectly valid short-form link as broken. Fixed by resolving in JS via S010's `buildTitleIndex`/
`resolveAgainstIndex` instead of comparing raw strings in SQL.

## `getBacklinks(db, title) -> string[]`

Builds one `buildTitleIndex(db)` (S010), reads every `note_links` row (joined to its source note's
path), resolves each row's `target_title` against the index, and keeps the source titles where that
resolution equals `title` — deduplicated (a source note can reach `title` via two differently-written
links that both resolve to it, e.g. one short-form and one full-path) and sorted alphabetically. `db`
is required (there's no meaningful "no index" fallback for a bulk query like this) — same optional-
at-the-`noteRead`-call-site, required-once-you're-here shape as before. Still **index-backed**, so it
reflects the vault as of each linking note's last reindex, same freshness contract `search`/
`tag_notes` already have — target resolution is against *current* vault state (S010's index is built
fresh per call), but which notes/links exist at all is still only as fresh as the last reindex.

## `resolveLinkTargets(db, rawTargets) -> string[]`

Maps each raw target string to its resolved absolute title where one resolves, or leaves it as the
raw literal text otherwise (an unresolved or ambiguous link has no better answer to give — same
"don't guess" posture as `resolveAgainstIndex` itself). Builds `buildTitleIndex(db)` once for the
whole batch, not once per target. This is what `note_read`'s `links_out` (S003) is built on: the raw
targets straight from `extractLinkTargets(body)`, resolved through this function when `db` is
available, so that following an outbound link chains straight into another `note_read` call without
Claude needing to reason about whether the link text it saw was already an absolute title.

## `replaceLinkTarget(body, oldTitle, newTitle, { titleIndex = null } = {}) -> { body, count }`

The rewrite primitive `note_rename`'s cascade (S003) calls once per candidate file. Rewrites a
wikilink occurrence when its trimmed target (group 1) is:

- an **exact match** on `oldTitle` — always checked, regardless of `titleIndex`; or
- a match on **`oldTitle`'s basename**, but only when `titleIndex` is provided *and*
  `resolveAgainstIndex(titleIndex, <that basename>) === oldTitle` — i.e. the basename resolves
  uniquely to the note being renamed, not to some other note that happens to share it. Without a
  `titleIndex`, this second check is skipped entirely (no basename-based rewrites), matching the same
  "reduced capability without `db`" shape used elsewhere in this spec.

`titleIndex` must be built (S010's `buildTitleIndex(db)`) **before** the rename's file move, by the
caller — see S003 for why (by the time the cascade runs, `oldTitle` no longer exists on disk, so an
index built afterward could never resolve a basename back to it).

Replaces just the matched target segment with `newTitle`, leaving any heading anchor / alias (groups
2/3) and every other byte of the file untouched. `count` is the number of replacements made (`0` means
`body` is returned unchanged — the caller uses this to decide whether the file needs writing at all).
Also code-region-excluded via `stripCodeRegions`, same as extraction — a `[[OldTitle]]`-shaped string
inside a code block is not a real link and must not be rewritten.

This function and `extractLinkTargets` deliberately share one match pattern (implemented as one
regex constant in `core/links.js`) rather than two independently-maintained ones — a syntax change
(e.g. supporting a new link form later) only needs updating in one place, and extraction/rewrite can
never silently disagree on what counts as a link.

## `getBrokenLinks(db) -> { sourceTitle, targetTitle }[]`

Builds one `buildTitleIndex(db)`, reads every `note_links` row (joined to its source note's path,
ordered by source path then target title), and keeps the rows whose `target_title` doesn't resolve
against the index at all (`resolveAgainstIndex` returns `null` — covering both "no note has this
title or basename" and "ambiguous, multiple notes share this basename," per S010's deliberate
non-distinction between the two). This is the query S001 flagged as "the schema supports this,
nothing surfaces it yet" when `target_title` was designed to store raw text rather than a resolved
`notes.id`. Backs both `mnotes links broken` (S006, the full listing) and `mnotes stats`'
`broken_link_count` (S006, `getBrokenLinks(db).length` — the same function, not a second hand-rolled
query, so the two can never disagree on what counts as broken).

Same staleness contract as `getBacklinks`: index-backed for *which links exist*, current vault state
for *what they resolve to* — not a live vault scan (unlike `note_rename`'s cascade, which deliberately
doesn't use this table for exactly that reason — see S003).

## Case sensitivity

Exact string equality throughout (extraction storage, target resolution, `replaceLinkTarget`'s
exact-match branch) — no case-folding. This is a deliberate departure from Obsidian's own link
resolution, which matches case-insensitively; every *other* title comparison in this codebase
(`titleToPath`, `pathToTitle`, the hash-guarded note tools) is already exact-string, and introducing
case-insensitivity for just this one table would be a new, inconsistent convention for a vault that
(per the README) already follows a consistent Title Case naming discipline. Revisit only if this
causes real missed-backlink/missed-cascade complaints in practice.

## Explicitly out of scope here

- **A standalone MCP tool exposing the raw link graph** (e.g. a `note_links`/`backlinks` tool) —
  backlinks/forward-links surface only as `note_read` output fields (S003). Consistent with CLAUDE.md's
  "don't add MCP resources" stance and this project's minimal-tool-surface bias; a dedicated
  graph-traversal tool is a larger, undesigned feature.
- **Orphan-note reporting** (a note nobody links to) — deliberately not built. Unlike a broken link, a
  zero-backlink note isn't reliably a problem (most notes legitimately have none), so it's a noisy
  signal rather than an actionable one. Revisit only if this turns out to be wanted in practice.
- **Heading-fragment validation** — `#Heading` is preserved verbatim through rename rewrites but never
  parsed against the target note's actual headings or indexed separately. A link to a heading that
  doesn't exist is not detected as an error here (same "not a source of truth, just a cache" posture
  S001 takes toward the rest of this schema).
- **Markdown-style `[text](Title.md)` links** — Obsidian supports this syntax too, but this vault's
  documented convention (README) is wikilinks; extracting a second, differently-shaped link syntax
  adds real complexity for a form not in active use here.
- **How `note_read`/`note_rename` call these functions, and what the tool-facing output/rewrite
  behavior looks like** (including `note_rename`'s vault-wide candidate discovery via `core/grep.js`,
  and the enqueue-for-reindex step after a cascade rewrite) — S003.
