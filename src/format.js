export function formatJson(data) {
    return JSON.stringify(data);
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
    return [ header, ...lines ].join('\n');
}
