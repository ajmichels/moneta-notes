import { getContextLogger } from '../logger.js';

const DEFAULT_LIMIT = 20;
const OVERFETCH_MULTIPLIER = 5;
const OVERFETCH_CAP = 500;

function pathToTitle(path) {
    return path.replace(/\.md$/, '');
}

function computeOverfetch(limit) {
    return Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
}

function validateQuery(query) {
    if (typeof query !== 'string' || query.length === 0) {
        throw new Error('search: query must be a non-empty string');
    }
}

const MAX_LIMIT = 100;

function validateLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`search: limit must be an integer between 1 and ${MAX_LIMIT}, got ${limit}`);
    }
}

function fulltextSearch(db, query, limit) {
    let rows;
    try {
        rows = db.prepare(`
            SELECT n.id AS note_id, n.path, n.line_count AS file_line_count, n.mtime,
                   bm25(notes_fts) AS score
            FROM notes_fts
            JOIN notes n ON n.id = notes_fts.rowid
            WHERE notes_fts MATCH ?
            ORDER BY bm25(notes_fts)
            LIMIT ?
        `).all(query, computeOverfetch(limit));
    } catch (err) {
        getContextLogger().warn('malformed FTS5 query', { query });
        throw new Error(`search: malformed fulltext query "${query}": ${err.message}`, { cause: err });
    }

    rows.sort((a, b) => a.score - b.score || b.mtime - a.mtime);

    return rows.map((row, index) => ({
        noteId: row.note_id,
        noteTitle: pathToTitle(row.path),
        fileLineCount: row.file_line_count,
        mtime: row.mtime,
        score: row.score,
        rank: index + 1,
    }));
}

function toFulltextOutput(results, limit) {
    return results.slice(0, limit).map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
    }));
}

function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer);
}

function runSemanticQuery(db, vector, fetchCount, embeddingModel, embeddingVersion) {
    // `k` is interpolated, not bound: node:sqlite binds every JS number as SQLite REAL, and vec0's
    // KNN `k` constraint wants an integer literal (the same numeric-binding quirk S001 documents
    // for chunk_vectors.rowid). `fetchCount` is always an internally computed, bounded integer
    // (computeOverfetch of a caller-supplied limit), never raw user input, so interpolating it here
    // carries no injection risk.
    return db.prepare(`
        SELECT c.note_id AS note_id, cv.distance AS distance
        FROM chunk_vectors cv
        JOIN chunks c ON c.id = cv.rowid
        WHERE cv.embedding MATCH ? AND k = ${fetchCount}
          AND c.embedding_model = ?
          AND c.embedding_version = ?
        ORDER BY cv.distance
    `).all(vectorToBuffer(vector), embeddingModel, embeddingVersion);
}

function collapseToBestChunkPerNote(rows) {
    const bestDistanceByNote = new Map();
    for (const row of rows) {
        if (!bestDistanceByNote.has(row.note_id)) {
            bestDistanceByNote.set(row.note_id, row.distance);
        }
    }
    return bestDistanceByNote;
}

function hydrateNotes(db, noteIds) {
    if (noteIds.length === 0) {
        return new Map();
    }
    const placeholders = noteIds.map(() => '?').join(', ');
    const rows = db.prepare(`
        SELECT id, path, line_count AS file_line_count, mtime
        FROM notes
        WHERE id IN (${placeholders})
    `).all(...noteIds);
    return new Map(rows.map((row) => [ row.id, row ]));
}

function countStaleChunks(db, embeddingModel, embeddingVersion) {
    const row = db.prepare(`
        SELECT COUNT(*) AS count FROM chunks
        WHERE NOT (embedding_model = ? AND embedding_version = ?)
    `).get(embeddingModel, embeddingVersion);
    return row.count;
}

async function semanticSearch(db, query, limit, { embed, embeddingModel, embeddingVersion }) {
    if (typeof embed !== 'function') {
        throw new Error('search: semantic and hybrid modes require an `embed` function');
    }

    const vector = await embed(query);
    const rawRows = runSemanticQuery(db, vector, computeOverfetch(limit), embeddingModel, embeddingVersion);

    const staleCount = countStaleChunks(db, embeddingModel, embeddingVersion);
    if (staleCount > 0) {
        getContextLogger().debug('excluded chunks from stale embedding model', {
            excluded_count: staleCount,
            current_model: `${embeddingModel}@${embeddingVersion}`,
        });
    }

    const bestDistanceByNote = collapseToBestChunkPerNote(rawRows);
    const notesById = hydrateNotes(db, [ ...bestDistanceByNote.keys() ]);

    const collapsed = [ ...bestDistanceByNote.entries() ].map(([ noteId, distance ]) => {
        const note = notesById.get(noteId);
        return {
            noteId,
            noteTitle: pathToTitle(note.path),
            fileLineCount: note.file_line_count,
            mtime: note.mtime,
            distance,
        };
    });

    collapsed.sort((a, b) => a.distance - b.distance || b.mtime - a.mtime);

    return collapsed.map((row, index) => ({ ...row, rank: index + 1 }));
}

function toSemanticOutput(results, limit) {
    return results.slice(0, limit).map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
    }));
}

const RRF_K = 60;

function computeRrfScore(fulltextRank, semanticRank) {
    let score = 0;
    if (fulltextRank !== undefined) {
        score += 1 / (RRF_K + fulltextRank);
    }
    if (semanticRank !== undefined) {
        score += 1 / (RRF_K + semanticRank);
    }
    return score;
}

function mergeHybrid(fulltextResults, semanticResults, limit) {
    const fulltextRankById = new Map(fulltextResults.map((r) => [ r.noteId, r.rank ]));
    const semanticRankById = new Map(semanticResults.map((r) => [ r.noteId, r.rank ]));

    const byId = new Map();
    for (const r of [ ...fulltextResults, ...semanticResults ]) {
        if (!byId.has(r.noteId)) {
            byId.set(r.noteId, r);
        }
    }

    const merged = [ ...byId.values() ].map((r) => {
        const fulltextRank = fulltextRankById.get(r.noteId);
        const semanticRank = semanticRankById.get(r.noteId);
        return {
            noteTitle: r.noteTitle,
            fileLineCount: r.fileLineCount,
            mtime: r.mtime,
            fulltextRank: fulltextRank ?? null,
            semanticRank: semanticRank ?? null,
            score: computeRrfScore(fulltextRank, semanticRank),
        };
    });

    merged.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    return merged.slice(0, limit);
}

function toHybridOutput(results) {
    return results.map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
        fulltext_rank: r.fulltextRank,
        semantic_rank: r.semanticRank,
    }));
}

export async function search(db, options = {}) {
    const { query, mode = 'hybrid', limit = DEFAULT_LIMIT } = options;
    validateQuery(query);
    validateLimit(limit);

    if (mode === 'fulltext') {
        return toFulltextOutput(fulltextSearch(db, query, limit), limit);
    }
    if (mode === 'semantic') {
        return toSemanticOutput(await semanticSearch(db, query, limit, options), limit);
    }
    if (mode === 'hybrid') {
        const fulltextResults = fulltextSearch(db, query, limit);
        const semanticResults = await semanticSearch(db, query, limit, options);
        return toHybridOutput(mergeHybrid(fulltextResults, semanticResults, limit));
    }

    throw new Error(`search: unknown mode "${mode}"`);
}

function runSemanticQueryWithChunkDetail(db, vector, fetchCount, embeddingModel, embeddingVersion) {
    return db.prepare(`
        SELECT c.note_id AS note_id, c.char_start AS char_start, c.char_end AS char_end,
               cv.distance AS distance
        FROM chunk_vectors cv
        JOIN chunks c ON c.id = cv.rowid
        WHERE cv.embedding MATCH ? AND k = ${fetchCount}
          AND c.embedding_model = ?
          AND c.embedding_version = ?
        ORDER BY cv.distance
    `).all(vectorToBuffer(vector), embeddingModel, embeddingVersion);
}

function collapseToBestChunkPerNoteWithDetail(rows) {
    const bestByNote = new Map();
    for (const row of rows) {
        if (!bestByNote.has(row.note_id)) {
            bestByNote.set(row.note_id, {
                distance: row.distance,
                charStart: row.char_start,
                charEnd: row.char_end,
            });
        }
    }
    return bestByNote;
}

async function semanticSearchDetail(db, query, limit, { embed, embeddingModel, embeddingVersion }) {
    if (typeof embed !== 'function') {
        throw new Error('search: semantic and hybrid modes require an `embed` function');
    }

    const vector = await embed(query);
    const rawRows = runSemanticQueryWithChunkDetail(
        db, vector, computeOverfetch(limit), embeddingModel, embeddingVersion,
    );
    const bestByNote = collapseToBestChunkPerNoteWithDetail(rawRows);
    const notesById = hydrateNotes(db, [ ...bestByNote.keys() ]);

    const collapsed = [ ...bestByNote.entries() ].map(([ noteId, best ]) => {
        const note = notesById.get(noteId);
        return {
            noteTitle: pathToTitle(note.path),
            fileLineCount: note.file_line_count,
            mtime: note.mtime,
            distance: best.distance,
            charStart: best.charStart,
            charEnd: best.charEnd,
        };
    });

    collapsed.sort((a, b) => a.distance - b.distance || b.mtime - a.mtime);
    return collapsed.map((row, index) => ({ ...row, rank: index + 1 }));
}

function formatRrfFormula(fulltextRank, semanticRank, score) {
    const terms = [];
    if (fulltextRank !== null) {
        terms.push(`1/(${RRF_K}+${fulltextRank})`);
    }
    if (semanticRank !== null) {
        terms.push(`1/(${RRF_K}+${semanticRank})`);
    }
    return `${terms.join(' + ')} = ${score}`;
}

export async function explainSearch(db, options = {}) {
    const { query, mode = 'hybrid', limit = DEFAULT_LIMIT } = options;
    validateQuery(query);
    validateLimit(limit);

    const pipeline = {
        mode, limit, overfetchLimit: computeOverfetch(limit), fulltextExpression: query,
    };

    if (mode === 'fulltext') {
        const rows = fulltextSearch(db, query, limit).slice(0, limit);
        return {
            results: rows.map((r) => ({
                note_title: r.noteTitle, file_line_count: r.fileLineCount,
                bm25_score: r.score, rank: r.rank,
            })),
            pipeline,
        };
    }

    if (mode === 'semantic') {
        const rows = (await semanticSearchDetail(db, query, limit, options)).slice(0, limit);
        return {
            results: rows.map((r) => ({
                note_title: r.noteTitle, file_line_count: r.fileLineCount,
                cosine_distance: r.distance,
                winning_chunk: { char_start: r.charStart, char_end: r.charEnd },
                rank: r.rank,
            })),
            pipeline,
        };
    }

    if (mode === 'hybrid') {
        const fulltextResults = fulltextSearch(db, query, limit);
        const semanticResults = await semanticSearch(db, query, limit, options);
        const merged = mergeHybrid(fulltextResults, semanticResults, limit);
        return {
            results: merged.map((r) => ({
                note_title: r.noteTitle, file_line_count: r.fileLineCount,
                fulltext_rank: r.fulltextRank, semantic_rank: r.semanticRank,
                rrf_score: r.score,
                rrf_formula: formatRrfFormula(r.fulltextRank, r.semanticRank, r.score),
            })),
            pipeline,
        };
    }

    throw new Error(`search: unknown mode "${mode}"`);
}
