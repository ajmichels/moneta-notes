# S001 — Data Model

Status: **Approved**
Owns: `src/core/db.js`
Consumed by: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`, `S006-cli`

## Purpose

Defines the SQLite schema that backs the index: full-text search (FTS5), semantic search
(sqlite-vec), tags, and the bookkeeping needed to make reindexing idempotent and embedding-model
swaps detectable. This is a pure *cache* of the vault — every row here is reconstructable from the
files on disk via `mnotes reindex`. Nothing in this database is a source of truth; the vault files
are.

`core/db.js` owns schema creation, migration (version-check-and-rebuild), and low-level connection
setup. It exposes plain functions that `core/notes.js`, `core/search.js`, and `core/tags.js` call —
it does not itself implement note I/O, search ranking, or tag extraction logic (those are specified
in S003/S002/S004 respectively).

## Driver: `node:sqlite`

Node's built-in `node:sqlite` module (release-candidate stability as of Node 22.13/24, no longer
behind a flag), not `better-sqlite3`. Zero new dependency for the driver itself — only `sqlite-vec`
(the vector-search extension binary) needs to be an npm package, which is unavoidable regardless of
driver choice since it isn't built into SQLite. Matches the project's minimal-dependency, plain-JS
bias; release-candidate status is a non-issue for a personal single-user tool (the caveat that shows
up in the wild is about long-lived production services, not scripts/internal tools); the
Windows-specific `sqlite-vec` loading bugs reported against `better-sqlite3` are moot since this
project is macOS-only.

Loading the `sqlite-vec` extension requires opting in at database-open time:

```js
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

const db = new DatabaseSync(dbPath, { allowExtension: true });
db.enableLoadExtension(true);
sqliteVec.load(db);
db.enableLoadExtension(false); // no further extension loads needed after this
```

## Tables

### `notes`

One row per indexed note file.

| Column         | Type    | Constraints              | Notes |
|----------------|---------|---------------------------|-------|
| `id`           | INTEGER | PRIMARY KEY               | |
| `path`         | TEXT    | UNIQUE NOT NULL           | Relative to vault root, e.g. `Weekly Notes/2026-W32.md`. **Source of truth for identity** — see below. |
| `content_hash` | TEXT    | NOT NULL                  | SHA-1 hex digest (40 chars) of the raw file bytes, frontmatter included. |
| `line_count`   | INTEGER | NOT NULL                  | Used directly in `file_line_count` tool output columns. |
| `mtime`        | INTEGER | NOT NULL                  | File mtime (epoch seconds) at last index. Lets the daemon skip rehashing a file whose mtime hasn't changed. |
| `updated_at`   | INTEGER | NOT NULL                  | Epoch seconds this row was last (re)written by the indexer. |

**Title is never stored.** `core/notes.js` derives it from `path` (strip vault root prefix, strip
`.md` extension) and derives `path` from a title the same way in reverse. This is a pure,
deterministic transform — storing both would risk drift between them for zero benefit.

### `notes_fts` (FTS5, contentless)

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body,
  content='',
  tokenize='porter unicode61 remove_diacritics 2'
);
```

- `content=''` makes this a **contentless** FTS5 table: it stores only the inverted index (tokens →
  rowid), never the note text itself. This matches the README's "no duplicated note content" rule.
  It means `snippet()`/`highlight()` are unavailable — acceptable because the `search` tool's output
  is note title + rank only, never a text snippet (see README).
- `rowid` is set explicitly to `notes.id` at insert time, so a search hit maps back to a note with a
  simple rowid join — no separate mapping table needed.
- Tokenizer: `porter` stemming over `unicode61` (diacritics stripped). A reasonable default for
  English prose notes; revisit if search quality on code-heavy notes turns out to want raw tokens
  instead of stemmed ones.
- Since the table is contentless, `title`/`body` text must be supplied at index time (read from the
  vault file, not from any DB column) via `INSERT INTO notes_fts(rowid, title, body) VALUES (...)`.

### `chunks`

One row per embedding chunk. A note with N chunks has N rows here.

| Column              | Type    | Constraints                                  | Notes |
|---------------------|---------|-----------------------------------------------|-------|
| `id`                | INTEGER | PRIMARY KEY                                   | |
| `note_id`           | INTEGER | NOT NULL, REFERENCES `notes(id)` ON DELETE CASCADE | |
| `chunk_index`       | INTEGER | NOT NULL                                      | 0-based position within the note. |
| `char_start`        | INTEGER | NOT NULL                                      | Offset into the note body (chars), inclusive. |
| `char_end`          | INTEGER | NOT NULL                                      | Offset into the note body (chars), exclusive. |
| `token_count`       | INTEGER | NOT NULL                                      | Token count of this chunk (target ~512, see S005 for the chunker itself). |
| `embedding_model`   | TEXT    | NOT NULL                                      | e.g. `Qwen3-Embedding-0.6B`. |
| `embedding_version` | TEXT    | NOT NULL                                      | Model/build version string, so a re-pull of the same model name with different weights is still detectable. |

`(embedding_model, embedding_version)` on a chunk row is what makes a model swap detectable at
per-note granularity: `mnotes stats`' "notes pending re-embedding" count is a query over `chunks`
joined to `notes`, counting notes where any chunk's model/version doesn't match the currently
configured model.

Chunk **text** is never stored — only offsets. The chunk's actual content is re-derived from the
vault file (`body[char_start:char_end]`) whenever needed (e.g. re-embedding, `--explain` debug
output). This keeps chunk bookkeeping from becoming a second copy of note content, consistent with
the FTS5 contentless decision above.

### `chunk_vectors` (sqlite-vec `vec0`)

```sql
CREATE VIRTUAL TABLE chunk_vectors USING vec0(
  embedding float[1024] distance_metric=cosine
);
```

- `distance_metric=cosine` is required explicitly — sqlite-vec's default is L2 (Euclidean) distance,
  which would silently contradict S002's cosine-distance ranking throughout if left unset.
- `rowid` = `chunks.id` (1:1 join, set explicitly at insert time).
- Dimension is the full native Qwen3-Embedding-0.6B output (1024) — no Matryoshka/MRL truncation for
  v1. The vault's scale (thousands of notes, not millions) doesn't need the storage/query-speed
  savings truncation would buy, and full dimension is simplest to reason about. Revisit only if the
  index grows large enough for this to matter.
- Split into its own virtual table (rather than a column on `chunks`) because sqlite-vec's ANN
  indexing requires its own virtual table type — this isn't a stylistic choice, it's how the
  extension works.

### `tags` / `note_tags`

```sql
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE
);

CREATE TABLE note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);
```

- Tags come from both YAML frontmatter (`tags: [...]`) and inline `#hashtags` in the note body —
  both feed the same join table with no source distinction, since no tool in the README (`tag_list`,
  `tag_notes`) needs to know where a tag came from. Extraction logic (frontmatter parsing, inline
  scan rules to avoid false positives in code fences/headings/URLs) is specified in S004, not here.
- `tags.name` uses `COLLATE NOCASE` rather than forced lowercasing, matching Obsidian's own tag
  behavior exactly: tags are case-insensitive for matching/uniqueness, but display using whichever
  casing was used the first time that tag was created (`#Project` created first, `#project` used
  later in another note — both count toward one tag, shown as "Project"). See S004 for the
  case-insensitive `INSERT ... ON CONFLICT` upsert logic this implies.
- `note_tags` has no surrogate key — `(note_id, tag_id)` is naturally unique, and a tag appearing via
  both frontmatter and an inline mention in the same note collapses to one row, which is the correct
  behavior (a note either carries a tag or it doesn't).

### `index_queue`

```sql
CREATE TABLE index_queue (
  path            TEXT PRIMARY KEY,
  enqueued_at     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);
```

Durable work queue for the indexing daemon (full behavior in S005). `path` as the primary key gives
free dedup: re-enqueueing a path already pending is `INSERT ... ON CONFLICT(path) DO NOTHING` (the
existing row's position is preserved, not bumped). `attempts`/`next_attempt_at` back the
retry-with-backoff behavior for processing failures. Being a real table (not an in-memory queue)
means a daemon crash mid-queue loses nothing — whatever's still in the table drains again on restart.

### `meta`

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Single-value bookkeeping. Known keys:

- `schema_version` — integer (as text), checked at every connection open.
- `last_full_reindex_at` — epoch seconds, surfaced by `mnotes stats`.

## Migrations: version-check-and-rebuild

Because every row in this database is derivable from the vault, there's no data here worth
preserving across a schema change — so migrations don't use incremental `ALTER TABLE` scripts.
Instead:

1. On connection open, `core/db.js` reads `meta.schema_version`.
2. If it's missing or doesn't match the `CURRENT_SCHEMA_VERSION` constant in code, every table
   (`notes`, `notes_fts`, `chunks`, `chunk_vectors`, `tags`, `note_tags`) is dropped and recreated
   from the current `CREATE TABLE`/`CREATE VIRTUAL TABLE` statements, then `meta.schema_version` is
   set to the new value.
3. `core/db.js` surfaces this as a `reindexRequired: true` signal to the caller (daemon startup logs
   it and immediately kicks off a full reindex; `mnotes stats` reports 100% of notes pending).

This is intentionally simple: bump the version constant whenever the schema changes, and the rebuild
is unconditional. No migration script authoring, no partial-migration edge cases.

## Idempotent reindex

Reindexing a single note (`mnotes reindex <title>` or a daemon-triggered re-index on file change) is:

1. `INSERT INTO notes (...) VALUES (...) ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, line_count=excluded.line_count, mtime=excluded.mtime, updated_at=excluded.updated_at`.
2. Delete all existing `chunks` rows for that `note_id` (cascades to `chunk_vectors` via the
   `chunks`/`chunk_vectors` 1:1 rowid relationship — deletion is explicit in application code since
   `vec0` doesn't support `ON DELETE CASCADE` from a regular foreign key).
3. Delete and re-insert `notes_fts` row for that rowid.
4. Delete and re-insert `note_tags` rows for that note.
5. Re-chunk, re-embed, and insert fresh `chunks`/`chunk_vectors` rows.

Running this twice in a row with no intervening file change produces byte-identical `content_hash`,
so step 1's `ON CONFLICT` update is a no-op write of the same values, and steps 2–5 replace rows with
identical content — no duplicate FTS rows, no duplicate vectors, satisfying the idempotency
requirement in CLAUDE.md.

A full vault reindex (`mnotes reindex` with no argument) walks the vault and does the above per file,
plus deletes `notes` rows (and cascading children) for any `path` present in the DB but no longer on
disk.

## Explicitly deferred to other specs

- **How multiple chunk hits for one note collapse into a single note-level semantic rank** (e.g.
  best-chunk-wins vs. an aggregate) — S002 (search).
- **Tag extraction rules** (frontmatter parsing, inline `#tag` scanning, false-positive avoidance) —
  S004 (grep-tags).
- **Chunking algorithm specifics** (token counting method, ~512 token target / ~15% overlap window
  boundaries) — S005 (indexing-daemon), since chunking happens in `indexer/embed.js`, not `core/db.js`.
- **Rename detection** — this schema supports either "daemon detects rename and does an UPDATE" or
  "daemon always does delete+insert on path change" equally well, since `path UNIQUE` + upsert is
  idempotent either way. Which strategy the daemon actually uses is S005's concern.
