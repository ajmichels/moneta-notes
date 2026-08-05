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
}

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

function createSchema(db) {
    createNotesTable(db);
    createChunksTable(db);
    createChunkVectorsTable(db);
    createTagsTable(db);
    createNoteTagsTable(db);
    createNotesFtsTable(db);
    createIndexQueueTable(db);
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
