import { getContextLogger } from '../logger.js';
import { stripMdExtension } from './note-fs.js';
import { tagMatchClause } from './tags.js';

// Every frontmatter key except `tags` is projected into `notes.metadata_json` (S014) — tags has its
// own purpose-built, indexed storage (S001/S004) and a second extraction source (inline #hashtags)
// this JSON blob can't represent, so duplicating it here would only ever be half-correct.
function normalizeDates(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        return value.map(normalizeDates);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([ key, v ]) => [ key, normalizeDates(v) ]));
    }
    return value;
}

export function buildMetadataJson(metadata) {
    const rest = { ...(metadata ?? {}) };
    delete rest.tags;
    return JSON.stringify(normalizeDates(rest));
}

// A `json_tree` fullkey like `$."depends_on"[0].project` needs to collapse down to the same
// dot-path shape metadata_query's `key` addresses (`depends_on.project`) — strip the leading `$`,
// every array-index segment, and SQLite's quoting around key names (applied liberally, not just to
// irregular ones — verified empirically).
function normalizeFullkey(fullkey) {
    return fullkey
        .replace(/^\$\.?/, '')
        .replace(/\[\d+\]/g, '')
        .replace(/"/g, '');
}

// Shared with metadata_query's date-literal canonicalization below — a JSON string in this shape is
// treated as a date both for metadata_keys' sampled `type` hint and for range-comparison binding.
const DATE_LIKE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function inferType(sqliteType, atomText) {
    if (sqliteType === 'integer' || sqliteType === 'real') {
        return 'number';
    }
    if (sqliteType === 'true' || sqliteType === 'false') {
        return 'boolean';
    }
    if (sqliteType === 'text' && DATE_LIKE_PATTERN.test(atomText)) {
        return 'date';
    }
    return 'string';
}

// atomText is always a string (see the CAST in metadataKeys' query below) — an integer like a
// large obsidian.nvim note id (e.g. 20240708102843484) exceeds Number.MAX_SAFE_INTEGER, and
// node:sqlite refuses to marshal a SQLite INTEGER that large into a JS number at all (verified: it
// throws "Value is too large to be represented as a JavaScript number" reading json_tree's own
// `atom` column directly). Casting to TEXT in SQL sidesteps that crash; here, only convert back to
// a JS number when the round trip is exact — otherwise the literal digits are a more honest example
// than a silently-rounded number.
function exampleValue(sqliteType, atomText) {
    if (sqliteType === 'true') {
        return true;
    }
    if (sqliteType === 'false') {
        return false;
    }
    if (sqliteType === 'integer') {
        const num = Number(atomText);
        return Number.isSafeInteger(num) ? num : atomText;
    }
    if (sqliteType === 'real') {
        return Number(atomText);
    }
    return atomText;
}

export function metadataKeys(db) {
    const rows = db.prepare(`
        SELECT n.id AS note_id, jt.fullkey AS fullkey, jt.type AS type,
               CAST(jt.atom AS TEXT) AS atom_text
        FROM notes n, json_tree(n.metadata_json) AS jt
        WHERE jt.type NOT IN ('object', 'array')
    `).all();

    const byKey = new Map();
    for (const row of rows) {
        const key = normalizeFullkey(row.fullkey);
        if (!byKey.has(key)) {
            byKey.set(key, { noteIds: new Set() });
        }
        const entry = byKey.get(key);
        entry.noteIds.add(row.note_id);
        if (row.type === 'null') {
            continue;
        }
        // A numeric-leading example (e.g. an obsidian.nvim note id like "20240708102843484") reads
        // misleadingly like a date to an agent skimming metadata_keys output. Prefer the first
        // example whose text doesn't start with a digit; once one is found, stop overriding it. If
        // every value for this key is numeric-leading, fall back to the plain first-seen example.
        const numericLeading = /^[0-9]/.test(row.atom_text);
        if (entry.example === undefined || (entry.exampleNumericLeading && !numericLeading)) {
            entry.type = inferType(row.type, row.atom_text);
            entry.example = exampleValue(row.type, row.atom_text);
            entry.exampleNumericLeading = numericLeading;
        }
    }

    return Array.from(byKey.entries())
        .map(([ key, entry ]) => ({
            key,
            type: entry.type ?? 'string',
            example: entry.example ?? null,
            notesWithKey: entry.noteIds.size,
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

function validationError(message) {
    getContextLogger().warn('metadata_query: invalid filter', { message });
    return new Error(`metadata_query: ${message}`);
}

// At most one dot: a bare top-level key (`status`), or exactly one level of nesting
// (`depends_on.project`). Anything nested deeper is simply not addressable here (S014) — still
// fully visible via note_read's raw metadata output.
function splitKey(key) {
    const parts = key.split('.');
    if (parts.length > 2) {
        throw validationError(`key "${key}" has more than one dot — at most one level of nesting is addressable`);
    }
    return { container: parts[0], leaf: parts.length === 2 ? parts[1] : null };
}

// A simple identifier binds as bare `.name`; anything else (spaces, hyphens, ...) falls back to
// SQLite's quoted bracket-ish path form, `."name"` — verified against this project's actual bundled
// SQLite that it quotes liberally anyway, so quoting unconditionally here would also be correct,
// but this keeps the common-case path readable.
function jsonPathSegment(name) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return `.${name}`;
    }
    return `."${name.replace(/"/g, '""')}"`;
}

function jsonPath(name) {
    return `$${jsonPathSegment(name)}`;
}

// A date-shaped literal ("2026-01-01") is a string-prefix of the canonical stored value
// ("2026-01-01T00:00:00.000Z"), so a plain `>` would wrongly count an exact-midnight match as
// "after itself" — canonicalize to the same ISO string buildMetadataJson stores before binding.
// Only gt/gte/lt/lte compare at a precision where this matters (S014 "Date literals").
function canonicalizeDateLiteral(value) {
    if (typeof value === 'string' && DATE_LIKE_PATTERN.test(value)) {
        return new Date(value).toISOString();
    }
    return value;
}

// node:sqlite refuses to bind a raw JS boolean at all — a stored JSON `true`/`false` also comes
// back out of json_each/json_extract as native SQLite integer 1/0 (verified), so binding a boolean
// filter value the same way keeps both sides of the comparison the same storage class.
function toBindable(value) {
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    return value;
}

const RANGE_OPS = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

function buildJsonCondition({ container, leaf }, op, value) {
    const params = [ jsonPath(container), jsonPath(container), jsonPath(container) ];
    const valueExpr = leaf !== null ? 'json_extract(e.value, ?)' : 'e.value';
    if (leaf !== null) {
        params.push(jsonPath(leaf));
    }

    let predicate;
    if (op === 'exists') {
        predicate = `${valueExpr} IS NOT NULL`;
    } else if (op === 'eq') {
        predicate = `${valueExpr} = ?`;
        params.push(toBindable(value));
    } else if (op in RANGE_OPS) {
        predicate = `${valueExpr} ${RANGE_OPS[op]} ?`;
        params.push(toBindable(canonicalizeDateLiteral(value)));
    } else if (op === 'in') {
        predicate = `${valueExpr} IN (${value.map(() => '?').join(', ')})`;
        params.push(...value.map(toBindable));
    } else {
        throw validationError(`unknown op "${op}"`);
    }

    const sql = `EXISTS (
        SELECT 1 FROM json_each(
            CASE WHEN json_type(n.metadata_json, ?) = 'array'
                 THEN json_extract(n.metadata_json, ?)
                 ELSE json_array(json_extract(n.metadata_json, ?))
            END
        ) AS e
        WHERE ${predicate}
    )`;
    return { sql, params };
}

const TAG_VALID_OPS = new Set([ 'eq', 'in', 'exists' ]);

// Intercepted before the JSON-path machinery runs at all — reuses tagMatchClause (core/tags.js),
// the exact same predicate tagNotes (S004) uses, so the two never drift (S014 "Tag interception").
function buildTagCondition(leaf, op, value) {
    if (leaf !== null) {
        throw validationError('key "tags" does not support dot-path nesting — tags is a flat vocabulary');
    }
    if (!TAG_VALID_OPS.has(op)) {
        throw validationError(`op "${op}" is not valid for key "tags" (tags aren't ordered)`);
    }

    if (op === 'exists') {
        return {
            sql: 'EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)',
            params: [],
        };
    }

    const tagNames = op === 'in' ? value : [ value ];
    const matches = tagNames.map((name) => tagMatchClause(name));
    const clauses = matches.map((m) => m.clause);
    const params = matches.flatMap((m) => m.params);
    const sql = `EXISTS (
        SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = n.id AND (${clauses.join(' OR ')})
    )`;
    return { sql, params };
}

function buildCondition(filter) {
    const { key, op, value, negate = false } = filter;
    const { container, leaf } = splitKey(key);

    const { sql, params } = container === 'tags'
        ? buildTagCondition(leaf, op, value)
        : buildJsonCondition({ container, leaf }, op, value);

    return { sql: negate ? `NOT ${sql}` : sql, params };
}

export function metadataQuery(db, { filters, match = 'all' } = {}) {
    if (!Array.isArray(filters) || filters.length === 0) {
        throw validationError('filters must be a non-empty array');
    }
    if (match !== 'all' && match !== 'any') {
        throw validationError(`match must be "all" or "any", got "${match}"`);
    }

    const combinator = match === 'any' ? ' OR ' : ' AND ';
    const conditions = filters.map(buildCondition);
    const whereClause = conditions.map((c) => `(${c.sql})`).join(combinator);
    const params = conditions.flatMap((c) => c.params);

    const rows = db.prepare(`
        SELECT DISTINCT n.path AS path, n.line_count AS fileLineCount
        FROM notes n
        WHERE ${whereClause}
        ORDER BY n.path
    `).all(...params);

    return rows.map((row) => ({
        noteTitle: stripMdExtension(row.path),
        fileLineCount: row.fileLineCount,
    }));
}
