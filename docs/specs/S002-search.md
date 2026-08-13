# S002 — Search

Status: **Approved**
Owns: `src/core/search.js`
Depends on: `S001-data-model`, `S010-shared-utilities`
Consumed by: `S006-cli`, `S007-mcp-server`

## Purpose

Defines how `core/search.js` answers `fulltext`, `semantic`, and `hybrid` queries over the tables
defined in S001, and how results collapse and merge into the note-level, rank-only output shape the
README commits to (no raw BM25/cosine/RRF scores ever surface — rank position only).

## Input

`query<string>`, `?mode<fulltext|semantic|hybrid>=hybrid`, `?limit<int>=20>` (max `100`).

This adds `limit` to what's currently documented in the README's `search` tool section — flagged as
a deviation to reconcile there.

The default (`20`) and max (`100`) are `config.toml` values, not hardcoded constants — flagged for
S009, same treatment as S005's tunables.

## Modes

| Mode | Fulltext side (`notes_fts`) | Semantic side (`chunk_vectors`) | Final ranking |
|------|------------------------------|-----------------------------------|----------------|
| `fulltext` | Raw FTS5 query DSL, passed straight to `MATCH` | not used | BM25 rank, ascending |
| `semantic` | not used | Query text embedded verbatim | Cosine distance, ascending, after best-chunk-wins collapse |
| `hybrid` (default) | Same passthrough as `fulltext` mode — identical query-building code path | Same embedding as `semantic` mode | RRF merge of both rankings |

### Fulltext query building

The fulltext side always passes the caller's `query` string straight to FTS5's `MATCH`, unmodified,
in every mode that uses it (`fulltext` and `hybrid` alike) — there is no separate
"sanitized-for-hybrid" code path. This means FTS5's query mini-language (`AND`/`OR`/`NOT`, `"phrase"`,
prefix `word*`, `NEAR(a b, N)`) is live in both modes, not gated behind `mode=fulltext`. Rationale:
the semantic side doesn't parse this syntax at all (it just embeds whatever text is given, operators
included, as ordinary tokens) — so there was no benefit to stripping/sanitizing it before hitting the
semantic side, and keeping one query-building function for the fulltext side (rather than two) is
simpler and removes a source of divergent behavior between modes.

**A malformed FTS5 expression is a hard tool error** in both `fulltext` and `hybrid` mode — consistent
with the "fail loudly" principle in CLAUDE.md, no silent degradation to semantic-only. This needs to
be reflected in the MCP tool's `description` (S007) so Claude knows FTS5 syntax errors are a live
possibility in the default mode, not just an opt-in `fulltext` mode.

### Semantic retrieval and chunk collapse

1. Embed `query` verbatim (same embedding pipeline as indexing, `indexer/embed.js` per S005).
2. Query `chunk_vectors` for the nearest `min(limit × 5, 500)` chunks by cosine distance, filtered to
   `chunks.embedding_model` / `chunks.embedding_version` matching the currently configured model.
   Chunks from a stale (not-yet-re-embedded) model version are silently excluded — comparing vectors
   across different embedding models is meaningless, not a degraded result, so there's nothing to
   surface to the caller here. Staleness is visible via `mnotes stats`, not search output.
3. Collapse to one row per note: **best chunk wins** — keep each note's single lowest-distance chunk,
   discard the rest. A note's semantic rank is its best chunk's rank among the collapsed list.

The `limit × 5` (capped at `500`) over-fetch exists because multiple chunks from the same note can
dominate the raw top-N chunk hits (e.g. three chunks of one long note outranking single chunks from
three different notes) — fetching more chunks than the final note limit, then collapsing, ensures the
note-level result list isn't artificially starved by chunk clustering. The multiplier (`5`) and cap
(`500`) are `config.toml` values — flagged for S009.

### Fulltext retrieval

Query `notes_fts` for the top `min(limit × 5, 500)` matching notes by BM25. Already one row per note
(no chunking on the fulltext side), so no collapse step is needed — the over-fetch here exists purely
to give the RRF merge (hybrid mode) enough candidates from both sides before truncating to `limit`.

### RRF merge (hybrid mode only)

Standard Reciprocal Rank Fusion, `k=60` (per README):

```
score(note) = Σ 1 / (k + rank_i)
```

summed over whichever of {fulltext rank, semantic rank} the note has (1-indexed position in that
list). A note present in only one list gets just that one term — there's no implicit zero-rank
penalty term for the list it's absent from, it simply doesn't contribute. Sort descending by
`score(note)`, take top `limit`. `k` (`60`) is a `config.toml` value — flagged for S009.

### Tie-breaking

Equal RRF score (hybrid) or equal native rank (single-mode) breaks by `notes.mtime` descending — most
recently modified note wins. Uses a column already in the S001 schema, no extra bookkeeping.

### Single-mode ranking

`fulltext`-only and `semantic`-only searches skip the RRF step entirely and sort directly by their
native ranking (BM25 ascending / cosine distance ascending after chunk collapse), then apply the same
`notes.mtime` descending tie-break.

## Output

Unchanged from the README's documented shape: `note_title`, `file_line_count`, and (in `hybrid` mode)
`fulltext_rank` / `semantic_rank` — rank position only, never raw scores. `file_line_count` and
`note_title` are read from the `notes` row (`line_count` column, `path` → title derivation per S010);
no additional query needed beyond what's already fetched during ranking.

## Logging

`core/search.js` calls `getContextLogger()` (per `S008`) — never imports `getLogger` directly, never
picks a log file or component name. No per-query line at `info`/`warn` for a normal, successful search
regardless of mode: that's the hot path (every `search` tool call), and a line per call would flood
`mcp-server.log` for zero diagnostic benefit over just reading the tool's own response. Two specific,
low-frequency conditions are worth a line:

- **Malformed FTS5 expression** — `warn`, `"malformed FTS5 query"`, context `{ query, mode }`, logged
  immediately before the hard error throws (per this spec's "fail loudly" rule above).
- **Stale-embedding-model chunks excluded from a semantic/hybrid query** — `debug`, `"excluded chunks
  from stale embedding model"`, context `{ excluded_count, current_model }`, once per query that hits
  this path. This is silent-by-design from the caller's perspective (see "Semantic retrieval and chunk
  collapse" above — `mnotes stats` is the intended surface for staleness, not search output) but worth
  a low-noise trail for diagnosing "why did a note I know matches not show up" without re-deriving it
  from `mnotes stats` at debug time.

`getContextLogger()` only does anything when a `runWithLogger` context is active. Per `S007`, the MCP
server wraps every tool call this way — `core/search.js` errors, including a malformed-query throw, are
*also* captured by `S007`'s per-call `logAudit(... outcome: 'error', error_message)` in `audit.log`, so
the `warn` line above is a convenience for `tail -f`/`grep`-ing `mcp-server.log` directly, not the only
record. Per `S006`, the CLI never establishes a `runWithLogger` context at all (its only use of the
logger is `audit.log` for mutations, and `search` isn't a mutation) — for a CLI-invoked `search`, both
lines above are no-ops, and a malformed-query error is visible only in the CLI's own stderr output at
the moment it happens, nowhere durable.

## Explicitly out of scope here

- **Chunking algorithm** (token counting, ~512/~15% overlap window construction) — S005.
- **Embedding pipeline invocation details** — S005 (`indexer/embed.js`); this spec assumes an
  `embed(text) -> float[1024]` function exists and calls it for the query text.
- **`--explain` CLI flag** (surfacing raw BM25/cosine/RRF numbers for debugging) — S006. This spec's
  "no raw scores in output" rule applies to the tool-facing `search` output; a CLI debug flag is a
  distinct, explicitly-opted-into surface and may show whatever's useful for debugging.
- **MCP tool description text** documenting the mode-dependent FTS5 DSL availability — S007.
