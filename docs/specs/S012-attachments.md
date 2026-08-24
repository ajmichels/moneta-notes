# S012 — Attachments

Status: **Approved**
Owns: `src/core/attachments.js`
Amends: `S010-shared-utilities` (extracts a generic containment-checked path-join primitive that
`titleToPath` and this spec's own path resolution both build on)
Depends on: `S010-shared-utilities`
Consumed by: `S006-cli`, `S007-mcp-server`

## Purpose

Defines read/write access to binary vault files that aren't notes — images, PDFs, and other files a
note might embed or link to (`![[Attachments/receipt.pdf]]`, `[receipt](Attachments/receipt.pdf)`).
The motivating flow: Claude reads a note via `note_read`, finds a reference to an attachment in the
body, and needs a way to actually see or produce that file's bytes **without ever needing to know
where the vault lives on disk** — the same "tools, not raw file access" boundary every other surface
in this project already enforces.

Unlike notes, attachments are **not indexed**. There's no `attachments` table, no reindex step, no
freshness contract to reason about — a caller locates an attachment by reading a note and finding its
literal reference, then passes that reference straight through. This is a deliberate scope cut, not a
placeholder for a future index: attachments have no text content worth full-text/semantic search, no
frontmatter, and no `id` — the only thing worth tracking about one is "does this path exist and what's
in it," which a direct filesystem check answers as well as an index would.

## The `attachment_path` identifier

Every tool here takes `attachment_path<string>` — a **vault-relative path, extension included** (e.g.
`Attachments/receipt.pdf`, or `Projects/mnotes/logo.png` if a note keeps an attachment alongside
itself rather than in a dedicated folder — resolution isn't restricted to any one directory, matching
this vault's existing "flat structure is convention, not enforced" stance, S003). This is a deliberate
departure from CLAUDE.md's "note title is the identifier, never the raw file path" rule: that rule
exists because a note's *title* is one level of indirection above its path (frontmatter, hashing,
rename all operate on the title while the path underneath can theoretically move), and because the
index gives read-side callers basename resolution when they only have a short reference. Neither holds
for attachments — there's no frontmatter/id layer to speak of, and with no index there's nothing to
resolve a short reference against. The vault-relative path **is** the whole identifier, the same way
`notes.path` is internally, just surfaced directly instead of through a title abstraction.

**No resolution fallback, on read or write** — both tools require the caller's `attachment_path` to
match a real vault-relative path exactly. This applies uniformly to `attachment_read` too, unlike
`note_read`'s exact-then-basename fallback (S003/S010): that fallback is powered by `buildTitleIndex`
querying the `notes` table, and there is no equivalent table here to query. A caller with only a bare
filename (e.g. Obsidian wrote `![[receipt.pdf]]` using its own shortest-path convention) has no way to
resolve that through this tool surface — the practical mitigation is that a note's embed/link syntax
already contains the literal string a reference was written with, and Claude reads that string
directly out of the note body it just fetched, so in practice the reference handed to these tools is
whatever's actually between the `[[...]]`/`(...)`, not a value Claude invents.

## Path resolution and containment (amends S010)

`core/note-fs.js`'s `titleToPath(vaultRoot, title)` (S010) is `join(vaultRoot, `${title}.md`)` plus a
containment check (`relative(vaultRoot, candidate)` must not start with `..`) — correct for a title,
wrong for an attachment path, which already carries its own extension and shouldn't have `.md`
appended. The containment check itself, though, is identical for both cases. **This spec extracts that
check into a new S010 primitive**, `resolveVaultPath(vaultRoot, relativePath) -> string` — a plain
`join` + the same `relative()`-based containment throw, with no extension handling — and refactors
`titleToPath` to be `resolveVaultPath(vaultRoot, `${title}.md`)` internally. This is the same
"duplicated primitive drift" problem S010 itself was split out to prevent (see S010's own "Purpose"),
now surfacing a second time between titles and attachment paths rather than across five `core/`
modules — one containment check, two thin callers, instead of two independently-maintained copies of
the same `relative()` logic that could silently diverge (e.g. one accepting a leading `/` the other
doesn't).

`core/attachments.js`'s own path resolution is exactly `resolveVaultPath(vaultRoot, attachmentPath)` —
no extension appended, no basename fallback (see above). A path containing `../` segments that would
resolve outside `vaultRoot` throws the same containment error `titleToPath` already throws, unchanged
in wording/behavior from a caller's perspective.

## Tools

### `attachment_read`

`attachment_path<string>`, `?include_content<bool>=true`, `?start_page<int>`, `?end_page<int>`,
`reason<string>`.

Returns `{ path, size_bytes, mime_type, content_base64 }`, plus `total_pages` when `mime_type` is
`application/pdf`. `path` echoes the resolved vault-relative path (never an absolute filesystem path —
same "never leak the vault's real location" boundary every other tool response already respects).
`mime_type` is derived from the file extension via a small built-in extension→MIME lookup table
(implementation detail, not a spec-level concern beyond: unknown extensions fall back to
`application/octet-stream`, never an error — an unrecognized extension is not a reason to fail a read).

- **`content_base64` is included whenever `include_content` is `true`** (the default) — the file's raw
  bytes, base64-encoded, so a caller can actually see/use an image or document, not just confirm it
  exists. **Gated by a config-backed size cap** (`[attachments].max_read_bytes`, S009) — if
  `include_content` is `true` and the file exceeds the cap, this is a hard error (fail loudly, per
  CLAUDE.md — never a silent downgrade to metadata-only) naming the file's actual size, the configured
  cap, and directing the caller to retry with `include_content: false` for metadata only, or — when
  `mime_type` is `application/pdf` — with `start_page`/`end_page` to fetch a slice instead of the whole
  file (see below).
- **`include_content: false`** returns `{ path, size_bytes, mime_type }` with no `content_base64` key
  at all (omitted, not `null`) — an explicit metadata-only mode, useful when Claude only needs to
  confirm an attachment exists or check its size/type before deciding whether to fetch it, without
  worrying about the size cap.
- Throws if `attachment_path` doesn't resolve to a real file (`"Attachment not found: <path>"`) or
  resolves to a directory rather than a file.

**`start_page`/`end_page` (PDF only)** — 1-indexed, inclusive, mirroring `note_read`'s
`start_line`/`end_line` convention rather than any external tool's own range-string syntax, for
consistency with the rest of this project's own tool surface. Given either, `readAttachment` uses
`pdf-lib` to load the source PDF, copy just that page range into a freshly-created `PDFDocument`, and
return *that* smaller document's bytes as `content_base64` — a real, independently-openable PDF
containing only the requested pages, not a text/image extraction. `total_pages` (the source document's
full page count) is always included on a PDF response, sliced or not, so a caller that hits the size
cap on a whole-file read knows what range is even worth asking for next.

- **Not a hard requirement.** Unlike some external tools' "large PDFs *must* specify a page range"
  behavior, a PDF under the size cap still reads whole-file with no range needed — page count is a poor
  proxy for byte size (a handful of scanned-image pages can dwarf a hundred pages of text), so the
  existing byte-based cap stays the single trigger for when a range becomes necessary, surfaced via the
  cap-exceeded error's retry guidance (above), not a separate page-count gate.
- **No separate page-span cap.** The sliced document's bytes are checked against the same
  `max_read_bytes` cap as any other read — asking for too wide a range fails the same "retry narrower"
  way asking for too large a whole file already does, rather than introducing a second, independent
  limit (e.g. "20 pages max") a caller would have to learn.
- `start_page`/`end_page` on a non-PDF `attachment_path` is a hard error — there's no page concept to
  slice for any other MIME type this tool serves.
- `start_page`/`end_page` without the other, or with `start_page > end_page`, or a page number outside
  `1..total_pages`, is a hard error naming the problem and the document's actual `total_pages` (fail
  loudly, no clamping to the nearest valid value).
- `start_page`/`end_page` together with `include_content: false` is also a hard error, not a silent
  ignore of the page range — the two arguments express contradictory intent (a slice of content vs. no
  content at all), and per CLAUDE.md a nonsensical combination fails loudly rather than one argument
  quietly winning.

`total_pages` is computed via a `pdf-lib` load whenever `mime_type` is `application/pdf`, **independent
of `include_content`** — a metadata-only read reports it too, and the cap-exceeded error message (above)
names it, so a caller always has enough information to pick a sensible `start_page`/`end_page` on the
next call without a wasted round trip.

**This computation is best-effort, not a requirement, except when a page range is actually
requested.** A `.pdf`-extension file that fails to parse as an actual PDF (corrupt, mislabeled,
whatever) doesn't fail a plain byte or metadata read over it — `total_pages` is simply omitted from the
response (same "omitted, not null/error" precedent `content_base64` already sets for
`include_content: false`), and the cap-exceeded error falls back to its plain `include_content: false`
retry hint with no page-range mention. This matches the file extension→MIME lookup's own existing
stance one paragraph up ("an unrecognized extension is not a reason to fail a read") applied to a
mismatched/corrupt one instead: `attachment_read`'s baseline contract — return whatever bytes exist at
`attachment_path`, or confirm they exist — never depends on those bytes actually being well-formed for
their apparent type. **Only when `start_page`/`end_page` is explicitly given** does a parse failure
become a hard error (naming the underlying parse problem) — that's the one case where the file
genuinely being a valid, page-addressable PDF is load-bearing for fulfilling the request at all.

### `attachment_write`

`attachment_path<string>`, `content_base64<string>`, `reason<string>`.

Returns `{ path, size_bytes, mime_type }`.

- **Create-or-overwrite, unconditionally — no hash guard.** CLAUDE.md's "every mutating operation on an
  existing note requires a matching content hash" is scoped to *notes*: the rule protects a caller
  across a read/decide/write round trip against clobbering a concurrent *text* edit it can't otherwise
  detect, which presumes a diffable/mergeable content model notes have and binary attachments don't —
  there's no meaningful "has this image changed since I last looked" check to perform, and no partial
  merge concept to protect. An attachment write is a full-replace, always, same as `cp` would be.
- **Creates parent directories as needed** (`mkdir -p` semantics) — since resolution isn't restricted
  to one dedicated folder (see above), a caller writing the first attachment into a new subfolder
  shouldn't have to separately ensure that folder exists first.
- Decodes `content_base64` and writes it as a temp file in the same directory, then renames it into
  place — an atomic swap, so a failed or interrupted write never leaves a truncated file at
  `attachment_path`. This matters more here than it would for a small note body: attachments can be
  large enough for a write to take real wall-clock time, widening the window an interruption could land
  in.
- No size-drop guard (S003's guard is specific to note line-count collapse; there's no equivalent
  "logical size" concept for an arbitrary binary format to guard against shrinking).
- Same containment check as `attachment_read` (`resolveVaultPath`, above) — a `attachment_path`
  resolving outside `vaultRoot` throws, never silently writes outside the vault.

## Config: `[attachments]` (amends S009)

```toml
[attachments]
max_read_bytes = 10000000   # ~10MB — attachment_read's include_content size cap
```

`core/attachments.js` stays config-ignorant per CLAUDE.md's architecture rules — `readAttachment`
accepts `maxReadBytes` as a plain option, same pattern `noteWrite`'s `sizeDropThreshold` already
follows (S009); `mcp/tools.js` and `cli/main.js` are what call `loadConfig()` and thread
`config.attachments.max_read_bytes` through.

## CLI (`mnotes attachment read|write`, amends S006)

Two subcommands under a new `attachment` command group, alongside the existing `tags list`/`tags notes`
grouping style:

| Command | Flags | Notes |
|---|---|---|
| `mnotes attachment read <path>` | `--raw`, `--metadata`, `--json` | See modes below. |
| `mnotes attachment write <path> [local-file]` | | Reads `<local-file>` off local disk directly — no base64 round trip on this surface, since the CLI and the vault share a filesystem. Reads from stdin instead if `local-file` is omitted. |

**`mnotes attachment read <path>` has three modes**, deliberately mirroring `mnotes read`'s
default/`--raw`/`--json` split (S006) with one difference — the default action here is a real side
effect (opening a program), not printing to stdout, since attachment bytes aren't something a terminal
should try to render:

| Mode | Behavior |
|---|---|
| default | Resolves `<path>`, then shells out to macOS `open <resolved-absolute-path>` — the file opens in whatever app the OS has associated with its type. Nothing is written to stdout beyond a one-line confirmation (`opened Attachments/receipt.pdf`); no size cap applies, since this never routes bytes through `mnotes` itself. |
| `--raw` | Streams the exact file bytes to stdout, unmodified — for piping to another tool or redirecting to a local copy (`mnotes attachment read "Attachments/receipt.pdf" --raw > backup.pdf`). Subject to the same `max_read_bytes` cap `attachment_read` uses (this mode round-trips through `core/attachments.js` the same way the MCP tool does, just written to stdout instead of base64-encoded into a JSON field). |
| `--metadata` / `--json` | Prints `{ path, size_bytes, mime_type }` as JSON to stdout — no bytes, no cap. `--metadata` and `--json` are aliases for this same mode (offered under both names since `--json` matches every other command's flag for "give me structured output" while `--metadata` is the more descriptive name for what this particular mode actually returns). |

`mnotes attachment write <path> [local-file]` reads `<local-file>` (an ordinary local filesystem path,
resolved relative to the current working directory the same way any other CLI tool's file argument
would be — not vault-relative, since it isn't in the vault yet) and writes its bytes to `<path>`
(vault-relative, same as the MCP tool's `attachment_path`) via the same create-or-overwrite,
atomic-rename `core/attachments.js` write path — no `content_base64` flag exists on the CLI surface
since the CLI never needs the wire-format encoding an MCP JSON-RPC payload requires for binary data.
**`local-file` is optional — content is read from stdin (raw bytes, not utf8-decoded) when it's
omitted**, mirroring `write`/`append`'s existing stdin fallback for note content (S006), useful for
piping the output of another command straight into a new attachment without a temp file
(`curl ... | mnotes attachment write "Attachments/downloaded.pdf"`).

Neither command takes `--reason` (S006's existing "no `reason` flag" rule for every CLI command, not
just note tools). `mnotes attachment write` is logged to `audit.log` (`source: cli`, tool
`attachment_write`) the same way `mnotes write`/`edit`/`append`/`rename` already are (S006/S008);
`mnotes attachment read` isn't, matching `mnotes read`'s own no-logging-on-reads precedent.

## MCP (amends S007)

Two new tools, `attachment_read` and `attachment_write`, added to the tool set documented in S007.
Both take `reason<string>` like every other tool. Output is structured JSON for both (matching
`note_read`/the mutating note tools' shape, not the pipe-delimited columnar format — a single-object
response, not a list of rows, so there's no tabular format to gain from here).

Every MCP tool call is audited regardless of read/write (S007's existing "every tool call, not just
mutations" rule, the asymmetry with the CLI already documented there) — `attachment_read` and
`attachment_write` both land in `audit.log` with `source: 'mcp'`, same as every other tool.

Tool **description** strings must state plainly (mirroring how `note_write`'s description states its
own exact-title requirement, S007): *"attachment_path must be the exact vault-relative path, as it
appears in the note's `[[wikilink]]`/`![[embed]]`/markdown-link reference — there is no short-form or
basename resolution for attachments, unlike note_title."* This is exactly the kind of behavior a caller
needs to know to use the tool correctly, not an implementation detail to leave undocumented, same
rationale S003/S007 already apply to the note tools' own title-resolution rules.

## Logging

Mutations (`attachment_write`) are covered by the existing `logAudit` boundary-layer call per S008,
same as every note-mutating tool — no additional `core/attachments.js`-internal logging beyond what a
thrown error already produces (fail-loudly, no hash-mismatch-style incidental `debug`/`warn` cases exist
here the way S003 has for `id`-overwrites or link-cascade failures, since this spec has no comparable
internal machinery). Per CLAUDE.md, **never log attachment bytes or base64 content** — audit entries
carry `tool`, `attachment_path` (as the note-tools' entries carry `note_title`), `reason`, `outcome`,
never the file's content.

## Explicitly out of scope here

- **Indexing attachments** (full-text/semantic search over attachment content, an `attachments` table,
  freshness/reindex semantics) — deliberately not built. Per "Purpose" above, this is a scope decision,
  not a deferred one: an attachment is discovered by reading the note that references it, not by
  searching for it directly.
- **Listing/enumerating attachments** (a directory-walk tool, an "orphan attachment" report analogous to
  S011's rejected orphan-note idea) — not requested, not built. A future spec's problem if it turns out
  to be wanted in practice, same posture S011 takes toward orphan notes.
- **Deleting attachments** — no `attachment_delete` tool. Not requested; `attachment_write` (create-or-
  overwrite) covers the "replace with different content" case, and outright deletion of vault files
  through a tool surface is a larger safety-posture decision (unlike overwriting bytes, deleting a file
  has no create-or-overwrite-style natural default) left for a future ask if it comes up.
- **MIME type table's exact contents** — implementation detail, not an architectural decision this spec
  needs to pin down (same posture S006 takes toward `--explain`'s exact JSON shape).
- **Obsidian-side attachment folder configuration, embed syntax choice, or `obsidian.nvim`'s own
  attachment-opening behavior** — this is vault/editor configuration entirely outside `mnotes`, not
  something this project's tools enforce or need to know about. `attachment_path` accepts whatever
  vault-relative path a note actually references, wherever in the vault that happens to be.
