# S001 Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/core/db.js` — schema creation, `node:sqlite` + `sqlite-vec` connection
setup, and version-check-and-rebuild migration — per `docs/specs/S001-data-model.md`.

**Architecture:** A single `openDb(dbPath)` function returns `{ db, reindexRequired }`. It opens a
`node:sqlite` `DatabaseSync` connection, loads the `sqlite-vec` extension, enables foreign key
enforcement, and ensures the schema is current — rebuilding (drop + recreate all tables) if
`meta.schema_version` doesn't match the code's `SCHEMA_VERSION`, signaling `reindexRequired: true`
when it does. Each table gets its own small `createXTable(db)` function, called in FK-dependency
order from `createSchema(db)`.

**Tech Stack:** Node 24 built-in `node:sqlite`, `sqlite-vec` (npm, loaded as a runtime extension),
Vitest with real temp-file/in-memory SQLite databases (no mocking the DB layer, per CLAUDE.md).

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `core/` takes plain arguments, returns plain data, throws on error — no CLI/MCP concerns
  (CLAUDE.md, S001).
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md).
- Test files colocated: `src/core/db.js` → `src/core/db.test.js` (CLAUDE.md).
- Use a real temp/in-memory SQLite DB in tests, never mock `core/db.js` (CLAUDE.md).
- 4-space indentation, single quotes, trailing commas on multiline (matches existing
  `eslint.config.js`-enforced style in `vitest.config.js`/`vitest.helpers.js`).
- `func-style: declaration` — use `function foo() {}`, not `const foo = () => {}`, for named
  functions (arrow functions are fine for inline callbacks).
- Driver is `node:sqlite`'s `DatabaseSync`, not `better-sqlite3` (S001 amendment).
- Exact schema (columns, constraints, table names) per `docs/specs/S001-data-model.md` — copied
  verbatim into the tasks below.

---

### Task 1: `openDb` opens a connection and loads `sqlite-vec`

**Files:**
- Modify: `package.json` (add `sqlite-vec` dependency)
- Create: `src/core/db.js`
- Create: `src/core/db.test.js`

**Interfaces:**
- Produces: `openDb(dbPath: string) -> { db: DatabaseSync, reindexRequired: boolean }` — later tasks
  call this and use the returned `db` to run queries, and `reindexRequired` to decide whether to
  trigger a full reindex (S005).

- [ ] **Step 1: Add the `sqlite-vec` dependency**

Run: `pnpm add sqlite-vec@^0.1.9`

- [ ] **Step 2: Write the failing test**

Create `src/core/db.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';

describe('openDb', () => {
    it('loads the sqlite-vec extension', () => {
        const { db } = openDb(':memory:');
        const row = db.prepare('SELECT vec_version() AS version').get();
        expect(typeof row.version).toBe('string');
        db.close();
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `src/core/db.js` doesn't exist yet (`Cannot find module './db.js'` or similar).

- [ ] **Step 4: Write minimal implementation**

Create `src/core/db.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    return { db, reindexRequired: false };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/core/db.js src/core/db.test.js
git commit -m "feat(db): open connection and load sqlite-vec extension"
```

---

### Task 2: `notes` table

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Consumes: `openDb` from Task 1.
- Produces: a `notes` table matching S001's schema, available to every later task's tests.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js` (new `describe` block):

```js
describe('schema: notes table', () => {
    it('creates the notes table with the expected columns', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Weekly Notes/2026-W32.md', 'abc123', 42, 1000, 1000);

        const row = db.prepare('SELECT * FROM notes WHERE path = ?').get('Weekly Notes/2026-W32.md');
        expect(row.content_hash).toBe('abc123');
        expect(row.line_count).toBe(42);
        db.close();
    });

    it('rejects a duplicate path', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Dup.md', 'a', 1, 1, 1);

        expect(() => {
            db.prepare(
                'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
            ).run('Dup.md', 'b', 2, 2, 2);
        }).toThrow();
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: notes`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

function createNotesTable(db) {
    db.exec(`
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            content_hash TEXT NOT NULL,
            line_count INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
}

function createSchema(db) {
    createNotesTable(db);
}

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    createSchema(db);

    return { db, reindexRequired: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS (3 tests: extension load + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create notes table"
```

---

### Task 3: `chunks` table, foreign key cascade

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Consumes: `notes` table from Task 2.
- Produces: a `chunks` table with `ON DELETE CASCADE` to `notes`, and `PRAGMA foreign_keys = ON`
  enforced on every connection (this pragma is per-connection in SQLite — every `openDb` call sets it,
  not just a one-time schema thing).

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema: chunks table', () => {
    it('cascades chunk deletion when the parent note is deleted', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare(`
            INSERT INTO chunks
                (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 100, 50, ?, ?)
        `).run(noteId, 'Qwen3-Embedding-0.6B', 'v1');

        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);

        const remaining = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE note_id = ?').get(noteId);
        expect(remaining.count).toBe(0);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: chunks`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

function createNotesTable(db) {
    db.exec(`
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            content_hash TEXT NOT NULL,
            line_count INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
}

function createChunksTable(db) {
    db.exec(`
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY,
            note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            char_start INTEGER NOT NULL,
            char_end INTEGER NOT NULL,
            token_count INTEGER NOT NULL,
            embedding_model TEXT NOT NULL,
            embedding_version TEXT NOT NULL
        )
    `);
}

function createSchema(db) {
    createNotesTable(db);
    createChunksTable(db);
}

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    db.exec('PRAGMA foreign_keys = ON');

    createSchema(db);

    return { db, reindexRequired: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create chunks table, enforce foreign key cascade"
```

---

### Task 4: `chunk_vectors` (sqlite-vec `vec0`) table

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Consumes: `chunks` table from Task 3.
- Produces: a `chunk_vectors` vec0 table, `rowid`-joined to `chunks.id`, storing `float[1024]`
  embeddings, queryable via sqlite-vec's KNN `MATCH` syntax.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema: chunk_vectors table', () => {
    it('stores a 1024-dim vector and supports a KNN query', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare(`
            INSERT INTO chunks
                (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
            VALUES (?, 0, 0, 100, 50, ?, ?)
        `).run(noteId, 'Qwen3-Embedding-0.6B', 'v1');
        const chunkId = db.prepare('SELECT id FROM chunks WHERE note_id = ?').get(noteId).id;

        const vector = new Float32Array(1024).fill(0.1);
        db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)').run(
            chunkId,
            Buffer.from(vector.buffer),
        );

        const queryVector = new Float32Array(1024).fill(0.1);
        const hit = db.prepare(`
            SELECT rowid FROM chunk_vectors
            WHERE embedding MATCH ? AND k = 1
            ORDER BY distance
        `).get(Buffer.from(queryVector.buffer));

        expect(hit.rowid).toBe(chunkId);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: chunk_vectors`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `createChunkVectorsTable` and register it:

```js
import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

function createNotesTable(db) {
    db.exec(`
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            content_hash TEXT NOT NULL,
            line_count INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
}

function createChunksTable(db) {
    db.exec(`
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY,
            note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            char_start INTEGER NOT NULL,
            char_end INTEGER NOT NULL,
            token_count INTEGER NOT NULL,
            embedding_model TEXT NOT NULL,
            embedding_version TEXT NOT NULL
        )
    `);
}

function createChunkVectorsTable(db) {
    db.exec(`
        CREATE VIRTUAL TABLE chunk_vectors USING vec0(
            embedding float[1024] distance_metric=cosine
        )
    `);
}

function createSchema(db) {
    createNotesTable(db);
    createChunksTable(db);
    createChunkVectorsTable(db);
}

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    db.exec('PRAGMA foreign_keys = ON');

    createSchema(db);

    return { db, reindexRequired: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create chunk_vectors vec0 table"
```

---

### Task 5: `tags` table, `COLLATE NOCASE`

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Produces: a `tags` table with case-insensitive unique names, first-seen casing preserved on
  conflict — matches Obsidian's own tag behavior (S004 depends on this for `tag_list`/`tag_notes`).

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema: tags table', () => {
    it('preserves first-seen casing via COLLATE NOCASE uniqueness', () => {
        const { db } = openDb(':memory:');
        db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run('Project');
        db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run('project');

        const rows = db.prepare('SELECT name FROM tags').all();
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Project');
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: tags`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `createTagsTable` and register it:

```js
function createTagsTable(db) {
    db.exec(`
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL COLLATE NOCASE
        )
    `);
}
```

Add `createTagsTable(db);` to `createSchema` after `createChunkVectorsTable(db);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create tags table with case-insensitive uniqueness"
```

---

### Task 6: `note_tags` join table

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Consumes: `notes` (Task 2), `tags` (Task 5).
- Produces: `note_tags`, cascading on deletion of either side.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema: note_tags table', () => {
    it('cascades when the note or the tag is deleted', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Test.md').id;

        db.prepare('INSERT INTO tags (name) VALUES (?)').run('project');
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get('project').id;

        db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);

        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
        const afterNoteDelete = db.prepare('SELECT COUNT(*) AS count FROM note_tags').get();
        expect(afterNoteDelete.count).toBe(0);

        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: note_tags`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `createNoteTagsTable` and register it:

```js
function createNoteTagsTable(db) {
    db.exec(`
        CREATE TABLE note_tags (
            note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (note_id, tag_id)
        )
    `);
}
```

Add `createNoteTagsTable(db);` to `createSchema` after `createTagsTable(db);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create note_tags join table"
```

---

### Task 7: `notes_fts` (contentless FTS5) table

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Produces: a contentless FTS5 table (`content=''`) over `title`/`body`, `rowid`-joined to
  `notes.id`, queryable via `MATCH` — no note text is duplicated into the DB.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema: notes_fts table', () => {
    it('supports a contentless MATCH query', () => {
        const { db } = openDb(':memory:');
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (1, ?, ?)').run(
            'Test Title',
            'hello world body',
        );

        const hit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").get();
        expect(hit.rowid).toBe(1);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: notes_fts`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `createNotesFtsTable` and register it:

```js
function createNotesFtsTable(db) {
    db.exec(`
        CREATE VIRTUAL TABLE notes_fts USING fts5(
            title,
            body,
            content='',
            tokenize='porter unicode61 remove_diacritics 2'
        )
    `);
}
```

Add `createNotesFtsTable(db);` to `createSchema` after `createNoteTagsTable(db);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create contentless notes_fts table"
```

---

### Task 8: `index_queue` table

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Produces: `index_queue`, `path` as primary key so re-enqueueing a pending path is a safe
  `ON CONFLICT DO NOTHING` (consumed by S005's daemon).

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema: index_queue table', () => {
    it('deduplicates re-enqueued paths via the path primary key', () => {
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING',
        ).run('Test.md', 1000, 1000);
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING',
        ).run('Test.md', 2000, 2000);

        const rows = db.prepare('SELECT * FROM index_queue').all();
        expect(rows).toHaveLength(1);
        expect(rows[0].enqueued_at).toBe(1000);
        expect(rows[0].attempts).toBe(0);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: index_queue`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `createIndexQueueTable` and register it:

```js
function createIndexQueueTable(db) {
    db.exec(`
        CREATE TABLE index_queue (
            path TEXT PRIMARY KEY,
            enqueued_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL
        )
    `);
}
```

Add `createIndexQueueTable(db);` to `createSchema` after `createNotesFtsTable(db);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create index_queue table"
```

---

### Task 9: `meta` table, schema version bootstrap, idempotent reopen

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Produces: `SCHEMA_VERSION` (exported constant), `meta` table, and `openDb`'s `reindexRequired`
  return value now reflects real logic — `true` on a fresh database, `false` on a subsequent open
  against a database already at the current version (data preserved, schema not recreated).

This task introduces temp-file-backed databases (not just `:memory:`) since idempotent-reopen
requires two separate `openDb` calls against the same persisted file.

- [ ] **Step 1: Write the failing tests**

Add near the top of `src/core/db.test.js` (new imports and a helper):

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';

const tempDirs = [];

function makeTempDbPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-db-test-'));
    tempDirs.push(dir);
    return join(dir, 'index.db');
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});
```

Add a new `describe` block:

```js
describe('schema versioning', () => {
    it('sets schema_version and reports reindexRequired on a fresh database', () => {
        const { db, reindexRequired } = openDb(':memory:');
        expect(reindexRequired).toBe(true);

        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        expect(row.value).toBe('1');
        db.close();
    });

    it('does not rebuild or lose data on a reopen at the same version', () => {
        const dbPath = makeTempDbPath();

        const first = openDb(dbPath);
        first.db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        first.db.close();

        const second = openDb(dbPath);
        expect(second.reindexRequired).toBe(false);

        const row = second.db.prepare('SELECT * FROM notes WHERE path = ?').get('Test.md');
        expect(row.content_hash).toBe('abc123');
        second.db.close();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `no such table: meta` (first test); the second test would also fail once the first
is fixed naively, because without version-checking, a second `openDb` on the same file re-runs
`createSchema`, which throws `table notes already exists`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `SCHEMA_VERSION`, `createMetaTable`, version-read/write helpers, and
wrap schema creation in a version check:

```js
import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

export const SCHEMA_VERSION = 1;

// ... (createNotesTable, createChunksTable, createChunkVectorsTable, createTagsTable,
//      createNoteTagsTable, createNotesFtsTable, createIndexQueueTable unchanged from prior tasks)

function createMetaTable(db) {
    db.exec(`
        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);
}

function createSchema(db) {
    createNotesTable(db);
    createChunksTable(db);
    createChunkVectorsTable(db);
    createTagsTable(db);
    createNoteTagsTable(db);
    createNotesFtsTable(db);
    createIndexQueueTable(db);
    createMetaTable(db);
}

function tableExists(db, name) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
        .get(name);
    return row !== undefined;
}

function readSchemaVersion(db) {
    if (!tableExists(db, 'meta')) {
        return null;
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : null;
}

function writeSchemaVersion(db, version) {
    db.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(version));
}

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    db.exec('PRAGMA foreign_keys = ON');

    const currentVersion = readSchemaVersion(db);
    let reindexRequired = false;

    if (currentVersion !== SCHEMA_VERSION) {
        createSchema(db);
        writeSchemaVersion(db, SCHEMA_VERSION);
        reindexRequired = true;
    }

    return { db, reindexRequired };
}
```

Note: this task deliberately does **not** yet add `dropAllTables` — a version *mismatch* against an
existing populated database (as opposed to a completely fresh one) will still throw on the
`createSchema` call inside the `if` block, because the tables from the previous version are still
there. That's the subject of Task 10.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): create meta table, bootstrap schema_version, idempotent reopen"
```

---

### Task 10: Version mismatch rebuilds the schema

**Files:**
- Modify: `src/core/db.js`
- Modify: `src/core/db.test.js`

**Interfaces:**
- Produces: `openDb`'s version-mismatch path now drops every table before recreating them, so a
  stale `schema_version` (e.g. after a code upgrade that bumped `SCHEMA_VERSION`) safely rebuilds
  from scratch instead of throwing.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db.test.js`:

```js
describe('schema rebuild on version mismatch', () => {
    it('rebuilds all tables and wipes data when schema_version is stale', () => {
        const dbPath = makeTempDbPath();

        const first = openDb(dbPath);
        first.db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Test.md', 'abc123', 10, 1000, 1000);
        first.db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
        first.db.close();

        const second = openDb(dbPath);
        expect(second.reindexRequired).toBe(true);

        const noteCount = second.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
        expect(noteCount).toBe(0);

        const version = second.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        expect(version.value).toBe('1');
        second.db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db.test.js`
Expected: FAIL — `table notes already exists` (thrown from inside `createSchema`'s
`createNotesTable` call on the second `openDb`).

- [ ] **Step 3: Write minimal implementation**

Update `src/core/db.js` — add `dropAllTables` and call it before `createSchema` in the mismatch
branch:

```js
const TABLES_IN_DROP_ORDER = [
    'note_tags',
    'index_queue',
    'chunk_vectors',
    'chunks',
    'notes_fts',
    'tags',
    'notes',
    'meta',
];

function dropAllTables(db) {
    for (const table of TABLES_IN_DROP_ORDER) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
}
```

Update `openDb`'s body:

```js
export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    db.exec('PRAGMA foreign_keys = ON');

    const currentVersion = readSchemaVersion(db);
    let reindexRequired = false;

    if (currentVersion !== SCHEMA_VERSION) {
        dropAllTables(db);
        createSchema(db);
        writeSchemaVersion(db, SCHEMA_VERSION);
        reindexRequired = true;
    }

    return { db, reindexRequired };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db.test.js`
Expected: PASS (full suite green)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/db.js src/core/db.test.js
git commit -m "feat(db): rebuild schema on version mismatch"
```

---

## Self-Review Notes

- **Spec coverage**: every table in S001 (`notes`, `chunks`, `chunk_vectors`, `tags`, `note_tags`,
  `notes_fts`, `index_queue`, `meta`) has a dedicated task and test. The `node:sqlite` driver choice,
  extension loading pattern, `PRAGMA foreign_keys`, `COLLATE NOCASE` tags, contentless FTS5, and
  version-check-and-rebuild migration are all covered. Chunk/note title derivation (S003), search
  ranking queries (S002), and tag extraction (S004) are explicitly out of scope for S001 and this
  plan — they consume `openDb`'s connection but aren't implemented here.
- **Placeholder scan**: no TODOs/TBDs; every step has complete, runnable code.
- **Type consistency**: `openDb(dbPath) -> { db, reindexRequired }` is the same signature used
  identically from Task 1 through Task 10; `SCHEMA_VERSION` introduced in Task 9 is referenced
  consistently in Task 10.
