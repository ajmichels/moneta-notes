# S014 — Metadata Search

Status: **Approved**
Owns: `src/core/metadata.js`
Depends on: `S001-data-model` (schema change: `notes.metadata_json`), `S003-notes` (frontmatter
parsing, the `id`/`created` fields), `S004-grep-tags` (tag matching, reused not duplicated),
`S010-shared-utilities`
Consumed by: `S005-indexing-daemon` (extraction during reindex), `S006-cli`, `S007-mcp-server`

## Purpose

Frontmatter is fully readable/writable (S003) but, beyond `tags` (S001/S004), none of it is
searchable — a caller with a custom field like `status: active` or `due: 2026-01-01` has no way to
filter notes by it short of `note_read`-ing every candidate. This spec defines `notes.metadata_json`
(a per-note JSON projection of frontmatter, minus `tags`) and the two tools that query it:
`metadata_keys` (discovery) and `metadata_query` (filtering), including a special case that lets
`metadata_query` also filter by tag without duplicating tag storage or matching logic.

## Storage: `notes.metadata_json`

Add `metadata_json TEXT NOT NULL` to the `notes` table (S001). This is a **schema change** —
`SCHEMA_VERSION` (`core/db.js`) bumps, triggering S001's version-check-and-rebuild path on next open,
which forces a full reindex and so populates `metadata_json` for every note without a separate
backfill step.

**JSON1, not a flattened EAV table.** `node:sqlite`'s bundled SQLite ships `json_extract`/`json_each`/
`json_tree` built in (no `enableLoadExtension` step, unlike `sqlite-vec`) — verified against the
project's actual dependency versions. Storing frontmatter as one JSON blob per note and querying it
with these functions, instead of flattening into a `note_metadata(note_id, key, value)` table, wins on
every axis that matters here:

- **Arbitrary nesting and arrays-of-objects work natively.** A field like `depends_on: [{project:
  ..., source: ...}, ...]` needs no flattening walker or `entry_index` bookkeeping — `json_each` over
  the stored array iterates it directly.
- **Compound same-entry matching falls out for free.** "This note depends on `foo/bar` specifically
  via `graph+review`" is just two `json_extract(e.value, ...)` conditions inside the same `json_each`
  iteration — no self-join needed. (Not exposed by `metadata_query`'s query language in this version —
  see "Explicitly out of scope" — but the storage model doesn't foreclose it.)
- **Extraction is a two-line transform**, not a recursive flattening/depth-limiting walker (see
  "Extraction" below).

The one real cost: no B-tree index into arbitrary JSON paths (SQLite has nothing equivalent to
Postgres GIN — an index on `json_extract(col, '$.path')` only accelerates that exact, advance-declared
path, and can't cover `json_each`-iterated array elements at all). Benchmarked against 5,000 notes with
a `depends_on`-shaped array field: worst case (array-of-object compound match) **3.8ms full scan**,
scalar/numeric conditions **~1.7ms**. Acceptable at this project's stated scale ("thousands of notes,
not millions" — S001). If a specific key ever gets hot enough to matter, an expression index on just
that path is a one-line, additive change (verified: brings a scalar equality check from 1.78ms to
0.20ms, confirmed via `EXPLAIN QUERY PLAN` using the index) — not built speculatively now.

### What's excluded: `tags`

Every frontmatter key except `tags` is projected into `metadata_json`. `tags` is excluded for two
concrete reasons, not because it's "special":

1. Tags have a second extraction source `metadata_json` can't represent — inline `#hashtags` scanned
   from the note body (S004) — so a frontmatter-only JSON blob would only ever capture half of a
   note's tags.
2. Tags already have a purpose-built, better structure than JSON querying could offer: indexed
   (`note_tags_tag_id`), case-insensitive with casing preservation (`COLLATE NOCASE`), and
   cascade-pruned (S001/S004). Reimplementing that worse via JSON buys nothing.

`metadata_query` still supports filtering by tag — see "Tag interception" below — without either
duplicating tag storage or reimplementing tag-matching semantics.

### What's included: `id`, `created`, everything else

Unlike `tags`, `id` and `created` (S003's system-managed frontmatter fields) are **included** in
`metadata_json`, projected the same as any custom key. Neither of `tags`'s two justifications applies
to them — no second extraction source, no existing indexed structure to duplicate — so excluding them
"because they're system-managed" would be a second exclusion rule resting on different, weaker
grounds than the first. `created` is in practice the most broadly useful field this feature enables
filtering on (dense — every note has one — and a natural fit for the date-range querying below); `id`
is lower-value (an opaque per-note identifier) but free to include.

### Date normalization

`gray-matter`'s YAML parsing (`js-yaml` underneath) resolves an **unquoted** plain scalar matching a
date-like shape to a JS `Date` — verified: `due: 2026-01-01` (unquoted) parses to a `Date`; `due:
'2026-01-01'` or `due: "2026-01-01"` (quoted, either style) stays a string, per YAML's own
implicit-typing rule (only plain scalars get it). Also verified: the date-shape check is a bare regex,
not calendar-validated — an unquoted `2026-13-45` still becomes a `Date` (JS silently rolls invalid
month/day forward) rather than erroring. Worth noting in user-facing docs: quote any field whose value
coincidentally looks like `Y-M-D` but isn't meant as a date.

Before `JSON.stringify`, `core/metadata.js` recursively walks the parsed frontmatter object (arrays and
plain objects, arbitrary depth) and replaces every `Date` with `date.toISOString()` — a **string**, not
an epoch number. This was a deliberate reversal from an earlier epoch-seconds design: epoch numbers
collapse a date field and a plain numeric field into the same JSON type, which would force a caller (or
`metadata_query` itself, via fragile format-sniffing) to already know which fields "secretly become
integers" to query them correctly. Storing the canonical ISO string instead preserves the natural JSON
type distinction end-to-end — a date stays a string, a number stays a number — and query-time range
comparison still works correctly (see "Date literals" under Query engine below).

`tags` is skipped during this walk; every other key, at any depth, is included verbatim (subject to
the depth the *query engine* can address — see below; storage itself has no depth limit, since
`json_tree`/`json_each` can walk arbitrarily deep).

## Extraction

Hooks into the same reindex pass that already runs `syncNoteTags`/`syncNoteLinks`
(`indexer/daemon.js`'s per-note reindex function, alongside the existing calls around the code that
builds `read.metadata`): `buildMetadataJson(read.metadata)` (new, `core/metadata.js`) produces the JSON
string, passed as a new column value into the same `upsertNoteRow` write that already sets
`content_hash`/`line_count`/`mtime`/`extraction_version`. No new join table, so no delete-and-reinsert
step analogous to `note_tags`/`note_links` — it's a single scalar column, overwritten in place on every
reindex of that note, which is already idempotent by construction (same input frontmatter always
produces the same JSON string).

The initial rollout is covered by the `SCHEMA_VERSION` bump forcing a full reindex (every note gets
`metadata_json` populated as part of that rebuild). A **future** change to extraction rules (e.g.
changing which keys are excluded, changing date normalization) would need an `EXTRACTION_VERSION`
bump (`indexer/daemon.js`) to reach already-indexed notes, exactly as tag/link extraction changes do
(S004) — a schema version bump isn't available for that case since the column itself isn't changing.

## Query engine (`core/metadata.js`)

### Key addressing and the array/object uniformity trick

Keys are dot-paths: a bare top-level key (`status`), or exactly one level of nesting
(`depends_on.project`, `project.status`). **At most one dot** — a caller-supplied key with two or more
dots is a hard validation error, not a silently-empty result (fail loudly). Anything actually nested
deeper in a note's frontmatter is simply not addressable by `metadata_query` — it's still fully present
in `note_read`'s raw `metadata` output, just outside this tool's reach.

Splitting a key at the last dot gives a **container** path and an optional **leaf** subkey. Every
condition compiles to the same template regardless of whether the container holds a scalar, an array
of scalars, a single object, or an array of objects — a `CASE`/`json_array` wrap normalizes all four
shapes into something `json_each` can iterate uniformly, so the caller never needs to know or declare
which shape a given note actually used:

```sql
[NOT] EXISTS (
  SELECT 1 FROM json_each(
    CASE WHEN json_type(n.metadata_json, '$.<container>') = 'array'
         THEN json_extract(n.metadata_json, '$.<container>')
         ELSE json_array(json_extract(n.metadata_json, '$.<container>'))
    END
  ) AS e
  WHERE [json_extract(e.value, '$.<leaf>') | e.value] <op-specific predicate>
)
```

Verified against a fixture combining plain scalars, a flat array, and an array-of-objects field: scalar
equality, numeric range, array-of-object independent-field matching, `exists`/missing, `in`, and
`negate` (see below) all produce the expected note sets.

### Operators

`eq`, `gt`, `gte`, `lt`, `lte`, `in` (value is an array — "any of these," distinct from the array-element
matching every op already gets for free against a multi-valued key), `exists` (no value — checks the
container/leaf resolves non-null for at least one element). There is no `ne` — see Negation.

### Negation

Every condition carries an optional `negate<bool>` (default `false`), implemented by wrapping that
condition's *entire* `EXISTS(...)` in `NOT EXISTS(...)` — not by flipping the comparison operator.
This distinction is load-bearing for multi-valued keys, not stylistic: verified concretely that a note
depending on both `foo/bar` and `biz/buz` is (wrongly) matched by a naive per-element `!=
'foo/bar'` check, because it has *some* element that isn't `foo/bar` — even though it also depends on
`foo/bar`, which is exactly what negating "depends on foo/bar" should exclude. `NOT EXISTS` around the
whole per-key check — "no element satisfies this" — is the only version that's correct in both the
scalar and array-valued case, so it's the only negation mechanism this spec defines. (This is also why
`exists` needs no separate `value: true|false` — `negate` already expresses "missing.")

### Combining conditions

`filters` is a non-empty array of conditions; `match<'all'|'any'>` (default `'all'`) picks the combinator
ANDing or ORing the per-condition `[NOT] EXISTS(...)` fragments together. This is a single, flat toggle
over the whole array — there is no nested/mixed boolean grouping (`(A OR B) AND C`). "OR across values
of the same key" doesn't need `match: 'any'` at all — that's what `in` is for; `match: 'any'` is for OR
across *different* keys. Genuine nested boolean logic is out of scope (see below) — a caller needing it
issues multiple `metadata_query` calls and merges the results itself.

### Date literals

A caller filtering a date-valued key writes an ordinary date/datetime string (`"2026-01-01"`), the same
shape they'd write in frontmatter — never an epoch number, never anything describing how the value is
stored internally. Because comparison happens against a canonical `.toISOString()` string (see
"Date normalization" above), a literal at a different precision than what's stored needs to be
canonicalized the same way before binding, or the comparison is wrong at the boundary: `"2026-01-01"`
is a string-prefix of `"2026-01-01T00:00:00.000Z"`, so plain `>` would count an exact-midnight match as
"after itself." `metadata_query` canonicalizes any literal matching `^\d{4}-\d{2}-\d{2}` (via `new
Date(literal).toISOString()`) before it's bound into the query, for `gt`/`gte`/`lt`/`lte` only. Verified:
`due > "2026-01-01"` correctly excludes a note whose `due` is exactly that date; `due >= "2026-01-01"`
includes it. A plain numeric literal never enters this path. This canonicalization is purely internal
to how `metadata_query` builds SQL — it is not part of the tool's contract and never surfaces a
representation detail to a caller.

### Tag interception

`key: "tags"` is intercepted before the JSON-path machinery above runs at all: instead of a
`json_each`-based fragment, it builds `EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id =
nt.tag_id WHERE nt.note_id = n.id AND (t.name = ? OR t.name LIKE ? || '/%'))` — the exact
exact-or-nested-child, case-insensitive predicate `tagNotes` (S004) already uses. `core/tags.js` grows
a small exported helper producing this predicate + its bound params (name TBD, e.g. `tagMatchClause`),
used by both `tagNotes` and this interception, so the two never drift.

Everything above this dispatch point — `negate` → `NOT EXISTS`, `match: 'all'|'any'` combining
fragments — is unchanged; it doesn't care which builder produced a given fragment. Verified combining a
tag condition with a `metadata_json` condition under `match: 'all'` (default) produces the intersection
correctly, and `negate` on a tag condition produces the correct "does not carry this tag (or any nested
child)" set.

Restricted for `key: "tags"`: only `eq`, `in`, `exists` are valid (tags aren't ordered — `gt`/`gte`/
`lt`/`lte` is a hard validation error) and no dot-path nesting (`tags.anything` is a hard validation
error — tags is a flat vocabulary, not a nested structure).

## Tools

### `metadata_keys`

**Input**: `reason<string>`. **Output**: `key<string>`, `type<'string'|'number'|'boolean'|'date'>`,
`example<any>`, `notes_with_key<int>`.

Discovery: walks every note's `metadata_json` via `json_tree`, normalizes each `fullkey` (strips the
`$.` prefix, strips array-index segments like `[0]`, strips SQLite's quoting around irregular key
names) down to the same dot-path shape `metadata_query` addresses, and groups by that normalized key.
`type` is inferred from one sampled non-null value's actual JSON type: a JSON number → `number`; a JSON
string matching the ISO-date pattern → `date`; any other string → `string`; boolean → `boolean`. This
is a sampled hint, not an enforced schema — frontmatter has no enforced schema across notes today
either, so nothing changes there. `tags` never appears as a row here — `tag_list` (S004) remains the
single discovery surface for the tag vocabulary; `metadata_query`'s tool description documents `tags`
as an always-available special-cased key.

### `metadata_query`

**Input**: `filters<array>` (each `{ key<string>, op<'eq'|'gt'|'gte'|'lt'|'lte'|'in'|'exists'>,
value?<string|number|boolean|array>, negate?<bool> }`, non-empty), `match?<'all'|'any'>='all'`,
`reason<string>`. **Output**: `note_title<string>`, `file_line_count<int>` — same shape as `tag_notes`.

## CLI (`mnotes metadata keys` / `mnotes metadata query`)

`mnotes metadata keys [--json]` mirrors `mnotes tags list`.

`mnotes metadata query [--filter=...]... [--exists=key]... [--missing=key]... [--match=any] [--json]`:
each `--filter` is a small friendly string (`"status=active"`, `"priority>3"`, `"due<2026-01-01"`,
`"depends_on.project=foo/bar"`, `"status in draft,review"`, `"status!=active"`), parsed into the exact
same `{key, op, value, negate}` shape the MCP tool takes directly — `=`/`!=`/`>`/`>=`/`<`/`<=` map to
`eq`(negate)/`gt`/`gte`/`lt`/`lte`, `in` takes a comma-separated value list. `--exists=key`/
`--missing=key` are sugar for `{key, op: 'exists'}`/`{key, op: 'exists', negate: true}`. This parsing is
presentation-layer translation living entirely in `cli/` — the same relationship `cli/main.js` already
has with `--metadata='{...}'` for `note_write` (parse a friendly/structured input, call the identical
`core/` function MCP calls with the same final shape) — not a second copy of query logic.

Chosen over accepting raw JSON at the CLI (which `--metadata='{...}'` does) because `metadata_query`'s
conditions are flat triples, not arbitrary nested data — nothing here forces JSON the way a full
frontmatter object does, and `search`/`grep`/`tags` all take plain flags/positionals rather than JSON
blobs, which this should match.

## Logging

`core/metadata.js` calls `getContextLogger()` for the one thing worth a durable trail: a validation
failure (bad op for a key's shape, `tags.` nesting, a key with more than one dot) — `warn`, message
describing the specific violation, logged immediately before the throw, same treatment `S002` gives a
malformed FTS5 query. No per-call logging for a successful `metadata_keys`/`metadata_query` call — same
rationale as `S002`/`S004`: normal, high-frequency, no diagnostic value beyond the tool's own response.

## Explicitly out of scope here

- **Nested/mixed boolean expression trees** (`(A OR B) AND C`) — `match` is a single flat toggle over
  one filters array; genuine nested logic requires multiple calls merged by the caller.
- **Per-key expression indexes** — additive future work if a specific key turns out to need it; not
  built speculatively given the benchmarked full-scan cost at this project's scale.
- **Combining `metadata_query` filters directly into `search`'s ranked modes** (S002) — a plausible
  future extension ("notes about X where status=active"), not this spec.
- **Compound same-entry matching** (`depends_on.project=X AND depends_on.source=Y`, same array entry)
  — the storage model supports it (see "Storage" above) but `metadata_query`'s query language doesn't
  expose it yet; no stated need for it today.
- **Keys nested more than one level deep** — unaddressable by `metadata_query`, still fully visible via
  `note_read`'s raw `metadata` output.
- **The CLI `--filter` string grammar's exact tokenizer** — S006, this spec only defines the semantic
  `{key, op, value, negate}` shape both surfaces compile down to.
