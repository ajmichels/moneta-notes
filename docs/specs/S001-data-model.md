# S001 — Data Model

Status: **Approved**
Owns: `src/core/db.js`
Consumed by: `S002-search`, `S003-notes`, `S004-grep-tags`, `S005-indexing-daemon`, `S006-cli`,
`S011-links`

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

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
```

**`WAL` + `busy_timeout`**: three separate processes (the indexing daemon, the CLI, the MCP server)
all open connections against the same SQLite file, with the daemon as the sole writer and the
CLI/MCP server as readers. The default rollback-journal mode blocks readers during a writer's
transaction; `WAL` lets readers proceed against the last-committed snapshot while a write is in
progress. `busy_timeout = 5000` means a genuine contention moment (e.g. two writers, which
shouldn't normally happen but isn't impossible) waits up to 5s and retries rather than throwing
`SQLITE_BUSY` immediately. Both values are `config.toml`-backed per this project's established
tunable pattern (S009) — 5000ms is the default, not a hardcoded constant.

**`node:sqlite` numeric binding**: `DatabaseSync` binds every JS `number` parameter as SQLite
`REAL`, never `INTEGER` (verified: `SELECT typeof(?)` bound to `5` returns `'real'`; only a
`BigInt` binds as `'integer'`). This is silently harmless for `INTEGER`-affinity columns (SQLite's
type affinity coerces `5.0` back to `5` on storage) but has two concrete consequences elsewhere in
this schema:

- **`chunk_vectors.rowid`**: `vec0` enforces a strict integer-typed rowid and rejects a bound `REAL`
  outright (`Only integers are allowed for primary key values on chunk_vectors`). Inserts must use
  `INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`.
- **`meta.value`** (`TEXT` affinity, no numeric coercion): binding a bare JS number stores it with a
  trailing `.0` (e.g. `1000` becomes the string `'1000.0'`). Every write to `meta.value` must
  explicitly `String(n)` the value before binding — see `getMeta`/`setMeta` below, which apply this
  rule internally so callers never have to think about it.

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
| `extraction_version` | INTEGER | NOT NULL DEFAULT 0  | The `EXTRACTION_VERSION` (`indexer/daemon.js`) in effect the last time this note's tags/links were extracted. Checked the same way `chunks.embedding_version` is (S005) — a mismatch forces reprocessing on the next `mnotes reindex` even though the file's `content_hash` is unchanged, which is what makes a tag/link-extraction-logic fix (S004/S011) reach already-indexed notes without a schema rebuild. |

**Title is never stored.** `core/note-fs.js` (S010) derives it from `path` (strip vault root prefix,
strip `.md` extension) and derives `path` from a title the same way in reverse. This is a pure,
deterministic transform — storing both would risk drift between them for zero benefit.

### `notes_fts` (FTS5, contentless)

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body,
  content='',
  contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2'
);
```

- `content=''` makes this a **contentless** FTS5 table: it stores only the inverted index (tokens →
  rowid), never the note text itself. This matches the README's "no duplicated note content" rule.
  It means `snippet()`/`highlight()` are unavailable — acceptable because the `search` tool's output
  is note title + rank only, never a text snippet (see README).
- **`contentless_delete=1` is required, not optional.** A plain contentless table (`content=''`
  alone) rejects `DELETE FROM notes_fts WHERE rowid = ?` outright (`cannot DELETE from contentless
  fts5 table`), and — worse — silently re-inserting the same rowid with different text does *not*
  replace the old tokens: the old terms keep matching forever, which permanently violates the
  idempotent-reindex requirement (CLAUDE.md: "no double-inserted FTS rows") on every single note
  edit. `contentless_delete=1` (SQLite ≥ 3.43; Node 24 bundles a recent-enough version) makes
  `DELETE` work correctly and is a hard prerequisite for the delete-and-reinsert step in "Idempotent
  reindex" below. Tables using it accumulate delete markers over time and want an occasional
  `INSERT INTO notes_fts(notes_fts) VALUES('optimize')` (not scheduled by this spec — revisit if
  index bloat becomes a real concern at this project's scale). The `'rebuild'` FTS5 command isn't
  supported on contentless tables, but that's moot here since a rebuild is always a full drop +
  recreate (see Migrations below), never an in-place FTS rebuild.
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
| `line_start`        | INTEGER | NOT NULL                                      | 1-indexed line number (within the note body) containing `char_start`. |
| `line_end`          | INTEGER | NOT NULL                                      | 1-indexed line number (within the note body) containing the chunk's last character (`char_end - 1`). |
| `token_count`       | INTEGER | NOT NULL                                      | Token count of this chunk (target ~512, see S005 for the chunker itself). |
| `embedding_model`   | TEXT    | NOT NULL                                      | e.g. `Qwen3-Embedding-0.6B`. |
| `embedding_version` | TEXT    | NOT NULL                                      | Model/build version string, so a re-pull of the same model name with different weights is still detectable. |

`UNIQUE (note_id, chunk_index)` on the table (in addition to the `id` primary key): this does double
duty. First, it's the index that makes `DELETE FROM chunks WHERE note_id = ?` (run on every single
note reindex, per "Idempotent reindex" below, plus the `ON DELETE CASCADE` from `notes`) an indexed
lookup instead of a full table scan — without it, a full-vault reindex is O(notes × chunks). Second,
it upgrades "no duplicate chunk rows for the same note+position" from a convention the reindex code
has to get right to a constraint the database enforces — a bug that inserts a chunk twice fails
loudly (per CLAUDE.md) instead of silently duplicating data.

`(embedding_model, embedding_version)` on a chunk row is what makes a model swap detectable at
per-note granularity: `mnotes stats`' "notes pending re-embedding" count is a query over `chunks`
joined to `notes`, counting notes where any chunk's model/version doesn't match the currently
configured model.

Chunk **text** is never stored — only offsets. The chunk's actual content is re-derived from the
vault file (`body[char_start:char_end]`) whenever needed (e.g. re-embedding, `--explain` debug
output). This keeps chunk bookkeeping from becoming a second copy of note content, consistent with
the FTS5 contentless decision above.

`line_start`/`line_end` are derived from `char_start`/`char_end` at chunk time (S005 already has the
body text in hand when it computes the character offsets, so counting newlines up to those offsets is
free — no extra file read). They deliberately use the **same coordinate space as `note_read`'s
`start_line`/`end_line`** (S003): both count 1-indexed lines within the frontmatter-stripped body,
*not* `grep`'s raw-file-including-frontmatter line numbers (S004) — those are a different convention
for a different purpose (locating a match on disk vs. a line inside the body a chunk was computed
over). This is what makes the pair directly usable together: a caller can take `chunk_line_start`/
`chunk_line_end` off a `search` result (S002's semantic/hybrid best-chunk-wins collapse) and pass them
straight through to `note_read`'s `start_line`/`end_line` to fetch just the matching slice of a large
note, with no frontmatter-offset math of its own.

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

CREATE INDEX note_tags_tag_id ON note_tags(tag_id);
```

The composite primary key `(note_id, tag_id)` gives a free index for `note_id`-first lookups, but
not for `tag_id`-first ones — `note_tags_tag_id` covers those explicitly. This matters for two real
query paths: S004's `tag_notes` tool ("which notes carry this tag" — a primary user-facing query,
filtered by `tag_id` first) and the `ON DELETE CASCADE` from `tags`. Without it, both are full table
scans.

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

### `note_links`

```sql
CREATE TABLE note_links (
  source_note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_title   TEXT NOT NULL,
  PRIMARY KEY (source_note_id, target_title)
);

CREATE INDEX note_links_target_title ON note_links(target_title);
```

One row per distinct wikilink target a note contains, extracted from `[[Target]]` /
`[[Target|Alias]]` / `[[Target#Heading]]` syntax during reindex (extraction rules are
[S011](S011-links.md)'s concern, not this schema's). Backs both `note_read`'s `backlinks` output and
`note_rename`'s link-cascade rewrite (S003, as amended by S011).

- `target_title` is stored as **raw parsed text, not resolved to a `notes.id`** — unlike `note_tags`,
  where every row necessarily points at a real `tags` row. A wikilink can target a note that doesn't
  exist yet (or no longer does), and that's a meaningful case to preserve (a future "orphan/broken
  link" query), not an error to reject at extraction time. This is also why there's no separate
  `links`-vocabulary table analogous to `tags`: there's nothing to deduplicate/case-fold across notes
  the way tag names are — `target_title` is compared by exact string equality wherever it's queried
  (matching every other title comparison in this codebase — `titleToPath`/`pathToTitle` are
  case-sensitive, so this stays consistent rather than inventing a new case-insensitive-title
  convention for just this one table).
- The composite primary key `(source_note_id, target_title)` gives the same free
  source-note-id-first index `note_tags` gets from its own composite PK (needed for
  `DELETE FROM note_links WHERE source_note_id = ?` on every reindex, and for the `ON DELETE CASCADE`
  from `notes`), plus collapses multiple mentions of the same target within one note (e.g. `[[Foo]]`
  referenced three times in one note's body) into a single row — a note either links to a target or it
  doesn't; backlink output cares about that, not mention count.
- `note_links_target_title` covers the actual primary read path — "which notes link to this
  title" (`note_read`'s `backlinks`, `note_rename`'s cascade candidate lookup) — which is a
  `target_title`-first query the composite PK alone doesn't index.

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
retry-with-backoff behavior for processing failures.

`core/db.js` exports `enqueuePath(db, path, now)` — the one-line `INSERT ... ON CONFLICT DO NOTHING`
above — for the same reason it exports `getMeta`/`setMeta` below: it's a plain data-layer operation on
a table this spec owns, not daemon-process logic, so it lives here rather than in `indexer/daemon.js`
even though the daemon's drain loop (S005) is its main caller. This matters concretely for S011:
`note_rename`'s link cascade (S003) also calls it directly, from `core/notes.js` — if it lived in
`indexer/daemon.js` instead, `core/notes.js` importing it would create a circular import, since
`indexer/daemon.js` already imports `core/notes.js`. `indexer/daemon.js` re-exports it for its own
existing call sites, but the implementation is here.

Being a real table (not an in-memory queue)
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

`core/db.js` exports `getMeta(db, key) -> string | null` and `setMeta(db, key, value)` — per this
spec's stated goal of `db.js` "exposing plain functions that `core/notes.js`, `core/search.js`, and
`core/tags.js` call," rather than every consumer (S005's daemon writing `last_full_reindex_at`,
`mnotes stats` reading it) hand-rolling its own `INSERT ... ON CONFLICT` upsert — the exact
CLI/MCP-duplication problem CLAUDE.md warns against, one layer down. `setMeta` internally applies
`String(value)` before binding, so callers never have to think about the `node:sqlite` numeric
binding quirk described above (a bare JS number written to this `TEXT`-affinity column would
otherwise store with a trailing `.0`).

## Migrations: version-check-and-rebuild

Because every row in this database is derivable from the vault, there's no data here worth
preserving across a schema change — so migrations don't use incremental `ALTER TABLE` scripts.
Instead:

1. On connection open, `core/db.js` reads `meta.schema_version`.
2. If it's missing or doesn't match the `SCHEMA_VERSION` constant in code, **every** table —
   `notes`, `notes_fts`, `chunks`, `chunk_vectors`, `tags`, `note_tags`, `note_links`, `index_queue`,
   `meta`, all nine, not just the seven that hold reconstructable index data — is dropped and recreated from the
   current `CREATE TABLE`/`CREATE VIRTUAL TABLE` statements, then `meta.schema_version` is set to the
   new value. `index_queue` and `meta` are included deliberately: a schema rebuild implies a full
   reindex is about to happen, so any pending queue entries are moot, and `last_full_reindex_at`
   describes a reindex that (from the new schema's perspective) never happened.
3. `core/db.js` surfaces this as a `reindexRequired: true` signal to the caller (daemon startup logs
   it and immediately kicks off a full reindex; `mnotes stats` reports 100% of notes pending).

This is intentionally simple: bump the version constant whenever the schema changes, and the rebuild
is unconditional. No migration script authoring, no partial-migration edge cases.

**Keeping the drop list and the create list in sync**: the set of tables to drop and the set of
tables `createSchema` creates are two lists that must agree — if a future schema version adds a
table to one and not the other, an upgrade against a populated database throws mid-rebuild instead
of completing (exactly the moment the migration is supposed to be saving you). Rather than deriving
the drop list dynamically from `sqlite_master` (which would need care to preserve FK-safe drop
ordering), this is guarded by a test: after both a fresh open and a rebuild-from-stale-version open,
assert `sqlite_master` contains all nine expected tables (not an exact-set equality check — FTS5
and `vec0` each create their own internal shadow tables alongside `notes_fts`/`chunk_vectors`, which
are a normal, expected side effect of those virtual table modules, not schema drift to filter out or
guard against). That turns a future list-drift bug into a failing test instead of a silent
production break.

## Logging

`core/db.js` calls `getContextLogger()` (per `S008`'s "Context propagation into `core/`" section) at
the two notable branches of `openDb`'s version check — never on the routine reopen-at-current-version
path, which stays silent to avoid a log line on every process startup for the expected case:

- **Fresh database** (no `meta` table yet, i.e. first-ever open at a given `dbPath`) — `info`,
  `"schema created"`, context `{ schema_version }`.
- **Stale schema version** (rebuild-and-wipe path) — `warn`, `"schema version mismatch, rebuilding"`,
  context `{ from_version, to_version }` — `warn`, not `info`, because this branch drops and recreates
  every table, which is a lossy, unusual event worth flagging distinctly from routine startup even
  though it's an expected, handled condition (not an error `core/db.js` throws for).

These lines land in whichever log file the caller's `runWithLogger` context points at — typically
`indexer.log` for the daemon's startup `openDb` call (`S005`) — `core/db.js` itself never opens or
names a log file. Callers that invoke `openDb` with no enclosing `runWithLogger` context (every
`core/db.js` unit test, and any one-off script) get `getContextLogger()`'s no-op fallback: `openDb`
behaves identically, just without writing anywhere.

## Idempotent reindex

Reindexing a single note (`mnotes reindex <title>` or a daemon-triggered re-index on file change) is:

1. `INSERT INTO notes (...) VALUES (...) ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, line_count=excluded.line_count, mtime=excluded.mtime, updated_at=excluded.updated_at, extraction_version=excluded.extraction_version`.
2. Delete all existing `chunks` rows for that `note_id` (cascades to `chunk_vectors` via the
   `chunks`/`chunk_vectors` 1:1 rowid relationship — deletion is explicit in application code since
   `vec0` doesn't support `ON DELETE CASCADE` from a regular foreign key).
3. Delete and re-insert `notes_fts` row for that rowid.
4. Delete and re-insert `note_tags` rows for that note, then delete any `tags` row left with no
   remaining `note_tags` reference (`pruneOrphanedTags` in `core/tags.js`) — otherwise a tag this
   note was the last carrier of would linger as a permanent orphan row, inflating `mnotes stats`'
   `tag_count` forever (this was #1: a raw `SELECT COUNT(*) FROM tags` doesn't filter these out the
   way `tagList`'s join does). `deleteNoteByPath`'s note-removal path prunes the same way, since it
   never goes through this step.
5. Delete and re-insert `note_links` rows for that note (S011).
6. Re-chunk, re-embed, and insert fresh `chunks`/`chunk_vectors` rows.

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
- **Wikilink extraction rules and backlink/rename-cascade queries** (`[[Target]]`/`[[Target|Alias]]`
  syntax, code-region exclusion, `getBacklinks`, the rewrite helper `note_rename` uses) — S011 (links).
- **Chunking algorithm specifics** (token counting method, ~512 token target / ~15% overlap window
  boundaries) — S005 (indexing-daemon), since chunking happens in `indexer/embed.js`, not `core/db.js`.
- **Rename detection** — this schema supports either "daemon detects rename and does an UPDATE" or
  "daemon always does delete+insert on path change" equally well, since `path UNIQUE` + upsert is
  idempotent either way. Which strategy the daemon actually uses is S005's concern.
