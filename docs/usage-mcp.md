# MCP Server Usage

The MCP server (Claude Code / Claude Desktop) — see [Usage](usage.md) for the CLI command reference
this maps onto, and [S007 — MCP Server](specs/S007-mcp-server.md) for full behavioral detail.

Once registered (`claude mcp add mnotes ...` — done automatically by
[`scripts/install.sh`](installation.md) if `claude` is on `PATH`), the following tools are available to
Claude in any session:

`search`, `grep`, `tag_list`, `tag_notes`, `metadata_keys`, `metadata_query`, `note_read`,
`note_write`, `note_edit`, `note_append`, `note_rename`, `attachment_read`, `attachment_write`

These map directly onto the CLI commands above (`note_read` ↔ `mnotes read`, etc.) and share the same
`core/` logic — same hashing rules, same size-drop guard, same "no raw scores" output, and the same
title-resolution split: `note_read`/`grep` accept a short or ambiguous title (resolved the same way
`mnotes read`'s does) and `note_read` always returns the real absolute title in its response;
`note_write`/`note_edit`/`note_append`/`note_rename` require the exact absolute title with no
resolution — each tool's own description states this.

`note_write`/`note_edit`/`note_append`'s descriptions also warn about inline tag extraction on the next
reindex ([S004](specs/S004-grep-tags.md)): an isolated `#5` is already safe (rejected as purely
numeric), but adjacent refs (`#1/#2`) or a hex-looking run (`#3498db`) become real tags. Escape a single
value with a backslash (`\#foo`, Obsidian's own escape syntax) or wrap a longer run in backticks.

`metadata_query`'s `filters` argument takes the structured `{key, op, value?, negate?}` shape
directly — no string parsing — the same shape `mnotes metadata query`'s `--filter`/`--exists`/
`--missing` flags compile down to (see [`mnotes metadata query`](usage.md#mnotes-metadata-keys--mnotes-metadata-query)
for the full semantics: dot-path keys, operators, `tags` interception, `match: all|any`).

`attachment_read`/`attachment_write` ([S012](specs/S012-attachments.md)) are unindexed, so
`attachment_path` always requires the exact vault-relative path, on both tools — no short-form
resolution even on the read side, unlike every note tool above. `attachment_read` returns a JSON text
block with `size_bytes`/`mime_type` (plus `total_pages` for PDFs), gated by `[attachments].max_read_bytes`,
plus — when content is included — a second MCP content block carrying the actual bytes: an `image`
block for PNG/JPEG/GIF/WebP, or a `resource` block (base64 blob) for everything else, including PDFs.
Bytes are never inlined as base64 text inside the JSON metadata (an earlier version did this and caused
Claude to try to manually decode large attachments itself instead of treating them as opaque binary).
`start_page`/`end_page` (1-indexed, inclusive, PDF only) fetch just that page range as a standalone PDF
instead of the whole file — useful once a PDF is too large for a whole-file read, per the cap-exceeded
error's own guidance. `attachment_write` is always create-or-overwrite with no hash guard, since binary
attachments have no diffable text content for that guard to protect.

Two differences from the CLI:

- Every tool requires a **`reason<string>`** argument, logged for audit purposes (mirroring
  `description` on Claude Code's native file tools) — the CLI has no equivalent since a human typing
  the command *is* the reason.
- `--explain`, `--raw`, and `grep`'s `--content` (all CLI debug/ergonomics flags) have no MCP
  equivalent.

Check `claude mcp list` to confirm registration, and `mcp-server.log` /
[`audit.log`](process-management.md#logs) if a tool call isn't behaving as expected.
