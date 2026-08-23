# S013 — Vector Tools

Status: **Approved**
Owns: `src/core/vectors.js`, `src/cli/vectors.js`
Amends: `S006-cli` (adds `vectors` to the command dispatch table)
Depends on: `S001-data-model`, `S002-search`, `S005-indexing-daemon`, `S010-shared-utilities`
Consumed by: (terminal use only — see "Not exposed via MCP" below)

## Purpose

Adds an `mnotes vectors <subcommand>` namespace: introspection and analysis tools over the raw
chunk/note embeddings that `S002-search` already computes and stores, but never otherwise surfaces.
Where `search` answers "what matches this text," `vectors` answers questions about the embedding
space itself — "what's actually near this note," "do these notes cluster the way my tags say they
should," "which tags are redundant," "what's isolated from everything else," "what similarity
threshold would actually separate linked from unlinked notes." Debugging/analysis tooling for a human
at a terminal, not agent-facing — see "Not exposed via MCP."

Seven subcommands: `compare`, `nearest`, `cluster`, `reduce`, `tag-fit`, `tag-redundancy`,
`outliers`, plus `calibrate`. All read-only — nothing here writes to the vault or the index.

## Not exposed via MCP

Same rationale S006 gives for `mnotes links`: this is debugging/analysis tooling for AJ, not
something Claude needs mid-session, and the README's "don't add MCP resources" instinct extends here
by analogy — no tool schema, no `reason` argument, no `mcp/tools.js` entries. If a future need
surfaces for Claude to consume one of these (`compare`/`nearest` are the plausible candidates, being
cheap single-answer lookups), that's a new decision to make explicitly then, not a default to reach
for now.

## New dependencies

Five focused `ml-*` / clustering npm packages, matching the precedent already set by pulling in
`@huggingface/transformers` for embeddings rather than hand-rolling a transformer runtime — these
algorithms are easy to get subtly wrong by hand (especially UMAP's gradient-descent layout), and
correctness matters more here than minimizing dependency count:

| Package | Used for |
|---|---|
| `ml-kmeans` | `cluster --algo kmeans` |
| `ml-hclust` | `cluster --algo hierarchical` |
| `density-clustering` | `cluster --algo dbscan` |
| `ml-pca` | `reduce --algo pca` |
| `umap-js` | `reduce --algo umap` |

All five are pure-JS, no native bindings, no Python — consistent with CLAUDE.md's "Language &
Runtime" rule.

## Shared vocabulary

Two flags standardize across every subcommand that takes them — not every subcommand takes both, see
each command's table below.

- **`--level chunk|note`** — granularity of the vectors being operated on. `chunk` operates on raw
  stored `chunk_vectors` rows directly. `note` collapses each note's chunks into a single vector
  first.
- **`--aggregate centroid|best-chunk|all-pairs`** — *only accepted where a command compares two
  specific things* (`compare` and `nearest`'s query-side aggregation). `cluster`, `reduce`, and
  `outliers` need exactly one vector per note at `--level note` and don't accept `--aggregate` at
  all — passing it to one of those three is a CLI usage error (`--aggregate is not valid with this
  command`), not a silently ignored flag. Where note-level aggregation is needed but not
  caller-specified (`cluster --level note`, `reduce --level note`, `outliers --level note`), it is
  always **centroid**, unconditionally — never configurable, never defaulting to something else. This
  is deliberate: mixing aggregation strategies across `cluster`/`reduce`/`outliers` for the "same"
  note-level view of the data would make the three commands' outputs subtly incomparable with each
  other, defeating the point of having one note-level vector at all.

### Shared core helper: `getNoteVector`

`core/vectors.js` exports `getNoteVector(db, noteId, { aggregate = 'centroid' })`, returning
`Float32Array | null` (`null` if the note has no chunks, e.g. empty file). Every code path in this
spec that needs "one vector for this note" — `cluster --level note`, `reduce --level note`,
`outliers --level note`, `compare`/`nearest` at note-level, `tag-fit`, `tag-redundancy`,
`calibrate --level note` — calls this one function, never hand-rolls its own averaging. This is the
CLAUDE.md "no duplicate logic" rule applied one layer down from `cli`/`mcp`: it would be easy for
`cluster --level note` and `reduce --level note` to each grow their own slightly different centroid
math over time and produce inconsistent-looking results across two views of the same data.

- **`centroid`**: mean of the note's chunk vectors, re-normalized to unit length (cosine distance
  assumes unit vectors; a plain mean of unit vectors is not itself unit length).
- **`best-chunk`**: not a `getNoteVector` mode — "best" is only meaningful relative to a comparison
  target, so it's implemented directly in `compare`/`nearest`, not as a third branch here.

### `core/vectors.js`: reading raw vectors back out of `chunk_vectors`

S002's `runSemanticQuery` only ever *queries* `chunk_vectors` via `MATCH`; nothing in the codebase
today reads a stored embedding back out as a plain `Float32Array`. This spec adds that:

```js
function bufferToVector(buf) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
```

the exact inverse of `search.js`'s existing `vectorToBuffer`. `core/vectors.js` exports
`getChunkVectors(db, chunkIds)` (batched `SELECT rowid, embedding FROM chunk_vectors WHERE rowid IN
(...)`, decoded) and `getAllChunkVectors(db, { noteIds } = {})` (every chunk for the current
embedding model/version, optionally restricted to a note-id set — see "Scoping" below) as the two
primitives everything else in this spec is built from. Both exclude chunks from a stale embedding
model/version (same filter S002's semantic search already applies), for the same reason: comparing
vectors across model versions is meaningless, not a degraded result.

### Cosine similarity

`core/vectors.js` exports `cosineSimilarity(a, b) -> float` (`[-1, 1]`, `1` = identical direction).
Every subcommand in this spec reports **similarity** (higher = closer), not sqlite-vec's raw cosine
*distance* (`1 - similarity`, lower = closer) that `S002`'s `chunk_vectors` queries use internally —
the words "similarity" throughout this spec and in every command's output always mean the similarity
form, not distance, since a human reading `vectors` output benefits from "higher is better" being
uniformly true. This is a distinct concern from CLAUDE.md's "don't show raw RRF/BM25/cosine scores"
rule — that rule is about the MCP/CLI-shared `search` surface never leaking ranking internals;
`vectors` is a CLI-only debug/analysis surface whose entire purpose is exposing exactly these numbers
(same carve-out `--explain` already uses, per S006).

### Scoping: `--tag <tag>` / `--folder <path>`

`cluster` and `reduce` accept `--tag`/`--folder` (mutually exclusive — passing both is a usage error)
to restrict the note-id set operated on, instead of the whole vault:

- `--tag <tag>` — reuses `core/tags.js`'s existing `tagNotes(db, tagName)` to get the note-id set; a
  tag with zero notes is an empty result set, not an error (consistent with `tagNotes` itself).
- `--folder <path>` — a `notes.path` prefix match (`WHERE path LIKE ? || '%'` guarded against
  `%`/`_` wildcard injection from the caller-supplied path, since `path` is user input here in a way
  it isn't elsewhere in this codebase). Matches on the vault-relative folder path, e.g. `--folder
  "Weekly Notes"` matches every note under that directory.

## Commands

### `mnotes vectors compare <a> <b>`

Direct pairwise comparison — the primitive every other subcommand's "how close are these two things"
logic reduces to.

| Flag | Values | Notes |
|---|---|---|
| `--level` | `chunk\|note`, default `note` | `chunk` mode: `<a>`/`<b>` are chunk ids (integers, `chunks.id`). `note` mode: `<a>`/`<b>` are note titles, resolved via `resolveTitle` (S010) — same exact-then-basename fallback `mnotes read` gets, since this is a read-only lookup. |
| `--aggregate` | `centroid\|best-chunk\|all-pairs`, default `centroid` | Note-level only — chunk-level ignores this (a usage error if passed alongside `--level chunk`, since two specific chunks need no aggregation strategy). |

Output:
- `centroid`/`best-chunk`: `{ similarity }` — for `best-chunk`, also `{ chunk_a: {line_start,
  line_end}, chunk_b: {line_start, line_end} }` identifying which chunk pair won (the pair across all
  of A's chunks × B's chunks with the highest similarity — an O(chunks_a × chunks_b) exhaustive
  comparison, acceptable at this vault's scale per S001's "thousands of notes, not millions" framing;
  revisit only if a single note's chunk count grows large enough for this to matter).
- `all-pairs`: full `chunks_a × chunks_b` similarity matrix, JSON-only (`--format table` is a usage
  error for `all-pairs` — there's no sensible fixed-width table for a matrix whose dimensions vary per
  call). Shape: `{ chunks_a: [{id, line_start, line_end}], chunks_b: [...], matrix: number[][] }`
  (`matrix[i][j]` = similarity between `chunks_a[i]` and `chunks_b[j]`).

### `mnotes vectors nearest <note-title|chunk-id>`

Nearest-neighbor lookup using an existing note's or chunk's own stored embedding as the query
vector — distinct from `search --mode semantic`, which re-embeds typed query text. This answers "what
is this note actually closest to" with no query-formulation step in between.

| Flag | Values | Notes |
|---|---|---|
| `--level` | `chunk\|note`, default `note` | Query-side granularity: is `<note-title\|chunk-id>` a note (resolved via `resolveTitle`) or a raw chunk id? |
| `--against` | `chunk\|note`, default matches `--level` | Corpus-side granularity — lets `--level note --against chunk` ask "which chunks are nearest this note's centroid," independent of what granularity the query side used. |
| `--aggregate` | `centroid\|best-chunk`, default `centroid` | Only meaningful when `--level note` (the query side needs collapsing to one vector) — a usage error combined with `--level chunk`. `all-pairs` is not a valid value here (there is no pairwise matrix to speak of for a k-NN scan against a whole corpus). |
| `--k` | int, default `10` | Config-backed default, `[vectors].nearest_k_default` — see "Config" below. |
| `--score` | flag | Include raw similarity in output, not rank position only — the CLAUDE.md "no raw scores" rule is a `search`-surface rule (see "Cosine similarity" above), doesn't apply here; without this flag, output is rank-only. |

The query note/chunk itself is always excluded from its own results.

Output (table): `rank | note_title` (`--against note`) or `rank | note_title | chunk_line_start |
chunk_line_end` (`--against chunk`), with a trailing `similarity` column when `--score` is passed.
`--format json` gives the same fields as structured JSON.

### `mnotes vectors cluster`

Whole-vault (or `--tag`/`--folder`-scoped) grouping. Always runs on full-dimensional vectors,
regardless of any `reduce` output that may exist for the same scope — clustering on a 2D/3D
projection throws away exactly the structure the clustering is trying to find, so `cluster` never
reads a `reduce` output file as input, and `reduce`'s own `--color-by cluster` (below) is the only
place the two commands' outputs meet.

| Flag | Values | Notes |
|---|---|---|
| `--level` | `chunk\|note`, default `note` | Note-level is always centroid (see "Shared vocabulary" above) — no `--aggregate` flag on this command. |
| `--algo` | `kmeans\|hierarchical\|dbscan`, required | |
| `--k` | int | `kmeans`: cluster count (required for `kmeans`). `hierarchical`: alternative to `--cut-height` for cutting the dendrogram to a fixed cluster count — exactly one of `--k`/`--cut-height` required for `hierarchical`, giving both or neither is a usage error. |
| `--cut-height` | float | `hierarchical` only, see above. |
| `--epsilon` / `--min-points` | float / int | `dbscan` only, both required (`density-clustering`'s own required parameters — no invented defaults, since a reasonable epsilon is entirely dependent on the embedding space's actual density, which this command has no basis to guess at). |
| `--tag` / `--folder` | string | Scope filter, see "Scoping" above. Mutually exclusive with each other; both compatible with any `--algo`. |
| `--format` | `table\|json`, default `table` | `table`: `cluster_id \| size \| example_titles` (up to 3 example titles per cluster, closest to that cluster's centroid). `json`: full membership, `{cluster_id, note_title}[]` (or `chunk_id` at `--level chunk`) — DBSCAN's noise points (unclustered) get `cluster_id: -1`, `density-clustering`'s own convention, not remapped. |

Fewer notes in scope than `--k` (kmeans) or too few points for the requested cut (hierarchical) is a
hard error, not a silently-reduced cluster count — "fail loudly" per CLAUDE.md, since a silently
smaller `k` would misrepresent what was actually asked for.

### `mnotes vectors reduce`

Dimensionality reduction for visualization. Streams to **stdout by default** — the primary intended
use is piping straight into a plotting tool that reads delimited data from stdin (`mnotes vectors
reduce --algo pca | uplot scatter -H -d,`, or gnuplot's `plot '-' using 3:4 with points`), not reading
the output directly in a terminal or saving it first.

| Flag | Values | Notes |
|---|---|---|
| `--level` | `chunk\|note`, default `note` | Same centroid-always rule as `cluster` — no `--aggregate` flag. |
| `--algo` | `pca\|umap`, required | |
| `--dims` | `2\|3`, default `2` | |
| `--neighbors` / `--min-dist` | int / float | `umap` only (`umap-js`'s `nNeighbors`/`minDist`); usage error if passed with `--algo pca`. Defaults to `umap-js`'s own library defaults (`15` / `0.1`) if omitted — unlike `cluster`'s dbscan params, these have reasonable general-purpose defaults per the library's own documentation, so there's a real default to fall back on here. |
| `--tag` / `--folder` | string | Scope filter, same as `cluster`. |
| `--color-by` | `tag\|cluster\|none`, default `none` | `tag`: each point's `label` is its note's first tag alphabetically (a note can carry several; picking one deterministically beats an arbitrary list in a single `label` field — full tag list is available separately via `tag_list`/`tag_notes` if needed). `cluster`: runs `cluster` internally with `--algo kmeans --k` chosen by a fixed heuristic (`min(10, floor(sqrt(n_points / 2)))`, floored at `2`) unless the caller already has cluster output they'd rather point at — see below. |
| `--output` | path, optional | Write to a file instead of stdout — same content either way, only the destination changes. Omitted (the default) streams to stdout. |
| `--format` | `csv\|json`, default `csv` | `csv` is the default because the primary consumer is a stdout-piped plotting tool, not a script parsing JSON — a bare header row (`id,title,x,y,z,label`, `z` empty at `--dims 2`) plus one data row per point, nothing else on stdout, so no output-mode flag is needed to keep other tools' stdin clean. `json` remains available for programmatic consumption (`{ points: [...], metadata: {...} }`, see below) and is unaffected by `--output`. |

If `--color-by cluster` and the caller wants to reuse an already-inspected clustering rather than a
freshly (and differently-parameterized) computed one, they run `cluster --format json --output
clusters.json` themselves first and pass it via `--clusters clusters.json` — same reproducibility
rationale `outliers --mode bridge` uses its own `--clusters` flag for (see below). Without
`--clusters`, the internal fixed-heuristic run is exactly that: a convenience default, not
reproducible against a specific clustering decision. At `--format json`, the output's `metadata`
records `{ cluster_source: "internal" | "<path>" }` so a later reader can tell which happened; at
`--format csv` there is no metadata home (stdout must stay a clean, tool-parseable data table with
nothing else mixed in) — provenance tracking here means using `--format json`, not a `#`-comment
smuggled into the CSV.

Output shape, per point: `id, title, x, y, z, label` (`z` empty/omitted at `--dims 2`). At `--format
json`: `{ points: [{id, title, x, y, z?, label}], metadata: {...} }`. At `--format csv` (the default):
the same fields as a bare header row followed by one row per point, nothing else — no metadata, no
surrounding object, so the stream is directly consumable by a plotting tool's stdin with no unwrapping
step. `id` is `note_id`/`chunk_id` depending on `--level`; `title` is the note title (`--level chunk`
still reports the parent note's title alongside the chunk, plus `chunk_line_start`/`chunk_line_end`
columns, since a bare chunk id is meaningless on a plot's hover tooltip without it).

### `mnotes vectors tag-fit [--tag <tag>]`

Does each note actually sit near the centroid of the tag(s) it carries? Omit `--tag` to check every
tag at once.

| Flag | Values | Notes |
|---|---|---|
| `--tag` | string, optional | Restrict to one tag; omitted means all tags. |
| `--threshold` | float, optional | Only show rows below this similarity. Omitted means show all rows. |
| `--format` | `table\|json`, default `table` | |

For each `(tag, note)` pair where the note carries that tag, computes similarity between the note's
centroid (`getNoteVector`, `centroid`) and the tag's centroid (mean of every member note's centroid,
re-normalized — the same `getNoteVector`-style unit-renormalization, computed once per tag per
invocation, not memoized across a whole-vault `--tag`-omitted run beyond that). A tag with only one
member note is skipped (that note *is* the centroid — similarity 1.0 is a definitionally
uninteresting result, not a real signal, so it's excluded rather than clutter every single-note tag
into the output).

Output (table): `tag | note_title | similarity_to_centroid`, sorted ascending by similarity (worst
fit first — the point of this command is finding the outliers).

### `mnotes vectors tag-redundancy`

Pairwise tag-centroid comparison — flags tags that are probably duplicates of each other.

| Flag | Values | Notes |
|---|---|---|
| `--threshold` | float, required | Minimum centroid similarity to report — no default, since "probably duplicates" is entirely dependent on how the vault's tags are actually used; an invented default threshold would produce a plausible-looking but arbitrary list. |
| `--format` | `table\|json`, default `table` | |

Every tag with ≥ 1 member note gets a centroid (per `tag-fit` above); every pair of distinct tags
above `--threshold` is reported, sorted descending by similarity. `O(tags²)` — fine at this vault's
tag-count scale (dozens to low hundreds, not thousands).

Output (table): `tag_a | tag_b | centroid_similarity`.

### `mnotes vectors outliers`

| Flag | Values | Notes |
|---|---|---|
| `--level` | `chunk\|note`, default `note` | Same centroid-always rule as `cluster`/`reduce` — no `--aggregate` flag. |
| `--mode` | `isolated\|bridge`, required | |
| `--threshold` | float | `isolated` only: report notes/chunks whose nearest-neighbor similarity is *below* this. Mutually exclusive with `--top`. |
| `--top` | int | Either mode: show the `n` most extreme results instead of thresholding. Mutually exclusive with `--threshold` in `isolated` mode; the only option in `bridge` mode (bridge has no natural threshold — see below). |
| `--clusters` | path, required for `--mode bridge` | Path to a `cluster --format json --output ...` file. `bridge` mode needs cluster assignments and deliberately never computes its own — same reproducibility rationale as `reduce --color-by cluster`'s `--clusters` option: a bridge point is only meaningful relative to a clustering you've actually inspected, not one silently recomputed with arbitrary parameters on every `outliers` call. |

- **`isolated`**: for every note/chunk in scope, its similarity to its single nearest neighbor
  (excluding itself) — sorted ascending (most isolated first), then thresholded or top-N'd per the
  flags above.
- **`bridge`**: for every note/chunk, find its two nearest *different* clusters (per the loaded
  `--clusters` assignments) and score `1 - |sim_to_nearest_cluster - sim_to_second_nearest_cluster|`
  (a point equidistant between two clusters' centroids scores highest — it's genuinely ambiguous which
  cluster it belongs to). Points DBSCAN marked as noise (`cluster_id: -1`, see `cluster` above) are
  excluded from bridge scoring — a noise point isn't "between" clusters, it's unclustered, a different
  condition `isolated` mode already covers. Sorted descending by bridge score, then top-N'd (`--top`
  only — no `--threshold` in this mode, since the score's scale isn't independently meaningful the way
  a raw similarity threshold is).

Output: `note_title | nearest_neighbor_similarity` (isolated) or `note_title | cluster_a | cluster_b |
bridge_score` (bridge). `--format json` available on both.

### `mnotes vectors calibrate`

Empirical similarity-threshold finding from the vault's own link graph — answers "what similarity
score would actually distinguish notes that link to each other from ones that don't," grounded in
real vault structure rather than a guessed constant.

| Flag | Values | Notes |
|---|---|---|
| `--level` | `chunk\|note`, default `note` | Note-level is the natural fit since `note_links` (S011) is note-to-note; `chunk` mode compares every chunk-pair between two linked/unlinked notes and keeps the max (mirroring `compare --aggregate best-chunk`'s "best pair wins" logic), rather than inventing a separate chunk-level linkage concept that doesn't otherwise exist in this codebase. |
| `--sample-size` | int, default `500` | Config-backed default, `[vectors].calibrate_sample_size` — see "Config" below. Size of the random *unlinked*-pair baseline sample (see below). |
| `--format` | `table\|json`, default `table` | `table`: percentile summary (p10/p25/p50/p75/p90) of both distributions. `json`: full raw pairs, `{ linked: [{note_a, note_b, similarity}], unlinked: [...] }`, for plotting a histogram externally. |

Two populations, both at whatever `--level`'s vector granularity resolves to:
1. **Linked pairs**: every `note_links` row (S001/S011) where *both* `target_title` and the source
   resolve to an actual indexed note (a link to a non-existent note, per S011's broken-link tracking,
   has no target vector to compare — silently excluded, not an error, since `mnotes links broken`
   already owns surfacing that condition). Every such pair's similarity is computed — no sampling on
   this side, since the point is the *actual* linked-pair distribution, not an estimate of it.
2. **Unlinked baseline**: `--sample-size` pairs drawn uniformly at random from all pairs of indexed
   notes that have **no** `note_links` row between them in either direction, with a fixed-seed PRNG
   (`node:crypto`'s `randomInt`... no — deterministic reproducibility isn't a stated goal here, plain
   `Math.random()`-backed sampling is fine) — re-running `calibrate` is expected to give a very
   similar, not byte-identical, unlinked-pair sample each time, which is acceptable since the point is
   the *distribution*, not any individual sampled pair.

The table output's practical read: if the linked distribution's p10 sits clearly above the unlinked
distribution's p90, there's a real gap — the midpoint between those two numbers is a reasonable
similarity threshold to use elsewhere (e.g. `tag-fit`/`tag-redundancy`/`outliers --mode isolated`'s
`--threshold` flags) if AJ wants one, in some future decision, not something this command decides on
his behalf.

## Config

New `[vectors]` `config.toml` section (S009-pattern, `resolveConfig`/`buildDefaultConfig` per
`src/config.js`), covering only the two flags above that have genuine general-purpose defaults —
everything else in this spec (dbscan's epsilon/min-points, tag-redundancy's threshold, cluster's `k`)
is deliberately unset/required per-invocation rather than defaulted, per each command's own table
above:

```toml
[vectors]
nearest_k_default = 10
calibrate_sample_size = 500
```

## `core/vectors.js` surface (implementation-level, non-exhaustive)

Exported for `cli/vectors.js` to call and for direct unit testing (per CLAUDE.md's "unit-test `core/`
directly" rule) — exact function signatures are an implementation detail, but the module boundary
matters: everything below takes plain JS arguments (a `db` handle plus primitives), returns plain JS
data, throws on error. No CLI flag parsing, no output formatting, no knowledge that "table vs JSON" is
even a concept — that all lives in `cli/vectors.js`, per CLAUDE.md's core/cli separation rule.

- `cosineSimilarity(a, b)`
- `getChunkVectors(db, chunkIds)` / `getAllChunkVectors(db, { noteIds } = {})`
- `getNoteVector(db, noteId, { aggregate = 'centroid' } = {})`
- `compareVectors(db, a, b, { level, aggregate })`
- `nearestNeighbors(db, query, { level, against, aggregate, k })`
- `clusterVectors(db, { level, algo, ...algoParams, noteIds })`
- `reduceVectors(db, { level, algo, dims, ...algoParams, noteIds })`
- `tagFit(db, { tag, threshold })`
- `tagRedundancy(db, threshold)`
- `findOutliers(db, { level, mode, threshold, top, clusters })`
- `calibrate(db, { level, sampleSize })`
- `resolveScopeNoteIds(db, { tag, folder })` — shared by `cluster`/`reduce`'s `--tag`/`--folder`.

## Logging

Per S008's pattern, `core/vectors.js` calls `getContextLogger()`, never `getLogger` directly. Matching
S006's treatment of every other CLI-only, non-mutating command (`search`, `grep`, `tags`, `links`):
`cli/vectors.js` establishes no `runWithLogger` context, so these calls resolve to the no-op logger
in normal CLI use — there's no daemon or MCP caller of this module for a real logging context to ever
attach to. No audit-log entry either: every subcommand here is read-only, and S008's audit trail is
specifically for mutations.

## Explicitly out of scope here

- **Any write path** — nothing in this spec ever modifies the vault or the index; `reduce`'s optional
  `--output` file (stdout is the default, per "`mnotes vectors reduce`" above) is the one thing this
  spec ever writes to disk, and it's an artifact outside the vault/index either way, not a mutation of
  either.
- **Persisting cluster assignments back into the database** — `cluster`'s output is a point-in-time
  JSON/table snapshot to be piped to a file and reused via `--clusters`, not a new `chunks`/`notes`
  column or table. Revisit only if a future spec wants clustering to become a first-class, queryable
  part of the index rather than an ad hoc analysis output.
- **MCP exposure** — see "Not exposed via MCP" above; a future decision, not this spec's.
- **Exact JSON field naming/nesting beyond what's stated per-command** — same latitude S006 gives
  `--explain`'s JSON shape.
