# S003 — Notes

Status: **Approved**
Owns: `src/core/notes.js`
Depends on: `S001-data-model`, `S004-grep-tags` (`note_rename`'s cascade reuses `core/grep.js` for
candidate discovery), `S010-shared-utilities`, `S011-links` (extraction/backlink/rewrite primitives)
Consumed by: `S006-cli`, `S007-mcp-server`

## Purpose

Defines note CRUD semantics: reading, creating, replacing, surgically editing, appending to, and
renaming notes, plus the content-hash concurrency guard, frontmatter/metadata handling, and the
auto-managed `id` frontmatter field. This spec introduces one tool beyond what's currently documented
in the README — `note_rename` — and adds a `metadata` param to `note_edit` that the README's current
table is missing. Both are flagged here for reconciliation in the README and in S007 (MCP tool
schemas).

## The `id` frontmatter field

Every note has an `id` key in its YAML frontmatter, matching `obsidian.nvim`'s own convention (`id`
is one of its three special frontmatter keys, alongside `aliases`/`tags` — see
[obsidian.nvim's Frontmatter docs](https://github.com/obsidian-nvim/obsidian.nvim/wiki/Frontmatter)).
Per `obsidian.nvim`'s actual usage (the `id` value *is* the note's filename when notes are created
through it), `id` here is the **bare filename without extension** — no folder prefix, distinct from
`title` which includes the folder path (e.g. a note at `Weekly Notes/2026-W32.md` has
`id: 2026-W32`, `title: Weekly Notes/2026-W32`).

- `id` is **entirely system-managed**. It's computed by `core/notes.js` from the note's current path
  on every create/write/edit/rename — never read from or settable by a caller.
- If a caller includes an `id` key in a `metadata` object passed to `note_write` or `note_edit`, it's
  silently dropped and replaced with the computed value. No error — this isn't treated as caller
  error, just an ignored field, since `id` was never a real input in the first place.
- `id` only ever changes as a side effect of `note_rename` (see below) — no other tool changes a
  note's path, so no other tool can cause `id` to change.

## The `created` frontmatter field

Every note also gets a `created` key in its YAML frontmatter: an ISO 8601 UTC timestamp (e.g.
`2026-08-29T14:03:11.482Z`, `Date.prototype.toISOString()`'s format) capturing when the note was
first written. This exists because there's otherwise no reliable way to answer "when was this note
created" — filesystem mtime/birthtime don't survive a vault sync/backup restore, and the index is
ephemeral (rebuildable from scratch, not a system of record).

- `created` is **entirely system-managed**, same posture as `id`: computed by `core/notes.js` at
  creation time only — never read from or settable by a caller.
- If a caller includes a `created` key in a `metadata` object passed to `note_write` on creation,
  it's silently dropped and replaced with the actual creation timestamp, logged the same way as an
  overwritten caller-supplied `id` (`getContextLogger().debug('overwrote caller-supplied created', …)`
  — see "Logging" below).
- Unlike `id`, `created` is **never recomputed after creation**. `note_write` (update), `note_edit`,
  `note_append`, and `note_rename` all carry the existing `created` value forward untouched — it isn't
  part of any of their metadata-merge logic, just existing frontmatter that survives the shallow merge
  like any other caller-set key.
- A note that predates this field (created before this behavior existed) simply has no `created` key
  — nothing back-fills it retroactively, and its absence isn't treated as an error.
- `obsidian.nvim` (see `CLAUDE.local.md`) is configured with a matching `note_frontmatter_func` so
  notes created directly through Neovim get the same `created` field, in the same format, without
  going through `core/notes.js` at all. That function runs on *every* save, not just the first, so it
  can't use "is `created` already present" as its create-vs-update signal — plenty of pre-existing
  notes have no `created` key at all, and stamping one in on their next ordinary edit would fabricate
  a false creation time. It instead checks whether the note's file exists on disk yet (same signal
  `obsidian.nvim` itself uses internally to log "Created" vs "Updated"), only ever stamping `created`
  on the save where the file doesn't exist yet.

## Tools

### `note_read`

`note_title<string>`, `?start_line<int>`, `?end_line<int>`, `reason<string>`. Returns `title`,
`start_line`, `end_line`, `total_lines`, `content_hash`, `metadata` (parsed frontmatter, including the
system-managed `id`), `content`, `backlinks`, `links_out`.

Frontmatter is parsed via a YAML frontmatter library (e.g. `gray-matter`). A note with no frontmatter
block at all reads back as `metadata: {}` — but in practice this should be rare, since every note
gets an `id` written at creation time. Malformed YAML in the frontmatter block is a hard parse error
(fail loudly — not silently treated as empty metadata).

**Exactly one blank line separates the frontmatter's closing `---` from the first line of content**,
matching `obsidian.nvim`'s `note_frontmatter_func` convention (see `CLAUDE.local.md`). Every write
path (`note_write` create/update, `note_edit`, `note_append`, `note_rename`) enforces this on the way
out, regardless of how the note was previously formatted — a note with no blank line, or several,
gets normalized to exactly one the next time it's touched. This blank line is purely structural: it's
never counted as part of `content` or `total_lines` at any tool boundary, so `content` is always just
the note's real body text.

**`note_title` resolves, it isn't just matched literally** (S010): `noteRead(vaultRoot, title,
{ startLine, endLine, db })` now accepts an optional `db`. Resolution order: exact title match first
(the fast, common path — `titleToPath` + `existsSync`, no `db` needed); if that misses and `db` was
provided, fall back to `core/note-fs.js`'s `resolveTitle(db, title)` (S010) — a unique-basename match.
If `db` wasn't passed, or resolution still misses, this is the existing "Note not found" error,
unchanged. This is what makes `mnotes read "Barbara Garn"` return the note at
`LoonStateHockey/JMS Hockey/Barbara Garn` instead of erroring, when that's the only note with that
basename.

**The returned `title` is always the resolved absolute title, never an echo of the input.** If
resolution kicked in, `title` in the response is the *real* title (`LoonStateHockey/JMS Hockey/Barbara
Garn`), not the string `note_title` was called with (`Barbara Garn`). This is the mechanism the rest
of this spec's "read/write split" (below) depends on: a caller that only had an ambiguous reference
now has the unambiguous one, from the one tool that's allowed to guess.

**`backlinks<string[]>`** and **`links_out<string[]>`** (S011's link-graph work) give Claude both
traversal directions from a single `noteRead` call: which notes point *at* the one just read, and
which notes it points *at* itself.

- `backlinks` comes from `core/links.js`'s `getBacklinks(db, title)` (S011), using the *resolved*
  title above — `[]` (not omitted, not an error) whenever `db` isn't passed, same optional-`db`
  pattern as the title resolution itself. Index-backed, so it reflects the vault as of each linking
  note's last reindex — same freshness contract `search` already has.
- `links_out` is `core/links.js`'s `extractLinkTargets` (S011) run against the note's own **full
  body** (regardless of `start_line`/`end_line` — a windowed read still wants the complete outbound
  link picture), then — when `db` is provided — passed through `core/links.js`'s
  `resolveLinkTargets(db, rawTargets)` (S011) so each entry becomes the resolved absolute title where
  one resolves, falling back to the raw literal text otherwise (a genuinely broken or ambiguous link
  has no better answer to give). Without `db`, `links_out` is the raw, unresolved literal text — same
  reduced-capability-without-`db` shape as `backlinks`.
- Both are deduplicated arrays of note titles, not objects — no rank, no score, nothing else to carry
  per CLAUDE.md's "no raw scores" spirit extended to "no extra fields beyond what's needed to
  navigate."

## Title resolution and the read/write split

Verified against Obsidian's own docs and community/developer analysis of its `MetadataCache` resolver
(`getFirstLinkpathDest`): a bare `[[Name]]` wikilink resolves by basename match when that basename is
unique vault-wide, deterministically. When ambiguous (two or more notes share a basename), Obsidian
itself has no published, guaranteed tie-break — so this project doesn't attempt to replicate one
(S010's `resolveAgainstIndex` returns `null` for both "no match" and "ambiguous match", deliberately
not distinguishing them).

The motivating flow this exists for: Claude finds a note via `search` (which always returns full,
unambiguous titles — no ambiguity possible there), reads it via `note_read`, and finds a
`[[wikilink]]` in the body worth following. That link text might be a short, ambiguous-looking
reference rather than the note's full title — exactly the "Barbara Garn" case. Two rules make this
work without Claude ever having to reason about the ambiguity itself:

1. **Read-oriented lookups resolve; every mutating tool doesn't.** `note_read`'s `note_title` and
   `grep`'s `note_title` scope (S004) both get the exact-then-basename fallback (S010), opt-in via an
   optional `db`. `note_write`, `note_edit`, `note_append`, and `note_rename` (`old_title` **and**
   `new_title`) get none — every one of them requires the caller-supplied title to match a real path
   exactly, full stop, same as before this change. This is deliberate, not an oversight:
   `note_write`'s create-vs-update branch depends on "does this exact title already exist" meaning
   something unambiguous (a resolved-to-something-else "create" call could silently edit the wrong
   note instead of creating a new one), and a wrong resolution on any mutating call is a far worse
   failure mode than a wrong resolution on a read.
2. **`note_read` always hands back the resolved absolute title** (above). A caller that only has an
   ambiguous reference reads the note first — getting the real title in the response — then mutates
   using *that*. No mutating tool ever needs to resolve anything on its own behalf; `note_read` is the
   sole place resolution happens, and its output is the bridge back to the exact-match world every
   mutation lives in.

Tool-facing documentation (MCP tool `description` strings, CLI `--help` text) states this explicitly
for the mutating tools — "requires the note's absolute title, as returned by `search`/`note_read`" —
per S007/S006, since this is exactly the kind of behavior a caller (Claude) needs to know about to use
the tool surface correctly, not an implementation detail to leave undocumented.

### `note_write`

`note_title<string>`, `hash<null|string>`, `?metadata<json>`, `content<string>`, `reason<string>`.

- **No `hash` + new title** → create. `metadata` (if provided) becomes the note's frontmatter, with
  `id` and `created` computed and injected (each overwritten if the caller included one). No
  `metadata` provided on create → frontmatter contains only the computed `id` and `created`.
- **No `hash` + existing title** → error, directing the caller to read first (per CLAUDE.md).
- **`hash` matching current content_hash** → full replace of `content`. `metadata` **merges** into
  existing frontmatter (shallow merge): each key in the passed object overwrites the corresponding
  existing key, and a key set to `null` deletes that key from frontmatter. Keys not mentioned are left
  untouched. This differs from `content`'s full-replace semantics — a deliberate asymmetry: `content`
  has no natural "patch" representation the way a small metadata tweak does, so replace-whole-content
  vs. merge-metadata are each the natural default for their own field.
- **`hash` not matching current content_hash** → staleness error.
- Size-drop guard: if the new `content`'s line count is below ~50% of the current line count, the
  write is rejected unless `force: true` is passed. Applies to updates only (not create, where there's
  no prior content to compare against). The threshold (`0.50`) is a `config.toml` value, not a
  hardcoded constant — flagged for S009.
- Returns `{ title, hash, line_count }` on success — the new content_hash and line_count, so a caller
  can chain a follow-up mutation without a separate `note_read`.

### `note_edit`

`note_title<string>`, `hash<string>` (**required, non-nullable** — no create path exists for this
tool, so a null hash has no meaningful interpretation), `old_txt<string>`, `new_txt<string>`,
`?metadata<json>`, `reason<string>`.

- Replaces `old_txt` with `new_txt` in the note body. Fails if `old_txt` doesn't match exactly once
  (zero matches = error, multiple matches = error — ambiguous edits aren't guessed at).
- `metadata`, if provided, merges into frontmatter using the same semantics as `note_write` (`null`
  deletes a key). This closes a gap in the README's current `note_edit` documentation, which has no
  metadata param at all.
- Size-drop guard applies here too (a large `old_txt` → small/empty `new_txt` replacement is just as
  capable of collapsing a note as a bad `note_write` would be).
- Returns `{ title, hash, line_count }`, same as `note_write`.

### `note_append`

`note_title<string>`, `hash<string>` (**required** — reversing an earlier draft of this spec that
exempted append from the hash guard; on reflection, append is still a mutation of an existing note
and gets no special exemption, consistent with CLAUDE.md's "no exceptions" rule), `content<string>`,
`reason<string>`.

- Appends `content` to the end of the note body. No `metadata` param — append stays content-only and
  single-purpose; a caller wanting to change metadata alongside an append makes two calls.
- No size-drop guard (append can only grow line count — the guard is structurally unreachable here).
- Returns `{ title, hash, line_count }`.

### `note_rename` (new — not in the current README tool list)

`old_title<string>`, `new_title<string>`, `hash<string>` (must match `old_title`'s current
content_hash), `reason<string>`.

- Renames (moves) the note file from `old_title`'s path to `new_title`'s path.
- **Fails hard if `new_title` already refers to an existing note** — no `force` override, consistent
  with the rest of this tool set's no-silent-overwrite stance. Renaming onto an existing title is
  always a caller error to resolve explicitly (e.g. delete the target first), never an implicit
  replace.
- Rewrites the `id` frontmatter field to match the new filename as part of the rename (since `id` is
  filename-derived — see above). This means the file's bytes change (the `id` line), so
  **`content_hash` changes as a result of a rename**, even though the note's body and other metadata
  are otherwise untouched. This is the natural consequence of `id` being stored in the file, not a
  special case to work around.
- Implemented as a filesystem-level move (`old_title`'s file is read, hash-checked, `id` rewritten,
  written to the new path, old path removed), same as before. Additionally, `noteRename` takes an
  optional `db` argument (a `node:sqlite` handle, same shape `core/search.js`'s `search(db, ...)`
  already accepts) — when supplied, it write-throughs the rename into the index synchronously in the
  same call: the existing `notes` row (found by the old path) is `UPDATE`d in place to the new
  path/content_hash/line_count/mtime, keeping its original `id`, and `notes_fts` is refreshed
  (delete+insert by that same rowid, matching S005's `replaceFtsRow` convention) with the new title
  and unchanged body. `chunks`/`chunk_vectors` are never touched — the note's body didn't change, so
  there's nothing to re-embed. `mtime` is read back from a real `statSync` of the freshly-written
  file (not `Date.now()`), so it matches what S005's `processPath` will observe on disk and hits its
  `existing.mtime === currentMtime` short-circuit rather than a wasted hash comparison.
  If the note wasn't indexed yet (no matching `notes` row for the old path), this is a silent no-op —
  the daemon's fswatch fallback picks up the new path as an ordinary create. If no `db` is passed at
  all (or one is passed but the caller never wired one up), the rename behaves exactly as before,
  filesystem-only, and fully depends on the fswatch fallback below.
- **Why write-through instead of relying on fswatch alone:** the old design left renamed notes
  briefly missing from search (~15s debounce + up to 2s drain interval on the delete side) and forced
  a full re-embed of unchanged content on the create side (see S005's committed rename-handling
  section). `noteRename` is the one call site that knows the old→new path mapping with certainty, so
  applying it directly avoids both.
- **fswatch fallback still exists and is now secondary, not primary:** a rename performed outside
  this API (Obsidian's own rename, `mv`, a `git` restore, or `note_rename` called without a `db`)
  still shows up to the indexing daemon as an ordinary file delete + create pair (per the README's
  indexing architecture: "a manual edit in NeoVim, an MCP `note_write`, or a `git` version restore
  all end up as a file-change event"). S001's `path UNIQUE` + upsert design handles the resulting
  delete-old-row/insert-new-row cleanly in that case, same as before this change. See S005's
  "Rename write-through vs. fswatch fallback" for the full mechanics, including why the fallback
  path is already a safe no-op when the write-through has already run (old path no longer matches
  any row; new path's mtime/hash already matches what the write-through recorded).
- No size-drop guard (body content is unchanged).
- **Link cascade** (new — S011): after the file-level rename above succeeds, `noteRename` finds every
  other note that references `old_title` via a wikilink and rewrites those references to `new_title`,
  so a rename never silently leaves stale `[[OldTitle]]` links scattered across the vault. This runs
  synchronously, inside the same `noteRename` call — there's no separate agent-driven step and no
  daemon-side queue involved; the caller that invoked `note_rename` isn't responsible for orchestrating
  it, it just happens as part of the rename.
  1. **Candidate discovery**: a literal-string vault-wide search via `core/grep.js`'s existing
     `grep(vaultRoot, pattern)` (S004) — reused as-is, not reimplemented — for `[[old_title`, **and**,
     if `old_title` has a folder prefix, a second search for `[[<basename of old_title>` (the last
     `/`-separated segment). The second pattern is what catches `[[Barbara Garn]]`-style short-form
     references to a note actually at `LoonStateHockey/JMS Hockey/Barbara Garn` — without it, the
     cascade silently misses every short-form link to a nested note, which was a real bug in this
     cascade's first version. Both searches are deliberately over-inclusive (a title that's a prefix of
     another title, or a basename shared by an unrelated note, both surface as candidates — the
     precise check happens in the next step) and deliberately a **live scan of the vault, not a query
     against `note_links`**: the cascade is mutating files, so it needs the correctness of "what's
     actually on disk right now," not the "as of last reindex" staleness that's an accepted tradeoff
     for the read-only `backlinks` query above. Candidate lists from both searches are merged and
     deduped by title before the next step. This also means the cascade works even when `db` is `null`
     (grep doesn't need one) — see the basename-matching caveat in the next step for what's lost in
     that case.
  2. **Per-candidate rewrite**: for each candidate path (this naturally includes the just-renamed
     note's own new path, if it contains a self-referential link — see below), read the file fresh and
     run `core/links.js`'s `replaceLinkTarget(body, old_title, new_title, { titleIndex })` (S011),
     which rewrites a wikilink occurrence only if its target is (a) an exact match on `old_title`, or
     (b) an exact match on `old_title`'s basename **and** that basename resolves uniquely to
     `old_title` in `titleIndex` (S010's `resolveAgainstIndex`) — filtering out both `grep` searches'
     over-inclusive hits, including a candidate that happens to link to a *different* note sharing that
     basename. `titleIndex` (S010's `buildTitleIndex(db)`) is built **once, before the file-level
     rename runs** — not after — because by the time the cascade runs, `old_title` no longer exists in
     the vault (it's been renamed already); resolving against a post-rename index would never find
     `old_title` to match against, defeating the basename check entirely. Without `db`, there's no
     index to check basename uniqueness against, so `replaceLinkTarget` only performs the safe,
     unconditional exact-title rewrite (a) — case (b) is skipped, meaning short-form links only get
     fixed when `db` is available. `replaceLinkTarget` preserves any `#Heading`/`|Alias` segment
     untouched. If `count > 0`, write the file back. No caller-supplied hash here — this is internal
     machinery inside the single `noteRename` call, not a separate caller-initiated mutation, so
     CLAUDE.md's hash-guard requirement doesn't apply the way it does to
     `note_write`/`note_edit`/`note_append` (those exist to protect against an *agent* clobbering a
     concurrent *external* edit across a read/decide/write round trip it controls; there's no such round
     trip here). The read-immediately-before-write sequence still keeps the race window as small as the
     primary rename's own file swap.
  3. **Re-indexing the rewritten notes**: if `db` was passed, each rewritten note's vault-relative path
     is enqueued via `core/db.js`'s `enqueuePath(db, path)` (S001; also re-exported by
     `indexer/daemon.js` for its own call sites) — the
     daemon's normal drain loop picks it up on its own schedule and re-chunks/re-embeds/re-tags/re-links
     it like any other content change (a link-target rewrite *is* a real body content change, unlike the
     primary rename's frontmatter-only `id` rewrite, so it does need the full reindex treatment, not a
     direct write-through). If `db` wasn't passed, the file is still corrected on disk and the daemon's
     ordinary `fswatch` path picks it up later, same fallback story the primary rename already has
     without a `db`.
  4. **Failure handling is best-effort, for the whole cascade, not just per candidate**: if reading or
     writing one candidate file fails (permissions, concurrent deletion, etc.), that candidate is
     skipped and the rest of the candidate list is still processed. If candidate *discovery* itself
     fails (most plausibly `ripgrep` not being installed — S004's `grep` already hard-errors on this
     for its own tool, but `note_rename` didn't previously depend on `ripgrep` at all, and a missing
     optional prerequisite shouldn't turn into a hard failure for an operation that otherwise has
     nothing to do with it), the entire cascade step is skipped the same way. Either case is worth a
     log line (see "Logging" below) but never a thrown error from `noteRename` as a whole — the primary
     rename has already fully succeeded by this point and isn't rolled back or blocked by the cascade
     failing to run.
  5. **Scope**: only renames performed through `note_rename` itself trigger this cascade. A rename
     performed outside this API (Obsidian's own rename, a bare `mv`, a `git` checkout that moves a
     file) is not detected as a rename at all by S005's `fswatch`-driven handling (it surfaces as an
     ordinary delete+create pair) and therefore can't reliably be cascaded from — inferring an old/new
     title pairing from two independent file-change events is heuristic and error-prone. Links left
     stale by an out-of-band rename are a known, accepted gap (same category as any other change made
     outside the tool surface), not a bug to design around.
- Returns `{ title, hash, line_count }` — `title` is `new_title`, `hash`/`line_count` reflect the
  **final** on-disk state of `new_title`'s file after the link cascade above, not just the immediate
  post-rename-only value. This matters in the self-referential case: if the renamed note linked to
  itself under its old title, step 2 rewrites that same file a second time, and a caller chaining a
  follow-up mutation off this response needs a hash that matches what's actually on disk, not an
  intermediate value that's already stale by the time the response is returned.

## Concurrency model

Hash-check-then-write is not wrapped in additional file locking beyond the sequence itself (read
current hash → compare → write). This is an accepted small race window, justified because this is a
single-user, sequential-tool-call system (one Claude session driving one MCP server against one
vault at a time), not a high-concurrency service — the hash guard exists to catch *staleness* (edits
that happened between reads, e.g. a NeoVim save mid-conversation), not to serialize concurrent writers.

**`note_rename`'s link cascade is a deliberate, scoped exception to "every mutating operation on an
existing note requires a matching content hash"** (CLAUDE.md). The rule's purpose is protecting a
*caller* (an agent, across its own read → decide → write round trip) from clobbering a concurrent
external edit it can't see. The cascade's per-candidate rewrites have no such caller-controlled round
trip — they're internal steps of the single `noteRename` call, reading each file immediately before
writing it, with the same accepted race window this section already grants the rest of this concurrency
model. This isn't a precedent for relaxing the guard elsewhere; it applies narrowly to this one
system-internal, read-immediately-adjacent-to-write sequence.

## Logging

Every tool here is a mutation, and per `S008`, mutations are already fully covered by `logAudit` at
the boundary layer (MCP tool call or CLI mutating command) — `tool`, `note_title`, `outcome`, and
`error_message` on failure land in `audit.log` regardless of which of these functions ran or why it
failed. `core/notes.js` does **not** duplicate that via `getContextLogger()`: a hash mismatch, an
ambiguous `old_txt` match (zero or multiple), and a size-drop-guard trip all just throw a specific,
descriptive error (per CLAUDE.md's "fail loudly"), same as they would with no logging infrastructure
at all — the thrown message *is* what ends up as `audit.log`'s `error_message`, so a second `warn` line
from inside `core/` would only repeat it under a different component name.

One exception, matching `S002`'s "silent-by-design but worth a low-noise trail" pattern: when a caller
passes an `id` key in `metadata` and it's silently dropped/overwritten with the computed value (see
"The `id` frontmatter field" above), `core/notes.js` calls `getContextLogger().debug('overwrote
caller-supplied id', { note_title, supplied_id, computed_id })`. This is information `audit.log`
wouldn't otherwise carry (it records the mutation's outcome, not what happened to an individual
input field), and unlike a hash-mismatch or guard trip it isn't an error — there's genuinely nothing
else to log it as. The same pattern applies to a caller-supplied `created` key on creation (see "The
`created` frontmatter field" above): `getContextLogger().debug('overwrote caller-supplied created',
{ note_title, supplied_created })` — no `computed_created` field, since unlike `id` the computed value
is just "now" at the moment of the call, not a derived value worth echoing back.

A second exception, new here: when `note_rename`'s link cascade skips a candidate because reading or
writing it failed, `core/notes.js` calls `getContextLogger().warn('link cascade: failed to update
candidate', { note_title: new_title, candidate_title, error_message })`. If candidate discovery itself
fails (see "Failure handling is best-effort" above), it logs `getContextLogger().warn('link cascade:
candidate discovery failed', { note_title: new_title, error_message })` once instead, and skips the
rest of the cascade. Both are `warn`, not `debug`, unlike the `id`-overwrite case above — either case
means a note is left with a stale link the caller has no other way of finding out about (the overall
`note_rename` call still succeeds and returns normally), which is worth a durable trail even though it
isn't itself a thrown error.

## Explicitly out of scope here

- **Path/title validation against the "flat vault structure" convention** — deliberately not
  enforced. `note_write`/`note_rename` accept any title/path; the convention (root + `Weekly Notes/` +
  `Daily Notes/`, no other nesting) stays social/documented, not tool-enforced. This is unrelated to
  vault *containment*, which is enforced: [S010](S010-shared-utilities.md)'s `titleToPath` rejects any
  title that resolves outside `vaultRoot` (e.g. `../` traversal), since every title-taking tool here
  routes through it.
- **Tag extraction from frontmatter or inline `#hashtags`** — S004.
- **How a rename's delete+create file events get picked up and reindexed** — S005 (indexing-daemon).
- **Wikilink syntax/extraction rules, `note_links` storage, `getBacklinks`, and `replaceLinkTarget`** —
  S011 (links); this spec only calls those primitives.
- **`note_rename`'s MCP tool schema and its addition to the README's tool table** — S007.
