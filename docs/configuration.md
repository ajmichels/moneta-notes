# Configuration

Every tunable `mnotes` has, what it does, and its default. The authoritative spec for this behavior is
[S009 — Config & Install](specs/S009-config-and-install.md); this page is the practical reference.

## How `config.toml` works

- **Location**: `~/.config/mnotes/config.toml`.
- **Sparse override file, not a full dump.** Every value on this page is baked into `src/config.js` as
  a built-in default. `config.toml` only needs to contain the keys you actually want to change —
  anything absent falls through to its built-in default. A file containing just `vault_path` is
  entirely valid.
- **Often doesn't exist at all.** If you accepted every prompt's suggested default during
  `scripts/install.sh`, no `config.toml` is written — there's nothing to override. See
  [Installation](installation.md).
- **Read once at process startup**, not watched live. After hand-editing `config.toml`, restart
  whichever process the change affects: `mnotes daemon restart` for `[index]`, or just re-run the next
  `mnotes` command for CLI/MCP-server-side values (each CLI invocation and each MCP server process
  reads the file fresh on its own startup). See [Process Management](process-management.md).
- **Unrecognized keys** (typos, keys from a future version) are ignored at their built-in default and
  logged as a warning (`indexer.log` only — see [Process Management](process-management.md#logs)) —
  they never cause a hard error.
- [`config.example.toml`](../config.example.toml) shows the full schema below in one copy-pasteable
  file, annotated with which spec introduced each key. It's documentation only — copy the keys you
  want into your own `~/.config/mnotes/config.toml`, don't point `mnotes` at the example file itself.

## Top-level

| Key | Default | What it does |
|---|---|---|
| `vault_path` | `~/Documents/Notes` | Root directory of the Obsidian vault `mnotes` reads/writes/indexes. Prompted for during install. |
| `db_path` | `~/Library/Application Support/mnotes/index.db` (macOS) / `~/.local/share/mnotes/index.db` (Linux) | Path to the SQLite index file (FTS5 + sqlite-vec). Prompted for during install. |
| `embedding_model` | `"Qwen3-Embedding-0.6B"` | Which embedding model the indexing daemon loads for semantic search. Changing this requires a full reindex (`mnotes reindex`) — existing vectors were computed against the old model and won't compare meaningfully against the new one. |

## `[search]`

Tunes `search`'s ranking (fulltext / semantic / hybrid) — see
[S002 — Search](specs/S002-search.md).

| Key | Default | What it does |
|---|---|---|
| `limit_default` | `20` | Number of results `search` returns when the caller doesn't specify `limit`. |
| `limit_max` | `100` | Upper bound on `limit` — a caller-supplied value above this is capped, not rejected. |
| `overfetch_multiplier` | `5` | On the semantic side, how many chunks are fetched per requested result (`limit × overfetch_multiplier`) before collapsing to one best-chunk-per-note row. Exists because multiple chunks from one note can otherwise crowd out single chunks from other notes in the raw top-N. On the fulltext side, the same multiplier controls how many candidate notes are fetched before hybrid mode's RRF merge truncates to `limit`. |
| `overfetch_cap` | `500` | Hard ceiling on the over-fetch above, regardless of how large `limit × overfetch_multiplier` would otherwise be. |
| `rrf_k` | `60` | The `k` constant in Reciprocal Rank Fusion (`score = Σ 1 / (k + rank)`) used to merge fulltext and semantic rankings in `hybrid` mode. Higher values flatten the influence of rank position; lower values weight top ranks more heavily. Standard RRF default is `60`. |

## `[notes]`

Tunes note mutation safety guards — see [S003 — Notes](specs/S003-notes.md).

| Key | Default | What it does |
|---|---|---|
| `size_drop_threshold` | `0.50` | `note_write`/`note_edit` reject a write that drops the note's line count below this fraction of its prior line count (e.g. `0.50` = new content can't be less than half the old line count) unless the caller passes `force: true`. Guards against an accidental near-total overwrite. Applies to updates only, never to creating a new note. |

## `[grep]`

Tunes the raw-file `grep` tool — see [S004 — Grep & Tags](specs/S004-grep-tags.md).

| Key | Default | What it does |
|---|---|---|
| `line_match_cap` | `10` | Maximum number of matching line numbers shown per note in `grep` output before collapsing the rest into a `(+N more)` suffix. Applies per note, not to the total number of matching notes returned (which is always unbounded — `grep` is exhaustive, not relevance-ranked). |

## `[attachments]`

Tunes binary attachment read access — see [S012 — Attachments](specs/S012-attachments.md).

| Key | Default | What it does |
|---|---|---|
| `max_read_bytes` | `10000000` (~10MB) | `attachment_read`'s cap on returning base64-encoded file content. A file over this size with `include_content: true` (the default) errors, directing the caller to retry with `include_content: false` for metadata only. Doesn't apply to the CLI's default `open`-in-OS-app mode, only `--raw` and the MCP tool's `content_base64`. |

## `[vectors]`

Tunes `mnotes vectors` — see [S013 — Vector Tools](specs/S013-vector-tools.md).

| Key | Default | What it does |
|---|---|---|
| `nearest_k_default` | `10` | Default `--k` for `mnotes vectors nearest` when the flag is omitted. |
| `calibrate_sample_size` | `500` | Default `--sample-size` for `mnotes vectors calibrate` — size of the random unlinked-pair baseline sample. |

## `[index]`

Tunes the background indexing daemon — see [S005 — Indexing Daemon](specs/S005-indexing-daemon.md).

| Key | Default | What it does |
|---|---|---|
| `debounce_ms` | `15000` | How long (in milliseconds) the daemon waits after the last `fswatch` event for a given file path before rechecking it and enqueueing a reindex. Absorbs rapid successive saves (or an editor's temp-file-then-rename write pattern) into a single reindex pass instead of one per event. |
| `model_idle_unload_minutes` | `10` | How long the embedding pipeline can sit idle (no embedding calls) before the daemon unloads it from memory. The next embed request after an unload pays the load cost again (a few seconds). |
| `embedding_dtype` | `"q8"` | Precision the embedding model loads at — one of `fp32`, `fp16`, `q8`. `q8` (8-bit quantized) has the smallest memory footprint; `fp32` is full precision. Changing this changes the resulting vectors, so it requires a full reindex, same as changing `embedding_model`. |
| `retry_backoff_seconds` | `[30, 120, 600]` | Backoff delay (in seconds) before each retry after a failed reindex attempt (parse error, embedding error, etc.) — one entry per retry, in order. |
| `retry_max_attempts` | `4` | Total attempts (initial + retries) before a failing path is permanently dropped from the queue and logged as a permanent failure. This is **derived**, not independently settable — it's always `len(retry_backoff_seconds) + 1`; changing `retry_backoff_seconds`'s length changes this automatically. A `retry_max_attempts` value in `config.toml` that disagrees with the array length is ignored (the derived value wins), since the two could otherwise silently drift apart. |

## `[logging]`

Tunes log file rotation — see [S008 — Logging](specs/S008-logging.md).

| Key | Default | What it does |
|---|---|---|
| `rotation_max_size_mb` | `10` | A log file is rotated once it exceeds this size, in megabytes. |
| `rotation_max_age_days` | `7` | A log file is rotated once it's older than this many days, whichever threshold (size or age) is hit first. |
| `rotation_keep` | `5` | Number of rotated files kept per log (`indexer.log.1`, `indexer.log.2`, ...) before the oldest is deleted. |

## Example: overriding just a few values

```toml
# ~/.config/mnotes/config.toml
vault_path = "/Users/jsmith/Documents/Notes"

[search]
limit_default = 10

[index]
model_idle_unload_minutes = 30
```

Every other key — `db_path`, `embedding_model`, `[notes]`, `[grep]`, `[attachments]`, `[logging]`, and
the rest of `[search]`/`[index]` — falls through to its built-in default, unaffected by this file.
