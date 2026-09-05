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
