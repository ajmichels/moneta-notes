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

export function formatSearchTable(results, mode, { align = false } = {}) {
    const columns = mode === 'hybrid'
        ? [ 'note_title', 'file_line_count', 'fulltext_rank', 'semantic_rank' ]
        : [ 'note_title', 'file_line_count' ];
    return formatTable(columns, results, { align });
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
        return {
            rank, note_title: r.note_title, file_line_count: r.file_line_count,
            cosine: r.cosine_distance, chunk: `[${r.winning_chunk.char_start}:${r.winning_chunk.char_end}]`,
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

export function formatExplain({ results, pipeline }) {
    const header = `mode=${pipeline.mode} limit=${pipeline.limit} overfetch=${pipeline.overfetchLimit} `
        + `fts5_expression=${JSON.stringify(pipeline.fulltextExpression)}`;
    const columns = EXPLAIN_COLUMNS[pipeline.mode];
    const rows = results.map((r, index) => formatExplainRow(r, index + 1, pipeline.mode));
    return `${header}\n${formatTable(columns, rows, { align: true })}`;
}
