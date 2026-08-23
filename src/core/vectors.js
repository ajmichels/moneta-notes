import { resolveTitle, stripMdExtension } from './note-fs.js';

export function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buf) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function cosineDistance(a, b) {
    return 1 - cosineSimilarity(a, b);
}

function normalize(vector) {
    let normSq = 0;
    for (let i = 0; i < vector.length; i += 1) {
        normSq += vector[i] * vector[i];
    }
    const norm = Math.sqrt(normSq);
    const out = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i += 1) {
        out[i] = vector[i] / norm;
    }
    return out;
}

function centroidOf(vectors) {
    const dims = vectors[0].length;
    const sum = new Float32Array(dims);
    for (const vector of vectors) {
        for (let i = 0; i < dims; i += 1) {
            sum[i] += vector[i];
        }
    }
    return normalize(sum);
}

export function getChunkVectors(db, chunkIds) {
    if (chunkIds.length === 0) {
        return new Map();
    }
    const placeholders = chunkIds.map(() => '?').join(', ');
    const rows = db.prepare(`
        SELECT rowid AS chunk_id, embedding
        FROM chunk_vectors
        WHERE rowid IN (${placeholders})
    `).all(...chunkIds);
    return new Map(rows.map((row) => [ row.chunk_id, bufferToVector(row.embedding) ]));
}

export function getAllChunkVectors(db, options = {}) {
    const { noteIds = null, embeddingModel, embeddingVersion } = options;
    const scopeClause = noteIds !== null ? `AND c.note_id IN (${noteIds.map(() => '?').join(', ')})` : '';
    const rows = db.prepare(`
        SELECT c.id AS chunk_id, c.note_id AS note_id, c.line_start AS line_start, c.line_end AS line_end,
               cv.embedding AS embedding
        FROM chunks c
        JOIN chunk_vectors cv ON cv.rowid = c.id
        WHERE c.embedding_model = ? AND c.embedding_version = ? ${scopeClause}
        ORDER BY c.note_id, c.chunk_index
    `).all(embeddingModel, embeddingVersion, ...(noteIds ?? []));

    return rows.map((row) => ({
        chunkId: row.chunk_id,
        noteId: row.note_id,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        vector: bufferToVector(row.embedding),
    }));
}

export function getAllNoteVectors(db, options = {}) {
    const { noteIds = null, embeddingModel, embeddingVersion } = options;
    const chunkVectors = getAllChunkVectors(db, { noteIds, embeddingModel, embeddingVersion });

    const byNote = new Map();
    for (const chunk of chunkVectors) {
        if (!byNote.has(chunk.noteId)) {
            byNote.set(chunk.noteId, []);
        }
        byNote.get(chunk.noteId).push(chunk.vector);
    }

    return [ ...byNote.entries() ].map(([ noteId, vectors ]) => ({ noteId, vector: centroidOf(vectors) }));
}

// The one shared "one vector per note" helper — cluster/reduce/outliers/tag-fit/tag-redundancy/
// calibrate all call this rather than each hand-rolling their own centroid math (S013).
export function getNoteVector(db, noteId, options = {}) {
    const vectors = getAllNoteVectors(db, { noteIds: [ noteId ], ...options });
    return vectors.length > 0 ? vectors[0].vector : null;
}

export function noteIdForTitle(db, title) {
    const row = db.prepare('SELECT id FROM notes WHERE path = ?').get(`${title}.md`);
    return row ? row.id : null;
}

export function titleForNoteId(db, noteId) {
    const row = db.prepare('SELECT path FROM notes WHERE id = ?').get(noteId);
    if (!row) {
        throw new Error(`vectors: no note found with id ${noteId}`);
    }
    return stripMdExtension(row.path);
}

export function resolveNoteId(db, rawTitle) {
    const resolved = resolveTitle(db, rawTitle);
    if (resolved === null) {
        throw new Error(`vectors: no note found matching "${rawTitle}"`);
    }
    return noteIdForTitle(db, resolved);
}

function escapeLikePattern(value) {
    return value.replace(/[%_]/g, (char) => `\\${char}`);
}

function tagScopeNoteIds(db, tag) {
    return db.prepare(`
        SELECT DISTINCT n.id AS id
        FROM notes n
        JOIN note_tags nt ON nt.note_id = n.id
        JOIN tags t ON t.id = nt.tag_id
        WHERE t.name = ? OR t.name LIKE ? || '/%'
    `).all(tag, tag).map((row) => row.id);
}

function folderScopeNoteIds(db, folder) {
    const normalized = folder.endsWith('/') ? folder.slice(0, -1) : folder;
    const escaped = escapeLikePattern(normalized);
    return db.prepare("SELECT id FROM notes WHERE path LIKE ? ESCAPE '\\'").all(`${escaped}/%`)
        .map((row) => row.id);
}

// Returns null (no scoping — whole vault) or an array of note ids. Shared by `cluster`/`reduce`'s
// `--tag`/`--folder` flags (S013) — mutually exclusive, validated here rather than duplicated
// per caller.
export function resolveScopeNoteIds(db, options = {}) {
    const { tag, folder } = options;
    if (tag && folder) {
        throw new Error('vectors: --tag and --folder are mutually exclusive');
    }
    if (tag) {
        return tagScopeNoteIds(db, tag);
    }
    if (folder) {
        return folderScopeNoteIds(db, folder);
    }
    return null;
}
