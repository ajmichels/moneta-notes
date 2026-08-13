import { search } from '../core/search.js';
import { grep } from '../core/grep.js';
import { tagList, tagNotes } from '../core/tags.js';
import { noteRead, noteWrite, noteEdit, noteAppend, noteRename } from '../core/notes.js';
import { logAudit, runWithLogger } from '../logger.js';
import {
    formatSearchTable, formatGrepTable, formatTagListTable, formatTagNotesTable, formatJson,
} from '../format.js';

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
    const { db, embed, embeddingModel, embeddingVersion } = deps;
    const { query, mode = 'hybrid', limit = 20 } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'search', input, async () => {
        const results = await search(db, { query, mode, limit, embed, embeddingModel, embeddingVersion });
        return formatSearchTable(results, mode);
    });
}

export async function grepTool(deps, input) {
    const { vaultRoot } = deps;
    const { pattern, regex = false, note_title: noteTitle = null } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'grep', input, async () => {
        const results = grep(vaultRoot, pattern, { regex, noteTitle });
        return formatGrepTable(results);
    });
}

export async function tagListTool(deps, input) {
    const { db } = deps;
    return callTool(deps.auditLogger, deps.mcpLogger, 'tag_list', input,
        async () => formatTagListTable(tagList(db)));
}

export async function tagNotesTool(deps, input) {
    const { db } = deps;
    const { tag } = input;
    return callTool(deps.auditLogger, deps.mcpLogger, 'tag_notes', input,
        async () => formatTagNotesTable(tagNotes(db, tag)));
}

export async function noteReadTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, start_line: startLine, end_line: endLine } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_read', input, async () => {
        const result = noteRead(vaultRoot, noteTitle, { startLine, endLine });
        return formatJson(result);
    });
}

export async function noteWriteTool(deps, input) {
    const { vaultRoot } = deps;
    const { note_title: noteTitle, hash, metadata = null, content, force = false } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_write', input, async () => {
        const result = noteWrite(vaultRoot, noteTitle, { hash, metadata, content, force });
        return formatJson(result);
    });
}

export async function noteEditTool(deps, input) {
    const { vaultRoot } = deps;
    const {
        note_title: noteTitle, hash, old_txt: oldTxt, new_txt: newTxt, metadata = null,
    } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_edit', input, async () => {
        const result = noteEdit(vaultRoot, noteTitle, { hash, oldTxt, newTxt, metadata });
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
    const { vaultRoot, db } = deps;
    const { old_title: oldTitle, new_title: newTitle, hash } = input;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_rename', input, async () => {
        // Passes deps.db (mirrors cli/main.js's runRename) so the search index is updated in
        // place immediately — noteRename's write-through db param exists specifically to avoid a
        // rename briefly disappearing from search while waiting on the daemon's fswatch loop.
        const result = noteRename(vaultRoot, oldTitle, newTitle, hash, db ?? null);
        return formatJson(result);
    });
}
