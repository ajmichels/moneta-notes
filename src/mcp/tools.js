import { search } from '../core/search.js';
import { grep } from '../core/grep.js';
import { tagList, tagNotes } from '../core/tags.js';
import { noteRead, noteWrite, noteEdit, noteAppend, noteRename } from '../core/notes.js';
import { openDb } from '../core/db.js';
import { logAudit, runWithLogger } from '../logger.js';
import { resolveConfig } from '../config.js';
import {
    formatSearchTable, formatGrepTable, formatTagListTable, formatTagNotesTable, formatJson,
} from '../format.js';

// Opens a fresh connection per call rather than reusing one held for the life of the process — a
// long-lived MCP server process was observed to stop seeing writes committed by the indexer daemon
// after running for a while (root cause unconfirmed, but reproducing per-call sidesteps the whole
// class of bug and matches the CLI's already-reliable one-connection-per-invocation behavior).
async function withDb(dbPath, fn) {
    const { db } = openDb(dbPath);
    try {
        return await fn(db);
    } finally {
        db.close();
    }
}

export async function callTool(auditLogger, mcpLogger, toolName, input, fn) {
    const noteTitle = input.note_title ?? input.old_title ?? null;
    let text;

    try {
        text = await runWithLogger(mcpLogger, fn);
    } catch (err) {
        logAudit(auditLogger, {
            tool: toolName,
            noteTitle,
            source: 'mcp',
            reason: input.reason,
            outcome: 'error',
            errorMessage: err.message,
        });
        return { content: [ { type: 'text', text: err.message } ], isError: true };
    }

    logAudit(auditLogger, {
        tool: toolName,
        noteTitle,
        source: 'mcp',
        reason: input.reason,
        outcome: 'success',
        errorMessage: null,
    });
    return { content: [ { type: 'text', text } ] };
}

export async function searchTool(deps, input) {
    const { dbPath, embed, embeddingModel, embeddingVersion } = deps;
    const { search: searchConfig } = resolveConfig(deps);
    const { query, mode = 'hybrid', limit = searchConfig.limit_default } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'search', input, async () => {
        const results = await withDb(dbPath, (db) => (
            search(db, {
                query, mode, limit, embed, embeddingModel, embeddingVersion,
                limitDefault: searchConfig.limit_default,
                limitMax: searchConfig.limit_max,
                overfetchMultiplier: searchConfig.overfetch_multiplier,
                overfetchCap: searchConfig.overfetch_cap,
                rrfK: searchConfig.rrf_k,
            })
        ));
        return formatSearchTable(results, mode);
    });
}

export async function grepTool(deps, input) {
    const { vaultRoot, dbPath } = deps;
    const { grep: grepConfig } = resolveConfig(deps);
    const { pattern, regex = false, note_title: noteTitle = null } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'grep', input, async () => {
        const runGrep = (db) => grep(vaultRoot, pattern, {
            regex, noteTitle, lineMatchCap: grepConfig.line_match_cap, db,
        });
        const results = dbPath ? await withDb(dbPath, runGrep) : runGrep(null);
        return formatGrepTable(results);
    });
}

export async function tagListTool(deps, input) {
    const { dbPath } = deps;
    return callTool(deps.auditLogger, deps.mcpLogger, 'tag_list', input,
        async () => formatTagListTable(await withDb(dbPath, (db) => tagList(db))));
}

export async function tagNotesTool(deps, input) {
    const { dbPath } = deps;
    const { tag } = input;
    return callTool(deps.auditLogger, deps.mcpLogger, 'tag_notes', input,
        async () => formatTagNotesTable(await withDb(dbPath, (db) => tagNotes(db, tag))));
}

export async function noteReadTool(deps, input) {
    const { vaultRoot, dbPath } = deps;
    const { note_title: noteTitle, start_line: startLine, end_line: endLine } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_read', input, async () => {
        const result = dbPath
            ? await withDb(dbPath, (db) => noteRead(vaultRoot, noteTitle, { startLine, endLine, db }))
            : noteRead(vaultRoot, noteTitle, { startLine, endLine });
        return formatJson(result);
    });
}

export async function noteWriteTool(deps, input) {
    const { vaultRoot } = deps;
    const { notes: notesConfig } = resolveConfig(deps);
    const { note_title: noteTitle, hash, metadata = null, content, force = false } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_write', input, async () => {
        const result = noteWrite(vaultRoot, noteTitle, {
            hash, metadata, content, force, sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        return formatJson(result);
    });
}

export async function noteEditTool(deps, input) {
    const { vaultRoot } = deps;
    const { notes: notesConfig } = resolveConfig(deps);
    const {
        note_title: noteTitle, hash, old_txt: oldTxt, new_txt: newTxt, metadata = null,
    } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_edit', input, async () => {
        const result = noteEdit(vaultRoot, noteTitle, {
            hash, oldTxt, newTxt, metadata, sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        return formatJson(result);
    });
}

export async function noteAppendTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, hash, content } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_append', input, async () => {
        const result = noteAppend(vaultRoot, noteTitle, hash, content);
        return formatJson(result);
    });
}

export async function noteRenameTool(deps, input) {
    const { vaultRoot, dbPath } = deps;
    const { old_title: oldTitle, new_title: newTitle, hash } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_rename', input, async () => {
        // Passes a freshly-opened db (mirrors cli/main.js's runRename) so the search index is
        // updated in place immediately — noteRename's write-through db param exists specifically
        // to avoid a rename briefly disappearing from search while waiting on the daemon's
        // fswatch loop.
        const result = dbPath
            ? await withDb(dbPath, (db) => noteRename(vaultRoot, oldTitle, newTitle, hash, db))
            : noteRename(vaultRoot, oldTitle, newTitle, hash, null);
        return formatJson(result);
    });
}
