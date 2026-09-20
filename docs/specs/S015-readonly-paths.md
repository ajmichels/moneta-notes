# S015 — Read-only Paths

Status: **Approved**
Owns: nothing exclusively — this is a cross-cutting behavioral contract, not a new source file
Amends: `S002-search`, `S003-notes`, `S004-grep-tags`, `S006-cli`, `S007-mcp-server`,
`S010-shared-utilities`, `S012-attachments`, `S014-metadata-search`
Depends on: `S010-shared-utilities`
Consumed by: `S002-search`, `S003-notes`, `S004-grep-tags`, `S006-cli`, `S007-mcp-server`,
`S012-attachments`, `S014-metadata-search`

## Purpose

[#12](https://github.com/ajmichels/moneta-notes/issues/12) asks for a way to flag files/directories
read-only by glob pattern, so an agent or the CLI can't accidentally mutate content meant to stay
fixed — vendored reference material, a symlinked external source
([#11](https://github.com/ajmichels/moneta-notes/issues/11)), a template folder, an archive of past
work. This spec defines the `.mnotesreadonly` pattern file, the write-time guard every mutating tool
runs before touching disk, and how read-only status is surfaced to a caller on every read/list tool
*before* a write is attempted, not just discoverable by hitting the guard.

Deliberately modeled on `.mnotesignore` (S010) — same vault-root file location, same gitignore
syntax (via the `ignore` npm package), same absent-file-is-empty posture — but a **separate file and
mechanism**, not an extension of it. `.mnotesignore` answers "is this in the index at all";
`.mnotesreadonly` answers "can a tool write to this" — an orthogonal question, since a read-only note
is still fully indexed, searchable, and readable like any other. Conflating the two would force every
`.mnotesignore` pattern to also mean "don't let anyone write here," which isn't what index-exclusion
means today and shouldn't silently start meaning that.

## `.mnotesreadonly`

A gitignore-style file at the vault root — negation, `**`, directory-only trailing-slash patterns,
comments, the full `ignore` package grammar, not a hand-rolled subset. Absent file → empty matcher,
nothing read-only by default.

Patterns match the same vault-relative, `/`-separated, extension-included path every `.mnotesignore`
pattern matches against (e.g. `Templates/`, `Vendor/**`, `Archive/2024-*.md`) — for a note, that's
`<title>.md`, not the bare title.

```
# .mnotesreadonly — vault root
Vendor/**
Archive/
Reference/imported-notes.md
```

Because symlinked directories are indexed under their own alias path rather than their realpath (S005,
per issue #11's scoping work), a pattern like `Memory/**` transparently covers a symlinked external
source with zero special-casing — the same property `.mnotesignore` already has for symlinked content.

## Core primitives (`src/core/note-fs.js`, amending S010)

Three new exports, alongside `.mnotesignore`'s existing `loadIgnoreMatcher`:

- **`loadReadonlyMatcher(vaultRoot) -> matcher`** — same shape as `loadIgnoreMatcher`: reads
  `.mnotesreadonly` at the vault root via the `ignore` package and returns a matcher; absent file →
  empty matcher.
- **`checkReadonly(matcher, relativePath) -> { readonly: boolean, pattern: string|null }`** — wraps
  `ignore`'s `.test(relativePath)` (available since `ignore@7`, already this project's installed
  version), projecting its `{ ignored, rule: { pattern } }` down to what callers need: `pattern` is the
  matched rule's literal text when `readonly` is `true`, `null` otherwise. Takes an already-loaded
  `matcher`, not `vaultRoot`, specifically so a caller iterating many rows (`search`, `grep`,
  `tag_notes`, `metadata_query`) loads the file once per call and tests each row against the same
  instance, rather than re-reading `.mnotesreadonly` per row.
- **`assertWritable(vaultRoot, relativePath)`** — the write-time guard. Loads the matcher itself
  (self-contained, since every call site here checks exactly one path) and throws when blocked:

  ```
  assertWritable: "<relativePath>" is read-only — matches pattern "<pattern>" in .mnotesreadonly.
  ```

  Unwrapped by its caller, following the precedent `resolveVaultPath`/`titleToPath` already set (a
  vault-containment violation surfaces as `resolveVaultPath: ...`, not re-prefixed with the calling
  tool's name) — every mutator below calls this with no try/catch, letting the message propagate
  verbatim.

**Freshness — deliberately no persisted state.** Unlike `.mnotesignore` (whose *index membership*
effect is inherently tied to reindex cadence — S010's "two consumers, two different mechanisms"),
read-only status needs no table-backed state. `assertWritable` and `checkReadonly` both load
`.mnotesreadonly` fresh on every call — a small file, cheap to parse at this project's stated scale
(thousands of notes, not millions). Editing `.mnotesreadonly` therefore takes effect **immediately**,
everywhere, with no daemon restart or reindex required — simpler than `.mnotesignore`'s freshness
story, possible because read-only status is a flag on an already-selected row/path, not a gate on what
enters the index.

## Enforcement (the write-time guard)

Every mutating operation on the vault calls `assertWritable(vaultRoot, relativePath)` **immediately
after resolving its target path (`titleToPath`/`resolveVaultPath`), before any other validation, hash
comparison, or disk I/O.** This is the earliest point each function has a concrete vault-relative path
to check — checking first means a caller targeting a read-only note gets that specific answer, rather
than (say) a hash-mismatch error that would've resolved differently against a writable note.

Five call sites, amending **S003** and **S012**:

- `noteWrite(vaultRoot, title, ...)` — checks `<title>.md`. Applies to **both** the create path (no
  hash, new title) and the update path — a read-only glob blocks new notes from being created under it
  too, not just edits to existing ones.
- `noteEdit(vaultRoot, title, ...)` — checks `<title>.md`.
- `noteAppend(vaultRoot, title, hash, content)` — checks `<title>.md`.
- `noteRename(vaultRoot, oldTitle, newTitle, hash, db)` — checks **both** `<oldTitle>.md` and
  `<newTitle>.md`. Renaming a read-only note is blocked (protects existing content); renaming an
  ordinary note *onto* a path that matches a read-only pattern is also blocked (protects the zone from
  new arrivals) — both checks run before the hash comparison or the `newTitle`-already-exists check.
- `writeAttachment(vaultRoot, attachmentPath, buffer)` — checks `attachmentPath` as given (attachments
  have no `.md` suffix to append, per S012's existing exact-path convention).

No new CLI/MCP logic is needed: per CLAUDE.md's architecture rule, the guard lives entirely in
`core/`, so both surfaces inherit it automatically through their existing thin wrappers around these
five functions. A blocked call surfaces through the same paths every other thrown `core/` error already
does — MCP's `isError: true` response with the message preserved verbatim (S007), the CLI's non-zero
exit with the message on stderr, and an `outcome: 'error'` line in `audit.log` (S008) — nothing new to
build; `assertWritable`'s thrown `Error` is indistinguishable, plumbing-wise, from a hash-mismatch or
size-drop-guard error already flowing through these same paths.

## The link-cascade carve-out (amending S003)

`note_rename`'s link cascade (S003/S011) rewrites `[[oldTitle]]` references in *other* notes so a
rename never leaves a dangling link behind. **The cascade's per-candidate rewrites do not call
`assertWritable`, even when a candidate matches a read-only pattern.** This is a deliberate, narrow
exception: a read-only note left with a broken `[[wikilink]]` after a rename elsewhere is a worse
outcome than the cascade silently fixing it — Obsidian shows a dangling link with no indication of
where the target moved, and may prompt to create a new (wrong) note at the stale name if the user
clicks through. Protecting a read-only note's *content* from a direct caller-initiated write, and
keeping its *outbound links* correct as an automatic consequence of a rename elsewhere, are different
concerns — only the first is what `.mnotesreadonly` is for.

This sits alongside the cascade's existing, structurally identical carve-out from the hash-guard rule
(S003's "Concurrency model": the cascade's rewrites have no caller-controlled read/decide/write round
trip to protect, since they're internal steps of one `note_rename` call, not a separate caller-
initiated mutation). The same reasoning extends to the read-only guard.

**Visibility**: since this is a mutation to a note the guard would otherwise have blocked, it gets a
`debug` log line (same tier as the existing caller-supplied-`id`-overwrite log, S003) —
`getContextLogger().debug('link cascade: rewrote read-only candidate', { note_title: newTitle,
candidate_title: candidateTitle })` — not a `warn`, since nothing failed; just a trail for "why did a
read-only file's content change."

## Reporting read-only status

Every read/list tool surfaces read-only status in one of two shapes, matching the two output-format
families S007's "Output formats" already establishes:

### Single-note JSON responses

`note_read` (S003) and `attachment_read` (S012) each gain a **top-level sibling field**,
`readonly: true`, present only when the note/attachment is read-only — omitted (not `readonly: false`)
otherwise, matching the "optional field, present only when meaningful" convention `search`'s
`?fulltext_rank`/`?semantic_rank` already use.

This is deliberately **not** injected into `note_read`'s `metadata` object. `metadata` means "this
note's own frontmatter" everywhere else in this project (S003's `id`/`created` fields are the only
precedent for something computed-and-injected there, and both are actually *written to disk* as part
of the note — `readonly` never is; it's a property of `.mnotesreadonly`, external to the note). Folding
it into `metadata` would risk colliding with a genuine user-authored `readonly:` frontmatter key and
would need its own silent-drop special case on every write path, for no real benefit over a sibling
field.

Core-level signature changes: `noteRead(vaultRoot, title, options)` and
`readAttachment(vaultRoot, attachmentPath, options)` both already take `vaultRoot` — no new parameter,
just a `loadReadonlyMatcher(vaultRoot)` + `checkReadonly` call added to each, against the resolved
path.

### List/table responses

`search` (S002), `grep` and `tag_notes` (S004), and `metadata_query` (S014) each gain a `readonly`
column, following the convention `formatCell` (`src/format.js`, unchanged) already sets: **the literal
string `read-only` when true, nothing (empty cell) otherwise.** This is a two-layer split, keeping
`core/` and `format.js` on their existing sides of the formatting boundary (CLAUDE.md):

- **`core/`** (`search.js`, `grep.js`, `tags.js`, `metadata.js`) returns a real boolean —
  `readonly: true`, present only when true, same optional-field convention as the single-note case
  above. This is what a `--json`-mode caller sees: a real boolean, not a sentinel string.
- **`src/format.js`**'s row-shaping for each of these (`formatSearchTable`, `formatGrepTable`,
  `formatTagNotesTable` — shared by `metadata_query`, per S014's existing "same shape as tag_notes"
  note) converts `row.readonly` (`true` or absent) into the column value `'read-only'` or `null` before
  handing rows to `formatTable`, which already renders `null`/`undefined` as an empty cell
  (`formatCell`, unchanged). `formatSearchTable` currently passes `results` straight through to
  `formatTable` with no row-shaping step at all — this adds one, matching the pattern
  `formatGrepTable`/`formatTagNotesTable` already use.

`search`, `tag_notes`, and `metadata_query` gain an optional `vaultRoot` parameter they don't currently
take (`db`-only today) specifically for this — `grep` already has `vaultRoot`. Each loads the matcher
once per call (not per row) and calls `checkReadonly` per result row. CLI and MCP callers, which
already hold `vaultRoot`, just start passing it through; nothing changes for a caller that omits it
(the field is simply never present, same "additive, not a behavior change" posture S010's optional-`db`
title-resolution parameters already established).

### CLI-only: `mnotes links` / `mnotes links broken` (amending S006)

`note_read`'s `backlinks`/`links_out` arrays are deliberately **not** touched — S003 already commits
to those staying plain arrays of title strings, "no rank, no score, nothing else to carry," and that
rule isn't relaxed here. `mnotes links <title>`'s CLI table (S006, `direction|note_title` rows,
sourced from those same plain arrays) and `mnotes links broken`'s table (`note_title|broken_target`,
sourced from `core/links.js`'s `getBrokenLinks`, which also returns plain strings) compute their
`readonly` column CLI-side instead: `cli/main.js`'s handlers for these two commands call
`loadReadonlyMatcher(vaultRoot)` + `checkReadonly` directly, per row, before handing rows to
`formatLinksTable`/`formatBrokenLinksTable` — composing an existing `core/note-fs.js` primitive at the
CLI layer, not duplicating logic that lives elsewhere (there is no other copy of this check to
duplicate). `core/links.js` itself is unchanged.

## MCP tool descriptions (amending S007)

Per the existing precedent for behavior a caller needs to know to use the tool surface correctly
(S003/S007's hash-guard and title-resolution language), every tool description gains a short,
consistent note:

- `note_write`, `note_edit`, `note_append`, `note_rename`, `attachment_write`: *"Fails if the target
  path matches a pattern in the vault's `.mnotesreadonly` file — the error names the specific pattern
  that matched."*
- `note_read`, `search`, `grep`, `tag_notes`, `attachment_read`: *"A `readonly` field/column is present
  when the note matches a read-only pattern — check it before attempting to write."* (`metadata_query`,
  S014, gets the same note in its own spec/tool description.)

## Explicitly out of scope

- **Per-note frontmatter `readonly: true` flag**, as an alternative or complement to glob patterns.
  [#12](https://github.com/ajmichels/moneta-notes/issues/12) asked specifically for glob-pattern
  control, matching how `.mnotesignore` already works; a frontmatter-flag mechanism is a different
  design (caller-visible/settable per-note state vs. an external policy file) worth its own discussion
  if it comes up, not folded in here.
- **A CLI command to inspect `.mnotesreadonly` itself** (e.g. "is this note read-only, and why" as a
  standalone lookup separate from `read`/`search`/etc. already surfacing it). Every read/list tool
  already reports the flag; a dedicated inspection command would be a small, separable addition, not
  something this spec's enforcement/reporting design depends on.
- **A `notes.readonly` persisted index column.** Considered and rejected in favor of the always-fresh,
  no-migration approach above — see "Freshness" under Core primitives.
- **Protecting `.mnotesreadonly`/`.mnotesignore` themselves from being overwritten via
  `attachment_write`.** `attachment_write` already permits writing an arbitrary vault-relative path
  with no extension restriction, including these two dotfiles — a pre-existing, unrelated capability
  this spec doesn't attempt to close.
