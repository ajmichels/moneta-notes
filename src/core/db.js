import { DatabaseSync } from 'node:sqlite';
import { load } from 'sqlite-vec';

export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    load(db);
    db.enableLoadExtension(false);

    return { db, reindexRequired: false };
}
