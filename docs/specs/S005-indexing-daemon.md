# S005 — Indexing Daemon

Status: **Approved**
Owns: `src/indexer/daemon.js`, `src/indexer/embed.js`
Depends on: `S001-data-model` (including `enqueuePath`, which this file re-exports), `S004-grep-tags`
(tag extraction, invoked here during processing), `S009-config-and-install` (`src/platform` supplies
this daemon's app-support/log directory paths — see below), `S010-shared-utilities`, `S011-links` (link
extraction, invoked here during processing)
Consumed by: `S006-cli` (reindex/stats/search talk to this daemon), `S007-mcp-server` (search talks to
this daemon), `S009-config-and-install` (new config knobs introduced here)

## Purpose

Defines the long-running, OS-service-managed daemon (`launchd` on macOS, `systemd --user` on Linux —
S009 owns which): startup catch-up, live `fswatch`-driven indexing, the embedding pipeline's lifecycle
(load/idle-unload), and the Unix-socket IPC that lets the CLI and MCP server drive the same warm daemon
rather than loading their own model copy per invocation/process.

**`fswatch` itself needs no platform branching.** It's a portable CLI binary — kqueue-backed on macOS,
inotify-backed on Linux — and `daemon.js`'s `spawnFswatch`/`assertFswatchAvailable` shell out to it
identically on both, no `process.platform` check anywhere in this file. Only `daemon.js`'s two path
helpers (`defaultAppSupportDir()`, and `defaultLogDir()` imported from `src/logger.js`) are
platform-dependent, and both now delegate to `src/platform` (S009) instead of hardcoding
`~/Library/...` — see S009's platform-abstraction section for the exact `appSupportDir()`/`logDir()`
contract.

`index_queue` (S001) is the **single path for all indexing work**, not just explicit `mnotes reindex`
calls — every live `fswatch`-triggered change funnels through the same debounce → enqueue → drain
pipeline as an explicit reindex request. This is what gives the system its resilience under bursts of
activity (a flurry of saves, a bulk file operation, a big `git checkout`): everything lands in one
durable, serially-drained queue rather than being handled by different code paths depending on how it
was triggered.

## Startup sequence

1. **Schema check** (S001): compare `meta.schema_version` to the code's current version; rebuild all
   tables if mismatched (triggers a full reindex via step 2 finding every note "newer" than an
   empty/reset watermark).
2. **Watermark catch-up**: compute `MAX(notes.updated_at)` across the `notes` table (0 if empty —
   this is what makes first-run naturally index the entire vault, no special-cased "initial index"
   path needed). Walk the vault (skipping excluded paths — see "Path exclusion" below), and for every
   `.md` file whose mtime is newer than the watermark, enqueue its path into `index_queue`. This
   catches anything changed while the daemon was down (crash, machine sleep, disabled), without a full
   unconditional walk-and-reprocess of every file.
3. **Existence check**: for every path currently in `notes`, verify it still exists on disk (a cheap
   `stat`, not a content read). Delete rows (cascading to `chunks`/`chunk_vectors`/`note_tags`/
   `note_links` per S001's `ON DELETE CASCADE`) for any that don't — catches deletions that happened
   while the daemon was down, which the watermark pass alone can't (a deleted file has no mtime to
   compare).
3a. **Ignored-paths check**: for every path currently in `notes`, delete the row (same cascade as
   above) if it now matches `.mnotesignore` (see "Path exclusion"). This is what makes adding a new
   `.mnotesignore` pattern self-healing — a note indexed before the pattern existed gets purged on the
   next daemon start, without anyone needing to touch the file itself or reason about what's already in
   the index. Skipped in the same case existence-check is (a schema rebuild leaves `notes` empty, so
   there's nothing to sweep).
4. Start the `fswatch` watcher on the vault directory.
5. Start the queue drainer (processes `index_queue` continuously — see below).
6. Start the Unix-socket IPC listener (see below).

### Path exclusion

Two kinds of path never enter the index, checked at every point a path could reach one (the startup
walk, the live `fswatch` callback, and `processPath` itself, which purges a stray already-indexed row
for either kind the same way regardless of how it got there — a leftover `index_queue` row from before
the exclusion existed, or an explicit `mnotes reindex <title>` naming one):

- **Dotfiles and dot-directories** (`.obsidian/`, `.trash/`, `.git/`, `.DS_Store`, ...) — never notes,
  matched by `isDotPath`/`isDotEntryName`, no configuration involved.
- **`.mnotesignore`** — a gitignore-style file at the vault root (S010's `loadIgnoreMatcher` owns
  parsing it; see S010 for why this exists and the exact matcher contract). Loaded once at daemon
  startup and threaded through `deps.ignoreMatcher` to everywhere a path gets tested — the walk (step
  2), the `fswatch` callback, `processPath`'s purge check, and a full-vault `mnotes reindex` (which
  also re-runs the ignored-paths sweep from step 3a before walking, for the same self-healing reason).
  Editing `.mnotesignore` takes effect on the next daemon restart or full `mnotes reindex`; there's no
  live file-watch on `.mnotesignore` itself.

A single-title `mnotes reindex <title>` for a path matching either kind of exclusion purges it (if
already indexed) rather than indexing it — naming a note explicitly doesn't override the exclusion,
it just triggers the same cleanup a background pass would eventually do anyway.

## Live file-change handling

### Unified per-path debounce

Every `fswatch` event (create, modify, delete, rename) for a given path resets a single **15-second**
per-path in-memory debounce timer — there's no separate immediate-delete path. When the timer fires
(15s of quiet for that path), the daemon rechecks the filesystem directly:

- **File exists** → enqueue the path into `index_queue` (handles create, modify, and the tail end of
  a rename-into-place the same way).
- **File doesn't exist** → delete the corresponding `notes` row immediately (no queue needed — deletion
  is cheap, no embedding work involved).

This single "recheck reality after debounce" design (rather than reacting differently per raw event
type) is what makes atomic-save patterns safe: an editor that writes via temp-file-then-rename (e.g.
Neovim's default write behavior) produces a delete-then-create pair for the same path in quick
succession. Reacting immediately to the delete would make the note briefly vanish from the index mid
-save; deferring to a single post-debounce existence check means it only ever settles into "file
exists, enqueue it."

The debounce window (default 15s) exists to absorb rapid write sessions (multiple saves in a short
span while actively editing) into one reindex pass rather than one per save. It's a config value (see
Config knobs below), not a hardcoded constant.

**Crash-during-debounce is a non-issue**: the debounce timer lives in memory, not the DB. If the
daemon crashes before a pending debounce fires, that specific change is simply picked up by the next
startup's watermark catch-up (the file's mtime is still newer than what's recorded in `notes`) — no
separate recovery logic needed for this case.

### Rename write-through vs. fswatch fallback

`fswatch` here is invoked with no event-type flags, so it never tells the daemon "this was a rename"
— a rename surfaces as two independent path-change lines (old path, new path), each debouncing on its
own per the unified per-path design above. Left entirely to that generic handling, a rename costs a
note ~15–17s of disappearing from search (old path's delete fires before the new path's create has
even settled) plus a full unnecessary re-embed of content that didn't actually change (per S003, only
the `id` frontmatter line changes on rename, but that's enough to change `content_hash`, which used to
look like "real" changed content to this pipeline).

S003's `note_rename` now closes that gap directly: when called with a `db` handle, it applies the
rename to the `notes`/`notes_fts` rows synchronously, in place, under the note's existing `id` —
before either `fswatch` event has even had a chance to fire. `fswatch`'s two events still show up
later, on their own schedule, but by the time they settle, they're chasing a state that's already
correct:

- **Old path settles** (file doesn't exist) → the daemon's existence recheck deletes-by-path as
  usual. But `note_rename` already moved that row's `path` column to the new path, so this lookup
  matches nothing — a harmless no-op, not a deletion of the renamed note.
- **New path settles** (file exists) → enqueued into `index_queue` as usual. When the drainer's
  skip-unchanged check runs, it's comparing the file's on-disk mtime/hash against a `notes` row that
  `note_rename` already updated to match that exact file — so it resolves as "unchanged" (mtime
  short-circuit, or at worst a hash-match `mtime`-only bump) and never reaches re-chunk/re-embed.

This makes the write-through purely additive: the fswatch-driven path above is unmodified and remains
the only mechanism for renames that don't go through `note_rename` with a `db` handle (Obsidian's own
rename, a bare `mv`, a `git` checkout that moves a file). Those still cost the full delete+create cycle
described above, same as before this change.

**`note_rename`'s link cascade (S003/S011) reuses `core/db.js`'s `enqueuePath`** (S001; this file
re-exports it for its own call sites, but doesn't own the implementation — see S001 for why). After
rewriting a linking note's `[[OldTitle]]` references, `note_rename` calls the same `enqueuePath(db,
path)` rather than duplicating any part of the drain/re-embed pipeline — those notes simply enter
`index_queue` like any other changed file and get picked up on the drainer's normal schedule. No new
daemon behavior is needed for the cascade itself; only extraction (above) had to change.

### Queue drainer

Processes `index_queue` rows one at a time (serial, not parallel — simpler, and avoids concurrent
writers contending on the SQLite file), ordered by `next_attempt_at` then `enqueued_at`, skipping rows
whose `next_attempt_at` is still in the future (backoff not yet elapsed).

For each dequeued path:

1. **Skip-unchanged check**: compare the file's current mtime to `notes.mtime`, whether the note's
   existing `chunks` all match the currently configured `embedding_model`/`embedding_version`
   (`hasStaleChunks` in `indexer/daemon.js`), **and** whether `notes.extraction_version` matches the
   code's `EXTRACTION_VERSION` constant (`isExtractionStale`, same file). Only skips (removes from
   queue, done) if all three hold — file unchanged, chunks current, extraction current. If the mtime
   changed, read the file and compute `content_hash`; if that matches the stored hash (content
   genuinely unchanged, e.g. a `touch` or a save that rewrote identical bytes) **and** chunks/
   extraction are current, update `notes.mtime` only and skip straight to done — no re-chunking,
   re-embedding, or re-extraction for unchanged, already-current content. A stale `embedding_model`/
   `embedding_version` or a stale `extraction_version` alone (file untouched either way) falls through
   to step 2 just like a real content change — this is what makes bumping `embed.js`'s embedding
   version (e.g. after a pooling-strategy change) an effective way to force a full re-embed, and
   bumping `EXTRACTION_VERSION` (e.g. after a tag/link-extraction-logic fix, S004/S011) an effective
   way to force re-extraction, both via a plain `mnotes reindex` with no separate migration mechanism
   needed. `EXTRACTION_VERSION` must be bumped whenever inline-tag scanning (S004) or wikilink
   extraction (S011) rules change, or already-indexed notes silently keep whatever tags/links the old
   logic produced until their file content next changes.
2. If the hash actually changed: re-chunk (see Chunking below), re-embed each chunk, extract tags
   (S004) and link targets (S011), and upsert everything per S001's idempotent-reindex procedure
   (`notes` upsert, delete+reinsert `chunks`/`chunk_vectors`/`notes_fts` row/`note_tags`/`note_links`).
3. On success: remove the row from `index_queue`.
4. **On failure** (parse error, embedding error, etc.): increment `attempts`, compute
   `next_attempt_at = now + backoff(attempts)` using exponential backoff (default: 30s, 2min, 10min —
   3 retries after the initial attempt, 4 attempts total), update the row (don't remove it), and log
   that attempt (see "Logging" below for the exact level/shape). After the final attempt is exhausted,
   remove the row and log a permanent failure — the daemon doesn't get stuck retrying the same bad file
   forever, but a future edit to that file (new `fswatch` event) or an explicit `mnotes reindex <title>`
   will re-enqueue it.

**Serialized against IPC-triggered reindexing.** An explicit `mnotes reindex` (IPC, below) doesn't go
through this same dequeue loop — it enqueues its target path(s) and processes them directly so it can
stream per-path progress back over the connection. Both entry points funnel through one process-wide
serialization gate (`createSerialGate` in `indexer/daemon.js`), so a background drain tick and an
IPC-triggered reindex can never call the per-path reindex logic on the same path at the same time. A
periodic drain tick that finds the gate already busy just skips that tick — safe, since the next tick
picks up anything still in `index_queue` — while an IPC request queues behind whatever's in flight
rather than racing it. Without this, a manual reindex issued mid-drain-pass could re-embed the same
note twice concurrently (wasted work, and two interleaved delete+insert passes racing to write the same
`chunks`/`chunk_vectors` rows).

## Chunking

Token-based, fixed-size windows with overlap, operating on the note **body** only (frontmatter
excluded — matches S001's `chunks.char_start`/`char_end` being offsets into the body):

- **Target chunk size**: 512 tokens.
- **Overlap**: ~15% (77 tokens), so each chunk after the first starts 435 tokens into the previous
  one's span.
- **Tokenizer**: the embedding model's own tokenizer (loaded via Transformers.js' `AutoTokenizer`
  alongside the embedding pipeline), so token counts used for chunk boundaries match what the model
  actually sees — not an approximation from a different tokenizer.
- A note shorter than 512 tokens gets a single chunk covering the whole body, no overlap needed.
- Token spans are mapped back to character offsets (`char_start`/`char_end`) for storage in `chunks`,
  since the chunk's text itself is never persisted (S001) — it's re-derived from the vault file by
  slicing `body[char_start:char_end]` whenever needed again (re-embedding, CLI `--explain` debug
  output).
- `char_start`/`char_end` are also converted to `line_start`/`line_end` (S001) at this same point —
  counting newlines in `body` up to each offset, 1-indexed, `line_end` computed from `char_end - 1`
  (since `char_end` itself is exclusive). This reuses the `body` string the chunker already holds in
  memory; no separate file read. Both `charStart` and `charEnd` increase monotonically chunk-to-chunk
  (per the sliding window above — `windowStart` and therefore `windowEnd` only ever grow), so each can
  be resolved to a line via its own forward-only pointer walk over `body`'s newline positions, one pass
  each rather than rescanning from the start every time. **The two pointers must stay separate**:
  overlap means a *later* chunk's `charStart` routinely falls before an *earlier* chunk's `charEnd`, so
  a single pointer fed both interleaved would see a non-monotonic sequence and undercount lines for
  the later chunk.

## Embedding pipeline lifecycle

- **Precision**: `q8` (8-bit quantized) via `onnx-community/Qwen3-Embedding-0.6B-ONNX`'s `dtype`
  option — smallest memory footprint of the three available options (`fp32`/`fp16`/`q8`), acceptable
  quality tradeoff for a retrieval/similarity use case (not generation).
- **Pooling**: `last_token`, not `mean`. Qwen3-Embedding is a causal decoder-only model trained for
  last-token pooling — under causal attention only the final token has attended to the whole input,
  so mean-pooling drags in under-contextualized early-token states and collapses short notes toward a
  generic embedding-space "hub" that scores artificially high against nearly any query. `indexer/
  embed.js`'s `defaultPipelineFactory` passes `pooling: 'last_token'` to Transformers.js'
  `feature-extraction` pipeline for every embed call, document and query alike; `normalize: true`
  (L2 normalization) applies on top either way.
- **Query-side instruction prefix**: `embed.js`'s `embedQuery()` (used by `core/search.js` for the
  query text only — never for chunk/document text) prepends Qwen3-Embedding's documented
  `"Instruct: {task_description}\nQuery: {query}"` format before embedding, per the model's trained
  query/document asymmetry. The task description (`embed.js`'s `QUERY_INSTRUCTION`): "Given a query,
  retrieve relevant notes from a notes vault that answer or relate to the query." Chunk/document text
  gets no such instruction wrapper — asymmetric to the query side.
- **Chunk-side title prefix**: `embed.js`'s `buildChunkPrompt(title, chunkBody)` prepends the note's
  title, blank-line separated, ahead of each chunk's body before embedding (`daemon.js`'s
  `embedChunks`) — `${title}\n\n${chunkBody}`. A mid-note chunk's own text often lacks the topic
  words that made the note findable in the first place; the title restores that context for every
  chunk, not just the first. `char_start`/`char_end`/`line_start`/`line_end` are unaffected — they're
  computed from `chunkText`'s windowing over the body alone (per Chunking above), before the title is
  added for the embed call, so stored chunk spans still index directly into the vault file's body.
  Applies to document/chunk text only, never the query side.
- **Lazy load**: the pipeline isn't loaded at daemon startup — it loads on first actual use (the first
  chunk that needs embedding after startup, whether from catch-up or a live event).
- **Idle unload**: after **10 minutes** with no embedding calls, the daemon dereferences the loaded
  pipeline (allowing GC to reclaim the memory) rather than holding it indefinitely. The next embedding
  request after an unload pays the load cost again (a few seconds) for that one request. Both the idle
  timeout and the precision are config values (see below), not hardcoded.
- Only the daemon ever loads this pipeline — neither the CLI nor the MCP server does (see IPC below),
  so there's exactly one embedding pipeline instance on the machine at a time, no matter how many
  `mnotes` invocations or `mnotes-mcp` processes (e.g. from multiple concurrent Claude Code sessions)
  are running.

## IPC: CLI/MCP ↔ daemon

A Unix domain socket at `daemon.sock` inside `src/platform`'s `appSupportDir()` (`~/Library/Application
Support/mnotes/daemon.sock` on macOS, `${XDG_DATA_HOME:-~/.local/share}/mnotes/daemon.sock` on Linux —
S009), so `mnotes reindex`, query
embedding for `search --mode semantic|hybrid` (CLI and MCP alike), and any other command needing
daemon-backed work reuse the daemon's warm model instead of loading their own.

- **Protocol**: newline-delimited JSON messages over the socket connection.
- **`{ action: "embed", text }`**: used by `core/search.js`'s semantic/hybrid path (via `embed.js`'s
  `embedQueryOverSocket`, injected as `deps.embed` in both `cli/main.js`'s `buildRealDeps()` and
  `mcp/server.js`'s `main()`) to embed query text without loading a local model copy. Daemon calls its
  own `embedQuery()` (the same shared pipeline instance document embedding uses) and responds with a
  single `{ vector: [...] }` message, or `{ error: message }` on failure, then closes the connection —
  request/response, not a stream, unlike `reindex` below. Deliberately **not** run under
  `createSerialGate()`: that gate exists to keep `processPath` from running on the same path twice
  concurrently (a DB-mutation correctness concern), and embedding a query touches no shared queue/DB
  state — so an interactive search isn't forced to wait behind an in-flight bulk reindex.
- **`mnotes reindex` (no title)**: CLI connects, sends `{ action: "reindex" }`. Daemon walks the vault
  and enqueues every `.md` file's path (not just changed ones — this is the ad hoc "safe to run
  anytime" full-vault command from the README; unchanged-and-current files are still cheap since the
  skip-unchanged check in the drainer handles them — but a file with stale chunks, per the
  embedding-version check above, does get re-embedded even with no content change). Daemon streams
  one JSON
  message per completed path (including per-attempt failure messages as they happen, per the retry
  behavior above) back over the same connection, then a final summary message
  (`{ reindexed, skipped, failed }` counts) once every enqueued path has reached a final state
  (success or exhausted retries), then closes the connection.
- **`mnotes reindex <title>`**: same, but scoped to one path. The connection stays open through that
  path's full attempt/backoff cycle if it fails — the CLI blocks and prints each attempt's outcome as
  it happens, up through final success or final failure. This is a deliberate choice: watching retries
  happen in real time is more useful for an interactively-run debug command than either hiding them
  (fire-and-forget) or returning after just the first attempt.
- **Daemon not running**: both `mnotes reindex` and an `embed` request (so `search
  --mode=semantic|hybrid` from either the CLI or the MCP `search` tool) are a **hard error** — no
  fallback to a locally-loaded model. Keeps exactly one code path for embedding work (the daemon's),
  rather than maintaining a second standalone-embedding path used only when the daemon happens to be
  down.

## Config knobs introduced here (flagged for S009)

All of the following are new `config.toml` keys, not hardcoded constants — per your preference that
tunables like these live in config rather than code:

- Debounce window (default `15s`)
- Embedding model idle-unload timeout (default `10m`)
- Embedding precision/dtype (default `q8`)
- Retry backoff schedule / max attempts (default `30s, 2m, 10m`, 4 attempts total)

## Logging

`src/indexer/daemon.js` is a `runWithLogger` **root**: at process start, before anything else, it
calls `runWithLogger(getLogger('indexer', defaultLogDir()), () => main())` (per `S008`) — every log
call for the lifetime of the process, including `core/db.js`'s own `openDb` logging (`S001`: "schema
created" at `info`, "schema version mismatch, rebuilding" at `warn`) and `core/tags.js`'s/
`core/links.js`'s extraction calls during reindex, lands in `indexer.log` under this one context.
Nothing else in this spec needs its own `runWithLogger` call — it's set up once, at the top.

Concrete events, replacing this spec's earlier vague "log an error-level entry (S008)" phrasing with
the actual `getContextLogger()` call sites and levels:

- **Daemon started** — `info`, `"daemon started"`, before the schema check.
- **Schema check/rebuild** — handled entirely by `core/db.js`'s own logging (`S001`); this spec doesn't
  add a second line for it.
- **Watermark catch-up complete** — `info`, `"watermark catch-up complete"`, context
  `{ watermark, enqueued_count }`.
- **Existence check complete** — `info`, `"existence check complete"`, context `{ deleted_count }`.
- **`fswatch` watcher started** — `info`, `"fswatch watcher started"`.
- **Queue drainer, per dequeued path**:
  - Skip-unchanged (mtime or content hash unchanged) — `debug`, `"skipping unchanged path"`, context
    `{ note_title }` — high-frequency, low-value outside active debugging, so not `info`.
  - Content actually changed and successfully re-chunked/re-embedded/upserted — `info`,
    `"reindexed note"`, context `{ note_title, chunk_count }` — this is the "processing events... at
    info" line `S008`'s file-layout description calls out.
  - Per-attempt failure (parse error, embedding error, etc.) — `warn`, `"reindex attempt failed"`,
    context `{ note_title, attempt, next_attempt_at, error_message }`.
  - Permanent failure (final attempt exhausted, row removed from `index_queue`) — `error`,
    `"reindex permanently failed"`, context `{ note_title, attempts, error_message }`.
- **Embedding pipeline load** (first use after startup or after an idle-unload) — `info`, `"embedding
  pipeline loaded"`, context `{ dtype }`.
- **Embedding pipeline idle-unload** (after the configured idle timeout) — `info`, `"embedding
  pipeline unloaded"`, context `{ idle_minutes }`.
- **IPC reindex request received** — `info`, `"reindex requested"`, context `{ scope<"vault"|"note">,
  note_title? }`.
- **IPC reindex summary sent** (end of a full-vault `mnotes reindex`) — `info`, `"reindex complete"`,
  context `{ reindexed, skipped, failed }` — the same counts the final IPC summary message reports to
  the CLI, also captured durably in `indexer.log`.

No `logAudit` calls anywhere in this spec — `audit.log` is for MCP-tool-call and CLI-mutating-command
outcomes only (`S008`/`S006`/`S007`); daemon-internal reindexing isn't a caller-initiated mutation in
that sense, even though it writes to the index.

## Explicitly out of scope here

- **Exact `config.toml` key names and file format for the above** — S009.
- **`mnotes stats`'s "notes pending re-embedding" query** — this is a read against `chunks`/`notes`
  comparing `embedding_model`/`embedding_version` to the currently configured model (per S001); the
  command itself is specified in S006.
- **The service-manager configuration that keeps this daemon running** (`launchd` plist `KeepAlive`/
  `RunAtLoad` on macOS, the `systemd` unit's `Restart`/`WantedBy` on Linux) and the platform-abstraction
  contract (`src/platform`) this file's path helpers delegate to — both S009.
