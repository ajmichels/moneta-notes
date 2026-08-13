import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';
import { getContextLogger } from '../logger.js';

// node:sqlite binds every JS `number` as SQLite REAL, never INTEGER (only BigInt binds as
// 'integer'). This is harmless for INTEGER-affinity columns (SQLite coerces 5.0 back to 5) but
// `vec0` rejects a REAL rowid outright (chunk_vectors inserts must CAST(? AS INTEGER)), and
// `meta.value` (TEXT affinity) would silently store a trailing '.0' unless explicitly
// String()-ed — see getMeta/setMeta below, which apply that rule internally.

export const SCHEMA_VERSION = 1;

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
            embedding_version TEXT NOT NULL,
            UNIQUE (note_id, chunk_index)
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

function createTagsTable(db) {
    db.exec(`
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL COLLATE NOCASE
        )
    `);
}

function createNoteTagsTable(db) {
    db.exec(`
        CREATE TABLE note_tags (
            note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (note_id, tag_id)
        )
    `);
    db.exec('CREATE INDEX note_tags_tag_id ON note_tags(tag_id)');
}

function createNotesFtsTable(db) {
    db.exec(`
        CREATE VIRTUAL TABLE notes_fts USING fts5(
            title,
            body,
            content='',
            contentless_delete=1,
            tokenize='porter unicode61 remove_diacritics 2'
        )
    `);
}

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

function tableExists(db, name) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
        .get(name);
    return row !== undefined;
}

export function getMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

export function setMeta(db, key, value) {
    if (value === null || value === undefined) {
        throw new Error(`setMeta: value for key "${key}" must not be null or undefined`);
    }
    db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

function readSchemaVersion(db) {
    if (!tableExists(db, 'meta')) {
        return null;
    }
    const value = getMeta(db, 'schema_version');
    return value === null ? null : Number(value);
}

function writeSchemaVersion(db, version) {
    setMeta(db, 'schema_version', version);
}

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');

    const currentVersion = readSchemaVersion(db);
    let reindexRequired = false;

    if (currentVersion === null) {
        dropAllTables(db);
        createSchema(db);
        writeSchemaVersion(db, SCHEMA_VERSION);
        reindexRequired = true;
        getContextLogger().info('schema created', { schema_version: SCHEMA_VERSION });
    } else if (currentVersion !== SCHEMA_VERSION) {
        dropAllTables(db);
        createSchema(db);
        writeSchemaVersion(db, SCHEMA_VERSION);
        reindexRequired = true;
        getContextLogger().warn('schema version mismatch, rebuilding', {
            from_version: currentVersion,
            to_version: SCHEMA_VERSION,
        });
    }

    return { db, reindexRequired };
}
