# Vector Tools Usage

CLI-only debug/analysis tooling over the raw embedding space — see [Usage](usage.md) for the rest of
the `mnotes` command reference, and [S013 — Vector Tools](specs/S013-vector-tools.md) for full
behavioral detail on every subcommand below. No MCP equivalent (same rationale as `mnotes links`).

### `mnotes vectors <subcommand>`

Unlike every other command, `vectors` has its own two-tier `--help`: `mnotes vectors --help` (or no
subcommand at all) lists every subcommand with a one-line description; `mnotes vectors <subcommand>
--help` prints that subcommand's full usage, argument, and flag documentation — each subcommand has
its own genuinely distinct flag set, so a single flat usage line (the convention every other command
uses) wasn't enough.

Every subcommand also accepts `--vault=<name>` — parsed once, before dispatch, rather than listed
separately per subcommand below (same concept as every other command's `--vault`, see
[Usage](usage.md#multi-vault---vault)): required when 2+ vaults are configured and `default_vault`
isn't set. No fan-out — `vectors` is always a single-vault embedding-space analysis, and comparing
embeddings across two different vaults' corpora wouldn't be meaningful (potentially different
embedding models/dtypes, unrelated vector spaces).

### `mnotes vectors compare <a> <b>`

```sh
mnotes vectors compare "Weekly Notes/2026-W32" "Weekly Notes/2026-W33"
mnotes vectors compare "Note A" "Note B" --aggregate=best-chunk
mnotes vectors compare "Note A" "Note B" --aggregate=all-pairs
mnotes vectors compare 42 108 --level=chunk
```

Flags: `--level=note|chunk` (default `note`), `--aggregate=centroid|best-chunk|all-pairs` (default
`centroid`, note-level only — a usage error combined with `--level=chunk`), `--json`.

Direct pairwise similarity using each note's/chunk's **own stored embedding** — no query text, no
re-embedding. `note`-level `<a>`/`<b>` resolve the same way `mnotes read`'s `<title>` does (exact
match, then unique-basename fallback); `chunk`-level `<a>`/`<b>` are raw `chunks.id` integers.
`centroid` and `best-chunk` print a plain `similarity: <n>` line by default (`best-chunk` also prints
the winning `chunk_a`/`chunk_b` line spans); `all-pairs` always prints the full chunk × chunk
similarity matrix as JSON, regardless of `--json`.

### `mnotes vectors nearest <note-title|chunk-id>`

```sh
mnotes vectors nearest "Weekly Notes/2026-W32"
mnotes vectors nearest "Weekly Notes/2026-W32" --score
mnotes vectors nearest "Projects/Moneta" --against=chunk --k=5
mnotes vectors nearest 42 --level=chunk
```

Flags: `--level=note|chunk` (default `note`, query-side granularity), `--against=note|chunk` (default
matches `--level`, corpus-side granularity), `--aggregate=centroid|best-chunk` (note-level query only —
a usage error combined with `--level=chunk`), `--k=N` (default from `[vectors].nearest_k_default`,
see [Configuration](configuration.md#vectors)), `--score` (include the raw similarity in output —
rank-only by default), `--json`.

Nearest-neighbor lookup using an existing note's or chunk's **own stored embedding** as the query —
distinct from `search --mode=semantic`, which re-embeds typed query text. The query itself is always
excluded from its own results. `--against=chunk` output includes each hit's `chunk_line_start`/
`chunk_line_end`.

### `mnotes vectors cluster`

```sh
mnotes vectors cluster --algo=kmeans --k=8
mnotes vectors cluster --algo=hierarchical --cut-height=0.3 --folder="Weekly Notes"
mnotes vectors cluster --algo=dbscan --epsilon=0.25 --min-points=3 --format=json
```

Flags: `--level=note|chunk` (default `note`, always centroid at note level — no `--aggregate` flag on
this command), `--algo=kmeans|hierarchical|dbscan` (required), `--k=N` (kmeans cluster count, or an
alternative to `--cut-height` for hierarchical), `--cut-height=F` (hierarchical only), `--epsilon=F`
/`--min-points=N` (dbscan only, both required — no invented defaults), `--tag=T`/`--folder=P` (scope
filter, mutually exclusive), `--format=table|json` (default `table`).

Whole-vault (or scoped) grouping over full-dimensional vectors — never runs on a `reduce` projection.
`table` format shows `cluster_id | size | example_titles` (up to 3 titles per cluster, closest to its
centroid); `json` gives full membership. DBSCAN noise points get `cluster_id: -1`. Fewer points in
scope than requested (`--k` too large, too few points for a `--cut-height` cut) is a hard error, not a
silently smaller cluster count.

### `mnotes vectors reduce`

```sh
mnotes vectors reduce --algo=pca | uplot scatter -H -d,
mnotes vectors reduce --algo=umap --neighbors=15 --min-dist=0.1 --color-by=cluster
mnotes vectors reduce --algo=pca --dims=3 --format=json --output=points.json
mnotes vectors reduce --algo=pca --metadata --output=points.csv
```

Flags: `--level=note|chunk` (default `note`, always centroid at note level — no `--aggregate` flag),
`--algo=pca|umap` (required), `--dims=2|3` (default `2`), `--neighbors=N`/`--min-dist=F` (umap only —
a usage error combined with `--algo=pca`), `--tag=T`/`--folder=P` (scope filter), `--color-by=tag|
cluster|none` (default `none`), `--clusters=path` (reuse an already-saved
`vectors cluster --format=json --output=...` file instead of `--color-by=cluster` computing its own,
differently-parameterized clustering internally), `--output=path` (write to a file instead of
stdout), `--format=csv|json` (default `csv`), `--metadata` (`csv` only — see below).

Dimensionality reduction for visualization. **Streams to stdout by default** — the point is piping
straight into a plotting tool that reads delimited data from stdin (`uplot`, gnuplot's `plot '-'`), not
reading the output directly. `csv` is **coordinates only by default** — `x,y` at `--dims=2`, `x,y,z` at
`--dims=3`, nothing else — because a scatter tool that reads columns positionally can't just ignore
extra columns: `uplot scatter` in particular treats column 1 as `x` and plots *every remaining column*
as its own additional y-series, so an `id`/`title`/`label` column tacked on anywhere would render as
bogus extra series, not get silently skipped. Pass `--metadata` to append
`id,title[,chunk_line_start,chunk_line_end at --level=chunk],label` after the coordinates when you want
them — e.g. importing into a spreadsheet or a custom script that handles extra columns fine. `json`
always includes everything regardless of `--metadata`: `{ points: [...], metadata: { cluster_source }
}`, where `cluster_source` is `"internal"` or the `--clusters` path used, present only when
`--color-by=cluster`.

### `mnotes vectors tag-fit`

```sh
mnotes vectors tag-fit
mnotes vectors tag-fit --tag=project --threshold=0.6
```

Flags: `--tag=T` (omit to check every tag at once), `--threshold=F` (only show rows below this
similarity — omit to show all), `--format=table|json` (default `table`).

Does each note actually sit near the centroid of the tag(s) it carries? Output:
`tag | note_title | similarity_to_centroid`, sorted ascending (worst fit first). A tag with only one
member note is skipped — that note *is* the centroid, so 1.0 similarity is not a real signal.

### `mnotes vectors tag-redundancy`

```sh
mnotes vectors tag-redundancy --threshold=0.85
```

Flags: `--threshold=F` (required — no general-purpose default for "probably duplicates"),
`--format=table|json` (default `table`).

Pairwise tag-centroid comparison, flagging tags that are probably duplicates of each other. Output:
`tag_a | tag_b | centroid_similarity`, sorted descending. Unlike `tag-fit`, a tag with a single member
note still gets a centroid here (that note's own vector).

### `mnotes vectors outliers`

```sh
mnotes vectors outliers --mode=isolated --threshold=0.3
mnotes vectors outliers --mode=isolated --top=10
mnotes vectors cluster --algo=kmeans --k=8 --format=json --output=clusters.json
mnotes vectors outliers --mode=bridge --clusters=clusters.json --top=10
```

Flags: `--level=note|chunk` (default `note`, always centroid at note level — no `--aggregate` flag),
`--mode=isolated|bridge` (required), `--threshold=F` (`isolated` only — below this nearest-neighbor
similarity; mutually exclusive with `--top`), `--top=N` (either mode — the *n* most extreme results),
`--clusters=path` (required for `--mode=bridge` — a saved `vectors cluster --format=json --output=...`
file; bridge mode never recomputes its own clustering), `--format=table|json` (default `table`).
Whole-vault, no `--tag`/`--folder` scoping.

`isolated` reports each point's similarity to its single nearest neighbor, most isolated first.
`bridge` reports points that sit ambiguously between two clusters from the loaded `--clusters` file
(`cluster_a`/`cluster_b`, plus a `bridge_score` — highest when a point is equidistant between the two);
DBSCAN noise points (`cluster_id: -1`) are excluded from bridge scoring, since a noise point isn't
"between" clusters, it's unclustered.

### `mnotes vectors calibrate`

```sh
mnotes vectors calibrate
mnotes vectors calibrate --level=chunk --sample-size=1000 --format=json
```

Flags: `--level=note|chunk` (default `note`), `--sample-size=N` (default from
`[vectors].calibrate_sample_size`, see [Configuration](configuration.md#vectors) — size of the random
unlinked-pair baseline), `--format=table|json` (default `table`).

Empirical similarity-threshold finding from the vault's own link graph: compares the similarity
distribution of every actually-linked note pair (S011's link graph, broken links excluded) against a
random unlinked-pair baseline. `table` shows a `p10/p25/p50/p75/p90` percentile summary for both
populations; `json` dumps the full raw pairs (`{ linked: [...], unlinked: [...] }`) for plotting a
histogram elsewhere. If the linked distribution's low percentiles sit clearly above the unlinked
distribution's high percentiles, that gap is a reasonable place to pick a similarity threshold to use
elsewhere in your own workflow — this command doesn't pick one for you.
