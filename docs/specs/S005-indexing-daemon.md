# S005 — Indexing Daemon

Status: **Approved**
Owns: `src/indexer/daemon.js`, `src/indexer/embed.js`
Depends on: `S001-data-model`, `S004-grep-tags` (tag extraction, invoked here during processing)
Consumed by: `S006-cli` (reindex/stats talk to this daemon), `S009-config-and-install` (new config
knobs introduced here)

## Purpose

Defines the long-running `launchd`-managed daemon: startup catch-up, live `fswatch`-driven indexing,
the embedding pipeline's lifecycle (load/idle-unload), and the Unix-socket IPC that lets the CLI
drive the same warm daemon rather than loading its own model copy per invocation.

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
   path needed). Walk the vault, and for every `.md` file whose mtime is newer than the watermark,
   enqueue its path into `index_queue`. This catches anything changed while the daemon was down
   (crash, machine sleep, disabled), without a full unconditional walk-and-reprocess of every file.
3. **Existence check**: for every path currently in `notes`, verify it still exists on disk (a cheap
   `stat`, not a content read). Delete rows (cascading to `chunks`/`chunk_vectors`/`note_tags` per
   S001's `ON DELETE CASCADE`) for any that don't — catches deletions that happened while the daemon
   was down, which the watermark pass alone can't (a deleted file has no mtime to compare).
4. Start the `fswatch` watcher on the vault directory.
5. Start the queue drainer (processes `index_queue` continuously — see below).
6. Start the Unix-socket IPC listener (see below).

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

### Queue drainer

Processes `index_queue` rows one at a time (serial, not parallel — simpler, and avoids concurrent
writers contending on the SQLite file), ordered by `next_attempt_at` then `enqueued_at`, skipping rows
whose `next_attempt_at` is still in the future (backoff not yet elapsed).

For each dequeued path:

1. **Skip-unchanged check**: compare the file's current mtime to `notes.mtime`. If unchanged, this was
   a spurious enqueue (shouldn't normally happen given the debounce logic, but cheap to guard against
   regardless) — remove from queue, done. If changed, read the file and compute `content_hash`; if
   that matches the stored hash (content genuinely unchanged, e.g. a `touch` or a save that rewrote
   identical bytes), update `notes.mtime` only and skip straight to done — no re-chunking or
   re-embedding for unchanged content.
2. If the hash actually changed: re-chunk (see Chunking below), re-embed each chunk, extract tags
   (S004), and upsert everything per S001's idempotent-reindex procedure (`notes` upsert, delete+
   reinsert `chunks`/`chunk_vectors`/`notes_fts` row/`note_tags`).
3. On success: remove the row from `index_queue`.
4. **On failure** (parse error, embedding error, etc.): increment `attempts`, compute
   `next_attempt_at = now + backoff(attempts)` using exponential backoff (default: 30s, 2min, 10min —
   3 retries after the initial attempt, 4 attempts total), update the row (don't remove it), and log
   an error-level entry (S008) for that attempt. After the final attempt is exhausted, remove the row
   and log a permanent-failure error — the daemon doesn't get stuck retrying the same bad file forever,
   but a future edit to that file (new `fswatch` event) or an explicit `mnotes reindex <title>` will
   re-enqueue it.

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

## Embedding pipeline lifecycle

- **Precision**: `q8` (8-bit quantized) via `onnx-community/Qwen3-Embedding-0.6B-ONNX`'s `dtype`
  option — smallest memory footprint of the three available options (`fp32`/`fp16`/`q8`), acceptable
  quality tradeoff for a retrieval/similarity use case (not generation).
- **Lazy load**: the pipeline isn't loaded at daemon startup — it loads on first actual use (the first
  chunk that needs embedding after startup, whether from catch-up or a live event).
- **Idle unload**: after **10 minutes** with no embedding calls, the daemon dereferences the loaded
  pipeline (allowing GC to reclaim the memory) rather than holding it indefinitely. The next embedding
  request after an unload pays the load cost again (a few seconds) for that one request. Both the idle
  timeout and the precision are config values (see below), not hardcoded.
- Only the daemon ever loads this pipeline — the CLI never does (see IPC below), so there's exactly
  one embedding pipeline instance on the machine at a time.

## IPC: CLI ↔ daemon

A Unix domain socket at `~/Library/Application Support/mnotes/daemon.sock`, so `mnotes reindex` (and
any other CLI command needing daemon-backed work) reuses the daemon's warm model instead of loading
its own.

- **Protocol**: newline-delimited JSON messages over the socket connection.
- **`mnotes reindex` (no title)**: CLI connects, sends `{ action: "reindex" }`. Daemon walks the vault
  and enqueues every `.md` file's path (not just changed ones — this is the ad hoc "safe to run
  anytime" full-vault command from the README; unchanged files are still cheap since the skip-
  -unchanged check in the drainer handles them, no forced re-embedding). Daemon streams one JSON
  message per completed path (including per-attempt failure messages as they happen, per the retry
  behavior above) back over the same connection, then a final summary message
  (`{ reindexed, skipped, failed }` counts) once every enqueued path has reached a final state
  (success or exhausted retries), then closes the connection.
- **`mnotes reindex <title>`**: same, but scoped to one path. The connection stays open through that
  path's full attempt/backoff cycle if it fails — the CLI blocks and prints each attempt's outcome as
  it happens, up through final success or final failure. This is a deliberate choice: watching retries
  happen in real time is more useful for an interactively-run debug command than either hiding them
  (fire-and-forget) or returning after just the first attempt.
- **Daemon not running**: `mnotes reindex` is a **hard error** ("daemon not running — check
  `launchctl print gui/$(id -u)/com.ajmichels.mnotes`") — no fallback to a CLI-local model load. Keeps
  exactly one code path for embedding work (the daemon's), rather than maintaining a second
  standalone-embedding path used only when the daemon happens to be down.

## Config knobs introduced here (flagged for S009)

All of the following are new `config.toml` keys, not hardcoded constants — per your preference that
tunables like these live in config rather than code:

- Debounce window (default `15s`)
- Embedding model idle-unload timeout (default `10m`)
- Embedding precision/dtype (default `q8`)
- Retry backoff schedule / max attempts (default `30s, 2m, 10m`, 4 attempts total)

## Explicitly out of scope here

- **Exact `config.toml` key names and file format for the above** — S009.
- **`mnotes stats`'s "notes pending re-embedding" query** — this is a read against `chunks`/`notes`
  comparing `embedding_model`/`embedding_version` to the currently configured model (per S001); the
  command itself is specified in S006.
- **`launchd` plist configuration (KeepAlive, RunAtLoad, etc.) that keeps this daemon running** — S009.
