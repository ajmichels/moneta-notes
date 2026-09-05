export function formatJson(data) {
    return `${JSON.stringify(data)}\n`;
}

export function formatJsonPretty(data) {
    return `${JSON.stringify(data, null, 2)}\n\n`;
}

function formatCell(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

// align=true (CLI-only, see callers) pads each column to its widest cell so columns stay visually
// lined up in a terminal; MCP callers leave it off since an LLM reader gets no benefit from the
// padding and it only costs tokens.
export function formatTable(columns, rows, { align = false } = {}) {
    if (!align) {
        const header = columns.join('|');
        const lines = rows.map((row) => columns.map((col) => formatCell(row[col])).join('|'));
        return `${[ header, ...lines ].join('\n')}\n`;
    }

    const cellRows = rows.map((row) => columns.map((col) => formatCell(row[col])));
    const widths = columns.map((col, i) => Math.max(col.length, ...cellRows.map((cells) => cells[i].length)));
    const renderRow = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ').trimEnd();
    const separator = renderRow(widths.map((w) => '-'.repeat(w)));
    const lines = cellRows.map(renderRow);
    return `${[ renderRow(columns), separator, ...lines ].join('\n')}\n`;
}

const SEARCH_COLUMNS = {
    fulltext: [ 'note_title', 'file_line_count', 'bm25_score' ],
    semantic: [ 'note_title', 'file_line_count', 'chunk_line_start', 'chunk_line_end', 'cosine_distance' ],
    hybrid: [
        'note_title', 'file_line_count', 'fulltext_rank', 'semantic_rank',
        'chunk_line_start', 'chunk_line_end',
    ],
};

export function formatSearchTable(results, mode, { align = false } = {}) {
    return formatTable(SEARCH_COLUMNS[mode], results, { align });
}

const EXPLAIN_COLUMNS = {
    fulltext: [ 'rank', 'note_title', 'file_line_count', 'bm25' ],
    semantic: [ 'rank', 'note_title', 'file_line_count', 'cosine', 'chunk' ],
    hybrid: [ 'rank', 'note_title', 'file_line_count', 'fulltext_rank', 'semantic_rank', 'rrf' ],
};

function formatExplainRow(r, rank, mode) {
    if (mode === 'fulltext') {
        return { rank, note_title: r.note_title, file_line_count: r.file_line_count, bm25: r.bm25_score };
    }
    if (mode === 'semantic') {
        const { char_start: charStart, char_end: charEnd, line_start: lineStart, line_end: lineEnd } = r.winning_chunk;
        return {
            rank, note_title: r.note_title, file_line_count: r.file_line_count,
            cosine: r.cosine_distance, chunk: `L${lineStart}-${lineEnd} [${charStart}:${charEnd}]`,
        };
    }
    return {
        rank, note_title: r.note_title, file_line_count: r.file_line_count,
        fulltext_rank: r.fulltext_rank ?? '-', semantic_rank: r.semantic_rank ?? '-', rrf: r.rrf_formula,
    };
}

function formatLineMatches(lineMatches, totalMatchCount, includeText) {
    const rendered = includeText
        ? lineMatches.map((m) => `L${m.line}: ${m.text}`).join('; ')
        : lineMatches.map((m) => `L${m.line}`).join(', ');
    const more = totalMatchCount - lineMatches.length;
    return more > 0 ? `${rendered} (+${more} more)` : rendered;
}

export function formatGrepTable(results, { includeText = false, align = false } = {}) {
    const rows = results.map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
        line_matches: formatLineMatches(r.lineMatches, r.totalMatchCount, includeText),
    }));
    return formatTable([ 'note_title', 'file_line_count', 'line_matches' ], rows, { align });
}

export function formatTagListTable(results, { align = false } = {}) {
    const rows = results.map((r) => ({ tag: r.tag, notes_with_tag: r.notesWithTag }));
    return formatTable([ 'tag', 'notes_with_tag' ], rows, { align });
}

export function formatTagNotesTable(results, { align = false } = {}) {
    const rows = results.map((r) => ({ note_title: r.noteTitle, file_line_count: r.fileLineCount }));
    return formatTable([ 'note_title', 'file_line_count' ], rows, { align });
}

// metadata_query's output is the same { noteTitle, fileLineCount } shape tagNotes returns (S014) —
// no separate formatMetadataQueryTable, formatTagNotesTable already fits it exactly.
export function formatMetadataKeysTable(results, { align = false } = {}) {
    const rows = results.map((r) => ({
        key: r.key, type: r.type, example: r.example, notes_with_key: r.notesWithKey,
    }));
    return formatTable([ 'key', 'type', 'example', 'notes_with_key' ], rows, { align });
}

export function formatLinksTable({ backlinks, links_out: linksOut }, { align = false } = {}) {
    const rows = [
        ...backlinks.map((noteTitle) => ({ direction: 'backlink', note_title: noteTitle })),
        ...linksOut.map((noteTitle) => ({ direction: 'link_out', note_title: noteTitle })),
    ];
    return formatTable([ 'direction', 'note_title' ], rows, { align });
}

export function formatBrokenLinksTable(results, { align = false } = {}) {
    const rows = results.map((r) => ({ note_title: r.sourceTitle, broken_target: r.targetTitle }));
    return formatTable([ 'note_title', 'broken_target' ], rows, { align });
}

export function formatStats(stats, { json = false, daemonRunning } = {}) {
    const withDaemon = { ...stats, daemon_running: daemonRunning };
    if (json) {
        return formatJson(withDaemon);
    }
    return `${Object.entries(withDaemon).map(([ key, value ]) => `${key}: ${value}`).join('\n')}\n`;
}

function formatLineSpan(span) {
    return `L${span.line_start}-${span.line_end}`;
}

export function formatCompareResult(result, { aggregate = 'centroid', json = false } = {}) {
    if (aggregate === 'all-pairs' || json) {
        return formatJson(result);
    }
    const lines = [ `similarity: ${result.similarity}` ];
    if (result.chunk_a) {
        lines.push(`chunk_a: ${formatLineSpan(result.chunk_a)}`);
        lines.push(`chunk_b: ${formatLineSpan(result.chunk_b)}`);
    }
    return `${lines.join('\n')}\n`;
}

export function formatNearestTable(results, { against = 'note', score = false } = {}) {
    const columns = against === 'chunk'
        ? [ 'rank', 'note_title', 'chunk_line_start', 'chunk_line_end' ]
        : [ 'rank', 'note_title' ];
    return formatTable(score ? [ ...columns, 'similarity' ] : columns, results, { align: true });
}

export function formatClusterTable(clusters, { align = true } = {}) {
    const rows = clusters.map((c) => ({
        cluster_id: c.cluster_id, size: c.size, example_titles: c.example_titles.join(', '),
    }));
    return formatTable([ 'cluster_id', 'size', 'example_titles' ], rows, { align });
}

function csvCell(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const cell = String(value);
    return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

// A bare header row + one data row per point, nothing else — the point is a clean stdin stream
// for a plotting tool (`uplot`, gnuplot), not a table for a human to read directly (S013).
//
// Coordinate-only by default (x,y[,z], `z` present only at --dims=3): a scatter tool that reads
// plot columns positionally has no way to *ignore* extra columns, not just misread their
// position — `uplot scatter` in particular treats column 1 as x and plots every remaining column
// as its own additional y-series overlaid on the same axes, so an id/title/label column tacked on
// (in any position) doesn't just get skipped, it renders as bogus extra series cluttering the
// plot. `--metadata` (CLI-level opt-in, see cli/vectors.js) appends id,title[,chunk_line_start,
// chunk_line_end at --level=chunk],label after the coordinates for callers who want a CSV to
// import into something that *does* handle extra columns (a spreadsheet, pandas, a custom script).
export function formatReduceCsv(points, { level = 'note', dims = 2, metadata = false } = {}) {
    const coordColumns = dims === 3 ? [ 'x', 'y', 'z' ] : [ 'x', 'y' ];
    const metaColumns = level === 'chunk'
        ? [ 'id', 'title', 'chunk_line_start', 'chunk_line_end', 'label' ]
        : [ 'id', 'title', 'label' ];
    const columns = metadata ? [ ...coordColumns, ...metaColumns ] : coordColumns;
    const rows = [ columns, ...points.map((p) => columns.map((c) => csvCell(p[c]))) ];
    return `${rows.map((row) => row.join(',')).join('\n')}\n`;
}

export function formatTagFitTable(rows, { align = true } = {}) {
    return formatTable([ 'tag', 'note_title', 'similarity_to_centroid' ], rows, { align });
}

export function formatTagRedundancyTable(rows, { align = true } = {}) {
    return formatTable([ 'tag_a', 'tag_b', 'centroid_similarity' ], rows, { align });
}

export function formatOutliersTable(rows, { mode = 'isolated', align = true } = {}) {
    const columns = mode === 'bridge'
        ? [ 'note_title', 'cluster_a', 'cluster_b', 'bridge_score' ]
        : [ 'note_title', 'nearest_neighbor_similarity' ];
    return formatTable(columns, rows, { align });
}

const CALIBRATE_PERCENTILES = [ 10, 25, 50, 75, 90 ];

function percentile(sortedValues, p) {
    if (sortedValues.length === 0) {
        return null;
    }
    const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
    return sortedValues[index];
}

function summarizeCalibratePopulation(name, rows) {
    const sorted = rows.map((r) => r.similarity).sort((a, b) => a - b);
    const row = { population: name, count: rows.length };
    for (const p of CALIBRATE_PERCENTILES) {
        row[`p${p}`] = percentile(sorted, p);
    }
    return row;
}

export function formatCalibrateTable({ linked, unlinked }, { align = true } = {}) {
    const rows = [
        summarizeCalibratePopulation('linked', linked),
        summarizeCalibratePopulation('unlinked', unlinked),
    ];
    const columns = [ 'population', 'count', ...CALIBRATE_PERCENTILES.map((p) => `p${p}`) ];
    return formatTable(columns, rows, { align });
}

export function formatExplain({ results, pipeline }) {
    const header = `mode=${pipeline.mode} limit=${pipeline.limit} overfetch=${pipeline.overfetchLimit} `
        + `fts5_expression=${JSON.stringify(pipeline.fulltextExpression)}`;
    const columns = EXPLAIN_COLUMNS[pipeline.mode];
    const rows = results.map((r, index) => formatExplainRow(r, index + 1, pipeline.mode));
    return `${header}\n${formatTable(columns, rows, { align: true })}`;
}
