# Plan — S015 Read-only Paths

Execution checklist for [S015](../specs/S015-readonly-paths.md). Disposable — delete this file once
implemented and verified against the spec; don't trust checkbox state, verify against the repo.
Rationale lives in the spec, not here. Follow CLAUDE.md's TDD convention throughout: write/extend the
colocated `*.test.js` first for each step, watch it fail, then implement.

## 1. Core primitive: `src/core/note-fs.js`

- [ ] Add `loadReadonlyMatcher(vaultRoot)`, `checkReadonly(matcher, relativePath)`,
      `assertWritable(vaultRoot, relativePath)` per S015/S010. Mirror `loadIgnoreMatcher`'s
      existing shape for the first; `checkReadonly` wraps `ignore`'s `.test()` (already available,
      `ignore@7.0.8` is the installed version — verify with `node -e "console.log(require('ignore/package.json').version)"` if in doubt).
- [ ] `note-fs.test.js`: absent `.mnotesreadonly` → `checkReadonly` always `{ readonly: false, pattern: null }`,
      `assertWritable` never throws. A matching pattern → `checkReadonly` returns the matched pattern
      text; `assertWritable` throws `assertWritable: "<path>" is read-only — matches pattern "<pattern>"
      in .mnotesreadonly.`. Negation (`!`) patterns work, same as an existing `.mnotesignore` test
      likely already covers for `loadIgnoreMatcher` — mirror it. Directory-only trailing-slash patterns
      match a path inside that directory.

## 2. Write guard: `src/core/notes.js`

- [ ] `noteWrite`, `noteEdit`, `noteAppend`: call `assertWritable(vaultRoot, `${title}.md`)`
      immediately after `titleToPath` resolves the path, before any other check.
- [ ] `noteRename`: call `assertWritable` against **both** `${oldTitle}.md` and `${newTitle}.md`,
      before the hash comparison and the `newTitle`-exists check.
- [ ] `cascadeLinkRename`/`rewriteLinkCandidate`: confirm (by omission) these do **not** call
      `assertWritable` — the carve-out. Add the `debug('link cascade: rewrote read-only candidate', {
      note_title, candidate_title })` log line in `rewriteLinkCandidate` (or its caller) right after a
      candidate write actually happens, gated on the candidate being read-only (needs its own
      `checkReadonly` call there — read-only, not guard — to know whether to log).
- [ ] `notes.test.js`: each of the four mutators throws `assertWritable`'s exact message and leaves the
      file untouched when the target is read-only. `noteWrite` create path (no hash, new title under a
      read-only glob) is blocked too, not just updates. `noteRename` blocked when `oldTitle` is
      read-only; blocked when `newTitle` lands under a read-only glob even though `oldTitle` isn't.
      Cascade test: rename a note that a **read-only** note links to — assert the read-only note's
      `[[oldTitle]]` link *is* rewritten to `[[newTitle]]` (not blocked), and the debug log fires.

## 3. `note_read`'s `readonly` field: `src/core/notes.js`

- [ ] `noteRead`: add `readonly: true` (present only when true) to both return branches (`totalLines
      === 0` and the normal path), computed via `loadReadonlyMatcher(vaultRoot)` + `checkReadonly`
      against the resolved path.
- [ ] `notes.test.js`: a note matching `.mnotesreadonly` reads back with `readonly: true`; a normal
      note has no `readonly` key at all (not `false`).

## 4. Write guard + `readonly` field: `src/core/attachments.js`

- [ ] `writeAttachment`: `assertWritable(vaultRoot, attachmentPath)` immediately after
      `resolveVaultPath`, before `mkdirSync`/the temp-file write.
- [ ] `readAttachment`: add `readonly: true` (present only when true) to every return shape (metadata-
      only, full content, PDF page-range).
- [ ] `attachments.test.js`: guard-blocked write leaves no file/temp-file behind; `readAttachment`
      reports `readonly` correctly across all three response shapes.

## 5. `search`: `src/core/search.js`

- [ ] `search(db, options)` accepts optional `vaultRoot` in `options`. When given, load the matcher
      once, then in `toFulltextOutput`/`toSemanticOutput`/`toHybridOutput` add `readonly: true`
      (present-only-when-true) per row.
- [ ] `search.test.js`: with `vaultRoot`, a read-only note's row carries `readonly: true` in all three
      modes; without `vaultRoot`, no `readonly` key anywhere (unchanged existing behavior).
- [ ] Leave `explainSearch`/`--explain` output untouched (out of scope per S015 — it's a CLI debug
      surface with its own raw-score columns already).

## 6. `grep`: `src/core/grep.js`

- [ ] `grep(vaultRoot, pattern, options)` already has `vaultRoot` — load the matcher once per call, add
      `readonly: true` (present-only-when-true) to each result.
- [ ] `grep.test.js`: a read-only note's grep result carries `readonly: true`.

## 7. `tag_notes`: `src/core/tags.js`

- [ ] `tagNotes(db, tagName, options)` — new optional `options.vaultRoot`. When given, add `readonly`
      per row same as above.
- [ ] `tags.test.js`: with/without `vaultRoot`, same assertions as `search`.

## 8. `metadata_query`: `src/core/metadata.js`

- [ ] `metadataQuery(db, { filters, match, vaultRoot })` — same treatment as `tagNotes`.
- [ ] `metadata.test.js`: same assertions.

## 9. `src/format.js`

- [ ] `formatSearchTable`: add a row-shaping step (currently passes `results` straight to `formatTable`)
      that maps `readonly: true → 'read-only'`, absent → `null`, and add `'readonly'` to each mode's
      `SEARCH_COLUMNS` entry.
- [ ] `formatGrepTable`, `formatTagNotesTable`: add the same `readonly` mapping to their existing
      row-shaping, add `'readonly'` to their column list.
- [ ] `formatLinksTable`, `formatBrokenLinksTable`: accept rows that already carry a `readonly` key
      (computed CLI-side, see step 11) and add `'readonly'` to their column list — these two don't
      compute the flag themselves, just render whatever the caller attached.
- [ ] `format.test.js`: a `readonly: true` row renders the `read-only` cell; a row without the key
      renders an empty cell (`formatCell`'s existing null/undefined handling — confirm no change needed
      there).

## 10. `src/mcp/tools.js`

- [ ] Thread `vaultRoot` into the `search`, `grep`, `tagNotes`/`tag_notes`, `metadataQuery` tool
      handlers (`grep`'s handler already has it in scope; add to the other three's `core/` calls).
- [ ] Add the two shared description strings from S015 (`READONLY_WRITE_NOTE`, `READONLY_READ_NOTE`)
      wherever tool `description`s are defined (likely alongside the existing `TAG_ESCAPE_NOTE`
      constant) and append them to: `note_write`, `note_edit`, `note_append`, `note_rename`,
      `attachment_write` (write note); `note_read`, `search`, `grep`, `tag_notes`, `attachment_read`,
      `metadata_query` (read note).
- [ ] No change needed to `callTool`'s error-mapping/audit-logging — a thrown `assertWritable` error
      already flows through the existing catch/`isError: true`/`audit.log` path unchanged (verify with
      a quick manual/integration check, not new logic).

## 11. `src/cli/main.js`

- [ ] Thread `vaultRoot` into the `search`, `grep`, `tags notes`, `metadata query` command handlers'
      `core/` calls.
- [ ] `links <title>` and `links broken` handlers: after fetching `backlinks`/`links_out` (or
      `getBrokenLinks`'s rows), load `loadReadonlyMatcher(vaultRoot)` once and attach `readonly` per row
      before calling `formatLinksTable`/`formatBrokenLinksTable`.
- [ ] Confirm mutating commands (`write`/`edit`/`append`/`rename`/`attachment write`) need no new code —
      they already call straight into `core/`, so `assertWritable`'s error surfaces through the existing
      exit-code/stderr/audit-log path unchanged (verify, don't assume).
- [ ] `cli/main.test.js` (or wherever CLI command tests live): each `--json` list command shows the
      real boolean; default table mode shows the `read-only` column; a mutating command against a
      read-only target exits non-zero with the `assertWritable` message on stderr.

## 12. Docs (per CLAUDE.md's doc-sync rule — same change, not a follow-up)

- [ ] `docs/usage.md`: mention the read-only rejection error for `write`/`edit`/`append`/`rename`, and
      the `readonly` column/field on `search`/`grep`/`read`/`links`/`links broken`.
- [ ] `docs/usage-mcp.md`: same, for the MCP tool list — mention `READONLY_WRITE_NOTE`/
      `READONLY_READ_NOTE` behavior per affected tool.
- [ ] Check `README.md`'s tool table(s) for whether they enumerate exact output fields per tool (they
      did for `note_rename`/`attachment_read`/`attachment_write` when those were added) — update if so.
- [ ] Mention `.mnotesreadonly` alongside the existing `.mnotesignore` documentation, wherever that
      currently lives (`docs/usage.md`'s indexing/exclusion section, if any — check).

## 13. Verify against S015 end-to-end

- [ ] `pnpm lint && pnpm test` clean.
- [ ] Manual smoke test: create a scratch vault, add `.mnotesreadonly` with one pattern, confirm via
      both `mnotes` CLI and a live MCP tool call that (a) a write is rejected naming the pattern, (b)
      `search`/`grep`/`read` report `readonly`, (c) editing `.mnotesreadonly` takes effect immediately
      with no daemon restart, (d) a rename that touches a read-only note via the link cascade still
      updates its links.
- [ ] Delete this plan file once the above is verified.
