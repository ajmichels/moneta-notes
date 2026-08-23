import { kmeans } from 'ml-kmeans';
import { agnes } from 'ml-hclust';
import { DBSCAN } from 'density-clustering';
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

function requireNoteVector(db, noteId, embeddingModel, embeddingVersion) {
    const vector = getNoteVector(db, noteId, { embeddingModel, embeddingVersion });
    if (vector === null) {
        throw new Error(`vectors: note ${noteId} has no chunks to compare`);
    }
    return vector;
}

function requireChunks(chunks, noteId) {
    if (chunks.length === 0) {
        throw new Error(`vectors: note ${noteId} has no chunks to compare`);
    }
    return chunks;
}

function requireChunkVector(vectors, chunkId) {
    if (!vectors.has(chunkId)) {
        throw new Error(`vectors: no chunk found with id ${chunkId}`);
    }
    return vectors.get(chunkId);
}

function toChunkRef(chunk) {
    return { id: chunk.chunkId, line_start: chunk.lineStart, line_end: chunk.lineEnd };
}

function toChunkLineSpan(chunk) {
    return { line_start: chunk.lineStart, line_end: chunk.lineEnd };
}

function compareChunks(db, chunkIdA, chunkIdB) {
    const vectors = getChunkVectors(db, [ chunkIdA, chunkIdB ]);
    const a = requireChunkVector(vectors, chunkIdA);
    const b = requireChunkVector(vectors, chunkIdB);
    return { similarity: cosineSimilarity(a, b) };
}

function compareCentroids(db, noteIdA, noteIdB, embeddingModel, embeddingVersion) {
    const a = requireNoteVector(db, noteIdA, embeddingModel, embeddingVersion);
    const b = requireNoteVector(db, noteIdB, embeddingModel, embeddingVersion);
    return { similarity: cosineSimilarity(a, b) };
}

// Exhaustive over chunks_a x chunks_b — acceptable at this vault's scale (S013/S001: thousands of
// notes, not millions; a single note's chunk count stays small).
function bestChunkPair(chunksA, chunksB) {
    let best = null;
    for (const a of chunksA) {
        for (const b of chunksB) {
            const similarity = cosineSimilarity(a.vector, b.vector);
            if (best === null || similarity > best.similarity) {
                best = { similarity, a, b };
            }
        }
    }
    return best;
}

function compareBestChunk(db, noteIdA, noteIdB, embeddingModel, embeddingVersion) {
    const chunksA = requireChunks(
        getAllChunkVectors(db, { noteIds: [ noteIdA ], embeddingModel, embeddingVersion }), noteIdA,
    );
    const chunksB = requireChunks(
        getAllChunkVectors(db, { noteIds: [ noteIdB ], embeddingModel, embeddingVersion }), noteIdB,
    );
    const best = bestChunkPair(chunksA, chunksB);
    return { similarity: best.similarity, chunk_a: toChunkLineSpan(best.a), chunk_b: toChunkLineSpan(best.b) };
}

function compareAllPairs(db, noteIdA, noteIdB, embeddingModel, embeddingVersion) {
    const chunksA = requireChunks(
        getAllChunkVectors(db, { noteIds: [ noteIdA ], embeddingModel, embeddingVersion }), noteIdA,
    );
    const chunksB = requireChunks(
        getAllChunkVectors(db, { noteIds: [ noteIdB ], embeddingModel, embeddingVersion }), noteIdB,
    );
    const matrix = chunksA.map((a) => chunksB.map((b) => cosineSimilarity(a.vector, b.vector)));
    return { chunks_a: chunksA.map(toChunkRef), chunks_b: chunksB.map(toChunkRef), matrix };
}

const NOTE_AGGREGATORS = {
    centroid: compareCentroids,
    'best-chunk': compareBestChunk,
    'all-pairs': compareAllPairs,
};

// `a`/`b` are note titles at `level: 'note'` (resolved the same way `mnotes read`'s title does —
// exact match, then unique-basename fallback) or raw chunk ids at `level: 'chunk'`. S013's
// primitive comparison — everything else in this module that compares "two specific things"
// reduces to this.
export function compareVectors(db, a, b, options = {}) {
    const { level = 'note', aggregate = 'centroid', embeddingModel, embeddingVersion } = options;

    if (level === 'chunk') {
        return compareChunks(db, Number(a), Number(b));
    }

    const aggregator = NOTE_AGGREGATORS[aggregate];
    if (!aggregator) {
        throw new Error(`vectors: unknown aggregate "${aggregate}"`);
    }
    return aggregator(db, resolveNoteId(db, a), resolveNoteId(db, b), embeddingModel, embeddingVersion);
}

function chunkParentNoteId(db, chunkId) {
    const row = db.prepare('SELECT note_id FROM chunks WHERE id = ?').get(chunkId);
    if (!row) {
        throw new Error(`vectors: no chunk found with id ${chunkId}`);
    }
    return row.note_id;
}

// Query-side vectors for `nearestNeighbors`. `centroid` collapses to the note's single centroid;
// `best-chunk` keeps every one of the note's raw chunk vectors so the scorer below can take the
// max similarity across all of them, per-candidate — the k-NN analogue of `compare`'s "best pair
// wins" semantics, generalized from a single comparison to a corpus scan.
function resolveQueryVectors(db, query, level, aggregate, embeddingOptions) {
    if (level === 'chunk') {
        const chunkId = Number(query);
        const vectors = getChunkVectors(db, [ chunkId ]);
        return {
            vectors: [ requireChunkVector(vectors, chunkId) ],
            noteId: chunkParentNoteId(db, chunkId),
            chunkId,
        };
    }

    const noteId = resolveNoteId(db, query);
    if (aggregate === 'best-chunk') {
        const chunks = requireChunks(
            getAllChunkVectors(db, { noteIds: [ noteId ], ...embeddingOptions }), noteId,
        );
        return { vectors: chunks.map((c) => c.vector), noteId, chunkId: null };
    }
    return {
        vectors: [ requireNoteVector(db, noteId, embeddingOptions.embeddingModel, embeddingOptions.embeddingVersion) ],
        noteId,
        chunkId: null,
    };
}

// Excludes the query's own note (every mode) or, when both query and corpus are at chunk level,
// just the exact queried chunk rather than its whole sibling note — see S013's "nearest" section.
function isSelfMatch(entry, against, queryLevel, noteId, chunkId) {
    if (against === 'chunk' && queryLevel === 'chunk') {
        return entry.chunkId === chunkId;
    }
    return entry.noteId === noteId;
}

function toNeighborResult(db, entry, against, similarity, rank) {
    const base = { rank, similarity, note_title: titleForNoteId(db, entry.noteId) };
    if (against === 'chunk') {
        return { ...base, chunk_line_start: entry.lineStart, chunk_line_end: entry.lineEnd };
    }
    return base;
}

// Nearest-neighbor lookup using an existing note's/chunk's own stored embedding as the query
// vector — never re-embeds text (that's `search --mode semantic`'s job, not this one).
export function nearestNeighbors(db, query, options = {}) {
    const {
        level = 'note', against = level, aggregate = 'centroid', k = 10,
        embeddingModel, embeddingVersion,
    } = options;

    const embeddingOptions = { embeddingModel, embeddingVersion };
    const { vectors: queryVectors, noteId, chunkId } =
        resolveQueryVectors(db, query, level, aggregate, embeddingOptions);
    const score = (candidate) => Math.max(...queryVectors.map((qv) => cosineSimilarity(qv, candidate)));

    const corpus = against === 'chunk'
        ? getAllChunkVectors(db, { embeddingModel, embeddingVersion })
        : getAllNoteVectors(db, { embeddingModel, embeddingVersion });

    const scored = corpus
        .filter((entry) => !isSelfMatch(entry, against, level, noteId, chunkId))
        .map((entry) => ({ entry, similarity: score(entry.vector) }));

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k).map(({ entry, similarity }, index) => (
        toNeighborResult(db, entry, against, similarity, index + 1)
    ));
}

function scopedPoints(db, level, options) {
    const { tag, folder, embeddingModel, embeddingVersion } = options;
    const noteIds = resolveScopeNoteIds(db, { tag, folder });
    const points = level === 'chunk'
        ? getAllChunkVectors(db, { noteIds, embeddingModel, embeddingVersion })
        : getAllNoteVectors(db, { noteIds, embeddingModel, embeddingVersion });
    if (points.length === 0) {
        throw new Error('vectors: no vectors in scope to cluster');
    }
    return points;
}

// A fixed seed makes repeated identical `cluster --algo kmeans` invocations reproducible — this
// module has no other stated need for true randomness (unlike `calibrate`'s baseline sample,
// where reproducibility is explicitly not a goal per S013).
const KMEANS_SEED = 20260823;

function runKmeansClustering(points, k) {
    if (!Number.isInteger(k) || k < 1) {
        throw new Error('vectors: --k is required for --algo kmeans');
    }
    if (points.length < k) {
        throw new Error(`vectors: --k=${k} exceeds the number of points in scope (${points.length})`);
    }
    const data = points.map((p) => Array.from(p.vector));
    return kmeans(data, k, { seed: KMEANS_SEED }).clusters;
}

function assignmentsFromGroups(pointCount, groups) {
    const assignments = new Array(pointCount).fill(-1);
    groups.forEach((cluster, clusterId) => {
        for (const index of cluster.indices()) {
            assignments[index] = clusterId;
        }
    });
    return assignments;
}

function runHierarchicalClustering(points, k, cutHeight) {
    if ((k === undefined) === (cutHeight === undefined)) {
        throw new Error('vectors: --algo hierarchical requires exactly one of --k or --cut-height');
    }
    if (k !== undefined && (!Number.isInteger(k) || points.length < k)) {
        throw new Error(`vectors: --k=${k} exceeds the number of points in scope (${points.length})`);
    }

    const data = points.map((p) => Array.from(p.vector));
    const tree = agnes(data, { distanceFunction: cosineDistance });
    const groups = k !== undefined ? tree.group(k).children : tree.cut(cutHeight);
    return assignmentsFromGroups(points.length, groups);
}

function runDbscanClustering(points, epsilon, minPoints) {
    if (epsilon === undefined || minPoints === undefined) {
        throw new Error('vectors: --algo dbscan requires both --epsilon and --min-points');
    }
    const data = points.map((p) => Array.from(p.vector));
    const clusters = new DBSCAN().run(data, epsilon, minPoints, cosineDistance);
    const assignments = new Array(points.length).fill(-1);
    clusters.forEach((cluster, clusterId) => {
        for (const index of cluster) {
            assignments[index] = clusterId;
        }
    });
    return assignments;
}

function assignClusters(algo, points, options) {
    if (algo === 'kmeans') {
        return runKmeansClustering(points, options.k);
    }
    if (algo === 'hierarchical') {
        return runHierarchicalClustering(points, options.k, options.cutHeight);
    }
    if (algo === 'dbscan') {
        return runDbscanClustering(points, options.epsilon, options.minPoints);
    }
    throw new Error(`vectors: unknown --algo "${algo}"`);
}

function pointRef(db, level, point) {
    return level === 'chunk'
        ? { chunk_id: point.chunkId, note_title: titleForNoteId(db, point.noteId) }
        : { note_title: titleForNoteId(db, point.noteId) };
}

function buildMembership(db, level, points, assignments) {
    return points.map((point, index) => ({ cluster_id: assignments[index], ...pointRef(db, level, point) }));
}

function groupByCluster(points, assignments) {
    const byCluster = new Map();
    points.forEach((point, index) => {
        const clusterId = assignments[index];
        if (!byCluster.has(clusterId)) {
            byCluster.set(clusterId, []);
        }
        byCluster.get(clusterId).push(point);
    });
    return byCluster;
}

const EXAMPLE_TITLES_PER_CLUSTER = 3;

function exampleTitlesForCluster(db, level, members) {
    const centroid = centroidOf(members.map((m) => m.vector));
    const ranked = [ ...members ].sort(
        (a, b) => cosineSimilarity(centroid, b.vector) - cosineSimilarity(centroid, a.vector),
    );
    return ranked.slice(0, EXAMPLE_TITLES_PER_CLUSTER).map((m) => pointRef(db, level, m).note_title);
}

function buildClusterSummary(db, level, points, assignments) {
    const byCluster = groupByCluster(points, assignments);
    const summary = [ ...byCluster.entries() ].map(([ clusterId, members ]) => ({
        cluster_id: clusterId,
        size: members.length,
        example_titles: exampleTitlesForCluster(db, level, members),
    }));
    summary.sort((a, b) => a.cluster_id - b.cluster_id);
    return summary;
}

// Whole-vault (or --tag/--folder-scoped) grouping. Note-level always uses centroids (S013 —
// cluster/reduce/outliers never accept --aggregate). Runs on full-dimensional vectors regardless
// of any `reduce` output for the same scope.
export function clusterVectors(db, options = {}) {
    const { level = 'note', algo } = options;
    const points = scopedPoints(db, level, options);
    const assignments = assignClusters(algo, points, options);

    return {
        membership: buildMembership(db, level, points, assignments),
        clusters: buildClusterSummary(db, level, points, assignments),
    };
}
