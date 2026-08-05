# S003 — Notes

Status: **Approved**
Owns: `src/core/notes.js`
Depends on: `S001-data-model`
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

## Tools

### `note_read`

Unchanged from the README: `note_title<string>`, `?start_line<int>`, `?end_line<int>`,
`reason<string>`. Returns `title`, `start_line`, `end_line`, `total_lines`, `content_hash`,
`metadata` (parsed frontmatter, including the system-managed `id`), `content`.

Frontmatter is parsed via a YAML frontmatter library (e.g. `gray-matter`). A note with no frontmatter
block at all reads back as `metadata: {}` — but in practice this should be rare, since every note
gets an `id` written at creation time. Malformed YAML in the frontmatter block is a hard parse error
(fail loudly — not silently treated as empty metadata).

### `note_write`

`note_title<string>`, `hash<null|string>`, `?metadata<json>`, `content<string>`, `reason<string>`.

- **No `hash` + new title** → create. `metadata` (if provided) becomes the note's frontmatter, with
  `id` computed and injected (or overwritten if the caller included one). No `metadata` provided on
  create → frontmatter contains only the computed `id`.
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
  written to the new path, old path removed) — `core/notes.js` does not touch the SQLite index
  directly. The rename shows up to the indexing daemon as an ordinary file delete + create pair (per
  the README's indexing architecture: "a manual edit in NeoVim, an MCP `note_write`, or a `git`
  version restore all end up as a file-change event"), and S001's `path UNIQUE` + upsert design
  handles the resulting delete-old-row/insert-new-row cleanly either way.
- No size-drop guard (body content is unchanged).
- Returns `{ title, hash, line_count }` — `title` is `new_title`, `hash` is the post-rename hash
  (reflecting the rewritten `id`).

## Concurrency model

Hash-check-then-write is not wrapped in additional file locking beyond the sequence itself (read
current hash → compare → write). This is an accepted small race window, justified because this is a
single-user, sequential-tool-call system (one Claude session driving one MCP server against one
vault at a time), not a high-concurrency service — the hash guard exists to catch *staleness* (edits
that happened between reads, e.g. a NeoVim save mid-conversation), not to serialize concurrent writers.

## Explicitly out of scope here

- **Path/title validation against the "flat vault structure" convention** — deliberately not
  enforced. `note_write`/`note_rename` accept any title/path; the convention (root + `Weekly Notes/` +
  `Daily Notes/`, no other nesting) stays social/documented, not tool-enforced.
- **Tag extraction from frontmatter or inline `#hashtags`** — S004.
- **How a rename's delete+create file events get picked up and reindexed** — S005 (indexing-daemon).
- **`note_rename`'s MCP tool schema and its addition to the README's tool table** — S007.
