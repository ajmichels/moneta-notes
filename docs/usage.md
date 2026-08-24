# Usage

Two ways to use `mnotes`: the **CLI** (terminal, `obsidian.nvim` integration) and the **MCP server**
(Claude Code / Claude Desktop). Both are thin wrappers around the same `core/` library, so behavior is
identical between them wherever a feature exists on both surfaces — see
[S006 — CLI](specs/S006-cli.md) and [S007 — MCP Server](specs/S007-mcp-server.md) for full detail.

Run `mnotes --help` or `mnotes <command> --help` any time for the in-tool version of this reference.

## Output formats

List-style commands (`search`, `grep`, `tags list`, `tags notes`, `links`) print pipe-delimited
columnar text by default, columns padded with whitespace so they stay visually aligned in a terminal,
with a `--json` flag for scripting or `obsidian.nvim` integration (JSON output is always compact, not
padded). Mutating commands (`write`/`edit`/`append`/`rename`) are always structured JSON
(`{ title, hash, line_count }`) — `--json` is a no-op for those.

`mnotes read` is the one exception: its default output is the raw note body (not JSON), so it pipes
naturally into `$EDITOR`, `less`, etc. See the table under [`mnotes read`](#mnotes-read-title) below.

The raw RRF score is never shown in `hybrid`-mode search output — only rank position, since a fused
score isn't independently meaningful. `fulltext` and `semantic` mode are single-signal, though: their
native score (`bm25_score` / `cosine_distance`, respectively) is meaningful on its own and appears
alongside rank in normal output for those modes. Use `--explain` on `search` if you need the RRF
formula breakdown or per-side ranks together for debugging.

Any JSON that lands on stderr (currently just `read`'s metadata) is pretty-printed for readability,
unlike the compact single-line JSON `--json` produces on stdout for scripting. When a command writes to
both streams, stderr is flushed before stdout.

## Commands

### `mnotes search <query>`

```sh
mnotes search "obsidian sync conflict"
mnotes search "vector search" --mode=semantic --limit=5
mnotes search "index_queue retry" --explain
```

Flags: `--mode=hybrid|fulltext|semantic` (default `hybrid`), `--limit=N`, `--explain`, `--json`.

`semantic`/`hybrid` mode embeds the query by asking the indexing daemon over its IPC socket (S005) —
neither the CLI nor the MCP server ever loads the embedding model itself, so this is a **hard error**
("could not connect to the daemon") if the daemon isn't running. `fulltext` mode has no such
dependency. Same behavior on the MCP `search` tool.

`--explain` is CLI-only debug output — a header line with the pipeline summary (mode, limit, overfetch),
followed by a column-headered, whitespace-aligned table showing raw BM25 score, raw cosine distance,
which chunk won the best-chunk-wins collapse, and the RRF score with its formula breakdown (columns vary
by mode). Useful for "why didn't note X show up" debugging; never exposed through MCP.

### `mnotes grep <pattern>`

```sh
mnotes grep "TODO"
mnotes grep '^\s*- \[ \]' --regex
mnotes grep "deadline" --note="Weekly Notes/2026-W32" --content
```

Flags: `--regex`, `--note=<title>` (restrict to one note — resolves the same way `read`'s `<title>`
does, see below), `--content` (show matched line text inline — CLI-only; the MCP tool always omits it
for context-budget reasons), `--json`.

### `mnotes tags list` / `mnotes tags notes <tag>`

```sh
mnotes tags list
mnotes tags notes "project/moneta-notes"
```

Flag: `--json`.

### `mnotes links <title>` / `mnotes links broken`

```sh
mnotes links "Weekly Notes/2026-W32"
mnotes links broken
```

`mnotes links <title>` shows the same `backlinks`/`links_out` data `mnotes read --json` returns for
that note, without pulling the rest of the note's content — `<title>` resolves the same way `read`'s
does (exact match, then unique-basename fallback; see below). `mnotes links broken` lists every
dangling `[[wikilink]]` in the vault — a link whose target doesn't resolve to any current note.
"Doesn't resolve" covers both "no note matches at all" and "the basename is ambiguous, shared by more
than one note" — treated the same, since neither has an obvious single note to point at. Both are
index-backed (current as of each note's last reindex), and `broken` is a reserved subcommand keyword
(a note literally titled "broken" isn't reachable via this command).

Flag: `--json`.

### `mnotes read <title>`

```sh
mnotes read "Weekly Notes/2026-W32"
mnotes read "Weekly Notes/2026-W32" --start=10 --end=40
mnotes read "Weekly Notes/2026-W32" --raw > backup.md
mnotes read "Weekly Notes/2026-W32" --json | jq -r .content_hash
```

| Mode | stdout | stderr |
|---|---|---|
| default | Note body only, frontmatter stripped | Parsed `metadata` object, as pretty-printed JSON |
| `--raw` | Exact file bytes as stored (frontmatter included), unmodified | Nothing |
| `--json` | Full structured JSON (`title`, `content_hash`, `metadata`, `content`, line info, `backlinks`, `links_out`) | Nothing |

In default mode, the metadata on stderr is written before the body on stdout, so it appears first when
both streams land in the same terminal.

Use `--json` (or read `content_hash` from `mnotes write`/`edit`'s own output) any time you need the
hash for a follow-up `write`/`edit`/`rename` call — see the next section.

`backlinks` (notes that link to this one) and `links_out` (notes this one links to) are both plain
arrays of note titles, parsed from Obsidian-style `[[wikilinks]]`. `links_out` always reflects the
note's full body, even when `--start`/`--end` narrow what's actually printed. `backlinks` is
index-backed — current as of the last reindex of whichever note contains the link, same freshness as
`search` results.

**`<title>` doesn't have to be the exact full title.** It resolves the same way Obsidian itself
resolves a bare `[[wikilink]]`: an exact match first, and if that misses, a fallback to whichever note
has that as its unique basename (the last path segment — e.g. `mnotes read "Barbara Garn"` finds a
note actually at `LoonStateHockey/JMS Hockey/Barbara Garn`, as long as no other note in the vault
shares that basename). This applies in all three output modes, including `--raw`. If the basename is
shared by more than one note, it's treated as unresolved (same as no match at all) — Obsidian itself
has no documented, guaranteed rule for that case, so this doesn't try to guess one. **The `title` field
in `--json` output is always the resolved, real title** — not necessarily whatever string you typed —
so it's the one to use for a follow-up `write`/`edit`/`append`/`rename` call (see next section).

### `mnotes write <title>`, `mnotes edit <title>`, `mnotes append <title>`, `mnotes rename <old> <new>`

**Every mutating call on an existing note requires a matching content hash** — read the note first
(`mnotes read <title> --json`) to get its current `content_hash`, then pass it as `--hash`. A missing
hash against an existing title is a hard error, not a silent overwrite — this is deliberate (see
CLAUDE.md's architecture rules): notes can change outside of any given session, so the hash check
protects against clobbering someone else's concurrent edit. Creating a **new** note (no existing title)
doesn't need a hash.

**`<title>`/`<old-title>`/`<new-title>` on these four commands must be the exact absolute title** —
unlike `read`/`grep --note=`/`links <title>`, there's no short-form/basename resolution here. If you
only have a short reference (say, text copied out of a `[[wikilink]]`), `mnotes read` it first — the
`title` field in its `--json` output is the real, absolute title to use here.

```sh
# create a new note (no hash needed — it doesn't exist yet)
echo "# Weekly Notes 2026-W33" | mnotes write "Weekly Notes/2026-W33"

# edit an existing note — hash required
hash=$(mnotes read "Weekly Notes/2026-W32" --json | jq -r .content_hash)
mnotes edit "Weekly Notes/2026-W32" --hash="$hash" --old="- [ ] draft docs" --new="- [x] draft docs"

# append — content from stdin or --content
mnotes append "Daily Notes/2026-08-13" --hash="$hash" --content="Shipped the docs pages."

# rename
mnotes rename "Weekly Notes/2026-W32" "Weekly Notes/2026-W32-archived" --hash="$hash"
```

`rename` also rewrites `[[Weekly Notes/2026-W32]]`-style references in every other note that links to
the one being renamed, so nothing in the vault is left pointing at a stale title. This happens
automatically as part of the rename call — no separate step needed.

**Attachment writes work differently** (see [`mnotes attachment`](#mnotes-attachment-readwrite)
below): no hash guard, since there's no diffable text content to protect against clobbering.

`write` and `append` read content from **stdin** if `--content` is omitted — works naturally with
`$EDITOR`-produced files, heredocs, or piped command output:

```sh
cat draft.md | mnotes write "Weekly Notes/2026-W33" --hash="$hash"
```

`edit`'s `--old`/`--new` are always flags (not stdin-eligible — a single stdin stream can't carry two
separate values). All four accept `--metadata='{...}'` to set structured frontmatter (never raw YAML
string manipulation).

These commands are logged to `audit.log` (`source: cli`, no `reason` — see
[Process Management](process-management.md#logs)) but don't wait for reindexing to complete; the
daemon's `fswatch` loop picks up the change asynchronously. Use `mnotes reindex <title>` if you need to
block until a specific note is reindexed.

### `mnotes attachment read|write`

```sh
mnotes attachment read "Attachments/receipt.pdf"                    # opens via the OS default app
mnotes attachment read "Attachments/receipt.pdf" --raw > backup.pdf # raw bytes to stdout
mnotes attachment read "Attachments/receipt.pdf" --metadata         # {path, size_bytes, mime_type}
mnotes attachment write "Attachments/receipt.pdf" ~/Downloads/receipt.pdf
curl -s https://example.com/report.pdf | mnotes attachment write "Attachments/report.pdf"
```

Read/write access to binary vault files that aren't notes — images, PDFs, anything a note references
via `![[...]]` or a markdown link. Unlike every other command here, **there's no index behind
attachments**, so `<path>` must be the exact vault-relative path (as it appears in the note's
reference) — no short-form/basename resolution, not even on the read side.

`mnotes attachment read`'s default action opens the resolved file with the OS default app (`open`) —
nothing is printed to stdout, since attachment bytes aren't meant to be dumped to a terminal. `--raw`
streams the exact bytes to stdout instead (useful for backing up a copy or piping elsewhere), subject
to the `[attachments].max_read_bytes` cap (see [Configuration](configuration.md#attachments));
`--metadata`/`--json` (aliases) print `{ path, size_bytes, mime_type }` with no bytes and no cap.

`mnotes attachment write <path> [local-file]` reads `<local-file>` off your local disk — or, if
omitted, raw bytes from stdin (the same fallback `write`/`append` already have for note content, see
above) — and writes it to `<path>` in the vault — always create-or-overwrite, no hash required (S012's
rationale: there's no diffable text content for a hash guard to protect).

### `mnotes reindex [title]`

```sh
mnotes reindex                              # full reindex
mnotes reindex "Weekly Notes/2026-W32"      # single note, streams attempt/retry progress
```

Talks to the *running* daemon over its Unix socket — hard error ("could not connect to the daemon") if
the daemon isn't up. Idempotent: running it twice with no intervening vault changes leaves the index in
the same state both times. See [Process Management](process-management.md) if this fails.

### `mnotes daemon <start|stop|restart>`

Controls the daemon process itself via `launchctl`, distinct from `reindex` above. Full detail in
[Process Management](process-management.md#mnotes-daemon-startstoprestart).

### `mnotes stats`

```sh
mnotes stats
mnotes stats --json
```

Note/tag/link counts (including `broken_link_count` — see `mnotes links broken` above for the full
listing), total/average note length, embedding model + version, count of notes pending re-embedding,
index file size, last full reindex time, daemon status, and current queue depth. Pure DB
reads plus a best-effort socket probe — never itself requires the daemon to be running.

### `mnotes vectors <subcommand>`

CLI-only debug/analysis tooling over the raw embedding space — see
[S013 — Vector Tools](specs/S013-vector-tools.md) for full detail on every subcommand. No MCP
equivalent (same rationale as `mnotes links`).

Unlike every other command, `vectors` has its own two-tier `--help`: `mnotes vectors --help` (or no
subcommand at all) lists every subcommand with a one-line description; `mnotes vectors <subcommand>
--help` prints that subcommand's full usage, argument, and flag documentation — each subcommand has
its own genuinely distinct flag set, so a single flat usage line (the convention every other command
here uses) wasn't enough.

#### `mnotes vectors compare <a> <b>`

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

#### `mnotes vectors nearest <note-title|chunk-id>`

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

#### `mnotes vectors cluster`

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

#### `mnotes vectors reduce`

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

#### `mnotes vectors tag-fit`

```sh
mnotes vectors tag-fit
mnotes vectors tag-fit --tag=project --threshold=0.6
```

Flags: `--tag=T` (omit to check every tag at once), `--threshold=F` (only show rows below this
similarity — omit to show all), `--format=table|json` (default `table`).

Does each note actually sit near the centroid of the tag(s) it carries? Output:
`tag | note_title | similarity_to_centroid`, sorted ascending (worst fit first). A tag with only one
member note is skipped — that note *is* the centroid, so 1.0 similarity is not a real signal.

#### `mnotes vectors tag-redundancy`

```sh
mnotes vectors tag-redundancy --threshold=0.85
```

Flags: `--threshold=F` (required — no general-purpose default for "probably duplicates"),
`--format=table|json` (default `table`).

Pairwise tag-centroid comparison, flagging tags that are probably duplicates of each other. Output:
`tag_a | tag_b | centroid_similarity`, sorted descending. Unlike `tag-fit`, a tag with a single member
note still gets a centroid here (that note's own vector).

#### `mnotes vectors outliers`

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

#### `mnotes vectors calibrate`

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

## MCP server (Claude Code / Claude Desktop)

Once registered (`claude mcp add mnotes ...` — done automatically by
[`scripts/install.sh`](installation.md) if `claude` is on `PATH`), the following tools are available to
Claude in any session:

`search`, `grep`, `tag_list`, `tag_notes`, `note_read`, `note_write`, `note_edit`, `note_append`,
`note_rename`, `attachment_read`, `attachment_write`

These map directly onto the CLI commands above (`note_read` ↔ `mnotes read`, etc.) and share the same
`core/` logic — same hashing rules, same size-drop guard, same "no raw scores" output, and the same
title-resolution split: `note_read`/`grep` accept a short or ambiguous title (resolved the same way
`mnotes read`'s does) and `note_read` always returns the real absolute title in its response;
`note_write`/`note_edit`/`note_append`/`note_rename` require the exact absolute title with no
resolution — each tool's own description states this.

`attachment_read`/`attachment_write` ([S012](specs/S012-attachments.md)) are unindexed, so
`attachment_path` always requires the exact vault-relative path, on both tools — no short-form
resolution even on the read side, unlike every note tool above. `attachment_read` returns file bytes as
base64 (`content_base64`, gated by `[attachments].max_read_bytes`) plus `size_bytes`/`mime_type`; for
PDFs, `total_pages` is also returned, and `start_page`/`end_page` (1-indexed, inclusive) fetch just that
page range as a standalone PDF instead of the whole file — useful once a PDF is too large for a
whole-file read, per the cap-exceeded error's own guidance. `attachment_write` is always
create-or-overwrite with no hash guard, since binary attachments have no diffable text content for that
guard to protect.

Two differences from the CLI:

- Every tool requires a **`reason<string>`** argument, logged for audit purposes (mirroring
  `description` on Claude Code's native file tools) — the CLI has no equivalent since a human typing
  the command *is* the reason.
- `--explain`, `--raw`, and `grep`'s `--content` (all CLI debug/ergonomics flags) have no MCP
  equivalent.

Check `claude mcp list` to confirm registration, and `mcp-server.log` /
[`audit.log`](process-management.md#logs) if a tool call isn't behaving as expected.
