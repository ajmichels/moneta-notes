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
