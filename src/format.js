export function formatJson(data) {
    return `${JSON.stringify(data)}\n`;
}

function formatCell(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

export function formatTable(columns, rows) {
    const header = columns.join('|');
    const lines = rows.map((row) => columns.map((col) => formatCell(row[col])).join('|'));
    return `${[ header, ...lines ].join('\n')}\n`;
}

export function formatSearchTable(results, mode) {
    const columns = mode === 'hybrid'
        ? [ 'note_title', 'file_line_count', 'fulltext_rank', 'semantic_rank' ]
        : [ 'note_title', 'file_line_count' ];
    return formatTable(columns, results);
}

function formatExplainRow(r, rank, mode) {
    if (mode === 'fulltext') {
        return `${rank} | ${r.note_title} | ${r.file_line_count} | bm25=${r.bm25_score}`;
    }
    if (mode === 'semantic') {
        return `${rank} | ${r.note_title} | ${r.file_line_count} | cosine=${r.cosine_distance} `
            + `| chunk[${r.winning_chunk.char_start}:${r.winning_chunk.char_end}]`;
    }
    return `${rank} | ${r.note_title} | ${r.file_line_count} | fulltext_rank=${r.fulltext_rank ?? '-'} `
        + `| semantic_rank=${r.semantic_rank ?? '-'} | rrf=${r.rrf_formula}`;
}

function formatLineMatches(lineMatches, totalMatchCount) {
    const rendered = lineMatches.map((m) => `L${m.line}: ${m.text}`).join('; ');
    const more = totalMatchCount - lineMatches.length;
    return more > 0 ? `${rendered} (+${more} more)` : rendered;
}

export function formatGrepTable(results) {
    const rows = results.map((r) => ({
        note_title: r.noteTitle,
        file_line_count: r.fileLineCount,
        line_matches: formatLineMatches(r.lineMatches, r.totalMatchCount),
    }));
    return formatTable([ 'note_title', 'file_line_count', 'line_matches' ], rows);
}

export function formatTagListTable(results) {
    const rows = results.map((r) => ({ tag: r.tag, notes_with_tag: r.notesWithTag }));
    return formatTable([ 'tag', 'notes_with_tag' ], rows);
}

export function formatTagNotesTable(results) {
    const rows = results.map((r) => ({ note_title: r.noteTitle, file_line_count: r.fileLineCount }));
    return formatTable([ 'note_title', 'file_line_count' ], rows);
}

export function formatStats(stats, { json = false, daemonRunning } = {}) {
    const withDaemon = { ...stats, daemon_running: daemonRunning };
    if (json) {
        return formatJson(withDaemon);
    }
    return `${Object.entries(withDaemon).map(([ key, value ]) => `${key}: ${value}`).join('\n')}\n`;
}

export function formatExplain({ results, pipeline }) {
    const header = `mode=${pipeline.mode} limit=${pipeline.limit} overfetch=${pipeline.overfetchLimit} `
        + `fts5_expression=${JSON.stringify(pipeline.fulltextExpression)}`;
    const lines = results.map((r, index) => formatExplainRow(r, index + 1, pipeline.mode));
    return `${[ header, ...lines ].join('\n')}\n`;
}
