import { statSync } from 'node:fs';
import { join } from 'node:path';
import { noteRead } from '../core/notes.js';
import { extractTags, syncNoteTags } from '../core/tags.js';
import { getContextLogger } from '../logger.js';

export function enqueuePath(db, path, now = Date.now()) {
    db.prepare(`
        INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO NOTHING
    `).run(path, now, now);
}

export function dequeueNextPath(db, now = Date.now()) {
    const row = db.prepare(`
        SELECT path FROM index_queue
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at, enqueued_at
        LIMIT 1
    `).get(now);
    return row ? row.path : null;
}

function upsertNoteRow(db, path, contentHash, lineCount, mtime, updatedAt) {
    db.prepare(`
        INSERT INTO notes (path, content_hash, line_count, mtime, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            line_count = excluded.line_count,
            mtime = excluded.mtime,
            updated_at = excluded.updated_at
    `).run(path, contentHash, lineCount, mtime, updatedAt);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion) {
    const staleChunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(noteId).map((r) => r.id);
    for (const chunkId of staleChunkIds) {
        db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?').run(chunkId);
    }
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);

    const insertChunk = db.prepare(`
        INSERT INTO chunks (note_id, chunk_index, char_start, char_end, token_count, embedding_model, embedding_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVector = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)');

    for (const chunk of embeddedChunks) {
        insertChunk.run(
            noteId, chunk.chunkIndex, chunk.charStart, chunk.charEnd, chunk.tokenCount,
            embeddingModel, embeddingVersion,
        );
        const chunkId = db.prepare(
            'SELECT id FROM chunks WHERE note_id = ? AND chunk_index = ?',
        ).get(noteId, chunk.chunkIndex).id;
        insertVector.run(chunkId, Buffer.from(chunk.vector.buffer));
    }
}

function replaceFtsRow(db, noteId, title, body) {
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(noteId);
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

export function deleteNoteByPath(db, path) {
    const note = db.prepare('SELECT id FROM notes WHERE path = ?').get(path);
    if (!note) {
        return;
    }
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(note.id).map((r) => r.id);
    for (const chunkId of chunkIds) {
        db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?').run(chunkId);
    }
    db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(note.id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id); // cascades chunks, note_tags (S001 FKs)
}

export async function processPath(vaultRoot, db, path, deps) {
    const { chunkText, embed, embeddingModel, embeddingVersion, now = Date.now() } = deps;
    const absPath = join(vaultRoot, path);
    const title = path.replace(/\.md$/, '');

    let stats;
    try {
        stats = statSync(absPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            deleteNoteByPath(db, path);
            return { status: 'deleted' };
        }
        throw err;
    }

    const currentMtime = Math.floor(stats.mtimeMs / 1000);
    const existing = db.prepare('SELECT id, mtime, content_hash FROM notes WHERE path = ?').get(path);
    if (existing && existing.mtime === currentMtime) {
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    let read;
    try {
        read = noteRead(vaultRoot, title);
    } catch (err) {
        if (/not found/i.test(err.message)) {
            deleteNoteByPath(db, path);
            return { status: 'deleted' };
        }
        throw err;
    }

    if (existing && existing.content_hash === read.content_hash) {
        db.prepare('UPDATE notes SET mtime = ?, updated_at = ? WHERE id = ?')
            .run(currentMtime, Math.floor(now / 1000), existing.id);
        getContextLogger().debug('skipping unchanged path', { note_title: title });
        return { status: 'unchanged' };
    }

    const chunkDescriptors = chunkText(read.content);
    const embeddedChunks = [];
    for (const descriptor of chunkDescriptors) {
        const chunkBody = read.content.slice(descriptor.charStart, descriptor.charEnd);
        const vector = await embed(chunkBody);
        embeddedChunks.push({ ...descriptor, vector });
    }

    const noteId = upsertNoteRow(
        db, path, read.content_hash, read.total_lines, currentMtime, Math.floor(now / 1000),
    );
    replaceChunks(db, noteId, embeddedChunks, embeddingModel, embeddingVersion);
    replaceFtsRow(db, noteId, title, read.content);
    syncNoteTags(db, noteId, extractTags(read.content, read.metadata));

    getContextLogger().info('reindexed note', { note_title: title, chunk_count: embeddedChunks.length });
    return { status: 'reindexed' };
}
