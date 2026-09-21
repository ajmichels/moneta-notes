import { search } from '../core/search.js';
import { grep } from '../core/grep.js';
import { tagList, tagNotes } from '../core/tags.js';
import { metadataKeys, metadataQuery } from '../core/metadata.js';
import { noteRead, noteWrite, noteEdit, noteAppend, noteRename } from '../core/notes.js';
import { readAttachment, writeAttachment } from '../core/attachments.js';
import { openDb } from '../core/db.js';
import { logAudit, runWithLogger } from '../logger.js';
import { resolveConfig, resolveVault, resolveVaultsForQuery, listVaults } from '../config.js';
import {
    formatSearchTable, formatGrepTable, formatTagListTable, formatTagNotesTable,
    formatMetadataKeysTable, formatJson, formatVaultsTable,
} from '../format.js';

// A test double that already knows exactly which vault it wants (deps.vaultRoot and/or
// deps.dbPath set directly, the pre-existing convention across this file's tests) bypasses
// config-driven resolution entirely — real server usage never sets either (server.js stopped
// resolving a single vaultRoot/dbPath up front), so it always resolves through deps.config plus
// whatever `vault` argument the tool call carried.
function hasDirectVaultDeps(deps) {
    return deps.vaultRoot !== undefined || deps.dbPath !== undefined;
}

function resolveToolVault(deps, input) {
    if (hasDirectVaultDeps(deps)) {
        return { name: null, path: deps.vaultRoot, dbPath: deps.dbPath, description: null };
    }
    return resolveVault(deps.config, input.vault ?? null);
}

// Same bypass, for the four tools that fan out across every configured vault when `vault` is
// omitted (S007/S009) instead of resolving to a single default.
function resolveToolVaults(deps, input) {
    if (hasDirectVaultDeps(deps)) {
        return [ { name: null, path: deps.vaultRoot, dbPath: deps.dbPath, description: null } ];
    }
    return resolveVaultsForQuery(deps.config, input.vault ?? null).vaults;
}

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

// `vault` may be a plain name (known up front) or a zero-arg function read *after* fn settles,
// success or error alike — the latter lets a handler resolve its vault from inside fn (so an
// unknown-vault error goes through the same try/catch as everything else, landing as isError: true
// with a real logAudit call, rather than throwing out of this function uncaught) while still
// reporting the resolved name once fn has actually set it. Unresolved (fn threw before setting it)
// reads back whatever the getter currently returns — null, if the caller's closure never assigned
// it before throwing.
export async function callTool(auditLogger, mcpLogger, toolName, input, fn, { vault = null } = {}) {
    const noteTitle = input.note_title ?? input.old_title ?? null;
    const attachmentPath = input.attachment_path ?? null;
    const query = input.query ?? null;
    const resolveVaultForLog = typeof vault === 'function' ? vault : () => vault;
    let result;

    try {
        result = await runWithLogger(mcpLogger, fn);
    } catch (err) {
        logAudit(auditLogger, {
            tool: toolName,
            noteTitle,
            attachmentPath,
            source: 'mcp',
            reason: input.reason,
            query,
            outcome: 'error',
            errorMessage: err.message,
            vault: resolveVaultForLog(),
        });
        return { content: [ { type: 'text', text: err.message } ], isError: true };
    }

    logAudit(auditLogger, {
        tool: toolName,
        noteTitle,
        attachmentPath,
        source: 'mcp',
        reason: input.reason,
        query,
        outcome: 'success',
        errorMessage: null,
        vault: resolveVaultForLog(),
    });
    return { content: Array.isArray(result) ? result : [ { type: 'text', text: result } ] };
}

// Backs search/grep/tag_notes/metadata_query (S007/S009): `vaults` is already-resolved (one entry
// for the common single-vault case, 2+ under real fan-out), `fn(vault)` returns that vault's raw
// row array, `formatFn(allRows)` renders the final combined text once every vault has succeeded.
// A single resolved vault behaves identically to callTool above (one logAudit call, no `vault` key
// added to rows) — this is deliberately the one code path for both shapes, not two. A genuine
// per-vault core/ error aborts immediately with no partial results assembled (CLAUDE.md's
// fail-loud rule) and exactly one logAudit entry naming the vault that failed — never one per
// vault attempted.
// `resolveVaultsFn` is called inside the same try as everything else (unlike a pre-resolved array)
// so an unknown explicit `vault` argument produces the normal isError: true + one error-outcome
// logAudit, rather than throwing straight out of this function uncaught.
export async function callToolFannedOut(auditLogger, mcpLogger, toolName, input, resolveVaultsFn, fn, formatFn) {
    const query = input.query ?? null;
    let vaults;
    try {
        vaults = resolveVaultsFn();
    } catch (err) {
        logAudit(auditLogger, {
            tool: toolName, source: 'mcp', reason: input.reason, query,
            outcome: 'error', errorMessage: err.message, vault: null,
        });
        return { content: [ { type: 'text', text: err.message } ], isError: true };
    }
    const fannedOut = vaults.length > 1;
    let allRows = [];

    for (const v of vaults) {
        let rows;
        try {
            rows = await runWithLogger(mcpLogger, () => fn(v));
        } catch (err) {
            logAudit(auditLogger, {
                tool: toolName, source: 'mcp', reason: input.reason, query,
                outcome: 'error', errorMessage: err.message, vault: v.name,
            });
            return { content: [ { type: 'text', text: err.message } ], isError: true };
        }
        logAudit(auditLogger, {
            tool: toolName, source: 'mcp', reason: input.reason, query,
            outcome: 'success', errorMessage: null, vault: v.name,
        });
        allRows = allRows.concat(fannedOut ? rows.map((r) => ({ ...r, vault: v.name })) : rows);
    }

    return { content: [ { type: 'text', text: formatFn(allRows, fannedOut) } ] };
}

export async function searchTool(deps, input) {
    const { embed, embeddingModel, embeddingVersion } = deps;
    const { search: searchConfig } = resolveConfig(deps);
    const { query, mode = 'hybrid', limit = searchConfig.limit_default } = input;

    return callToolFannedOut(deps.auditLogger, deps.mcpLogger, 'search', input,
        () => resolveToolVaults(deps, input),
        (v) => withDb(v.dbPath, (db) => search(db, {
            query, mode, limit, embed, embeddingModel, embeddingVersion, vaultRoot: v.path,
            limitDefault: searchConfig.limit_default,
            limitMax: searchConfig.limit_max,
            overfetchMultiplier: searchConfig.overfetch_multiplier,
            overfetchCap: searchConfig.overfetch_cap,
            rrfK: searchConfig.rrf_k,
        })),
        (rows, fannedOut) => formatSearchTable(rows, mode, { showVault: fannedOut }));
}

export async function grepTool(deps, input) {
    const { grep: grepConfig } = resolveConfig(deps);
    const { pattern, regex = false, note_title: noteTitle = null } = input;

    return callToolFannedOut(deps.auditLogger, deps.mcpLogger, 'grep', input,
        () => resolveToolVaults(deps, input),
        (v) => {
            const runGrep = (db) => grep(v.path, pattern, {
                regex, noteTitle, lineMatchCap: grepConfig.line_match_cap, db,
            });
            return v.dbPath ? withDb(v.dbPath, runGrep) : runGrep(null);
        },
        (rows, fannedOut) => formatGrepTable(rows, { showVault: fannedOut }));
}

export async function tagListTool(deps, input) {
    let vault;
    return callTool(deps.auditLogger, deps.mcpLogger, 'tag_list', input,
        async () => {
            vault = resolveToolVault(deps, input);
            return formatTagListTable(await withDb(vault.dbPath, (db) => tagList(db)));
        },
        { vault: () => vault?.name ?? null });
}

export async function tagNotesTool(deps, input) {
    const { tag } = input;

    return callToolFannedOut(deps.auditLogger, deps.mcpLogger, 'tag_notes', input,
        () => resolveToolVaults(deps, input),
        (v) => withDb(v.dbPath, (db) => tagNotes(db, tag, { vaultRoot: v.path })),
        (rows, fannedOut) => formatTagNotesTable(rows, { showVault: fannedOut }));
}

export async function metadataKeysTool(deps, input) {
    let vault;
    return callTool(deps.auditLogger, deps.mcpLogger, 'metadata_keys', input,
        async () => {
            vault = resolveToolVault(deps, input);
            return formatMetadataKeysTable(await withDb(vault.dbPath, (db) => metadataKeys(db)));
        },
        { vault: () => vault?.name ?? null });
}

export async function metadataQueryTool(deps, input) {
    const { filters, match = 'all' } = input;

    return callToolFannedOut(deps.auditLogger, deps.mcpLogger, 'metadata_query', input,
        () => resolveToolVaults(deps, input),
        (v) => withDb(v.dbPath, (db) => metadataQuery(db, { filters, match, vaultRoot: v.path })),
        (rows, fannedOut) => formatTagNotesTable(rows, { showVault: fannedOut }));
}

export async function noteReadTool(deps, input) {
    const { note_title: noteTitle, start_line: startLine, end_line: endLine } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_read', input, async () => {
        vault = resolveToolVault(deps, input);
        const result = vault.dbPath
            ? await withDb(vault.dbPath, (db) => noteRead(vault.path, noteTitle, { startLine, endLine, db }))
            : noteRead(vault.path, noteTitle, { startLine, endLine });
        return formatJson({ vault: vault.name, ...result });
    }, { vault: () => vault?.name ?? null });
}

export async function noteWriteTool(deps, input) {
    const { notes: notesConfig } = resolveConfig(deps);
    const { note_title: noteTitle, hash, metadata = null, content, force = false } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_write', input, async () => {
        vault = resolveToolVault(deps, input);
        const result = noteWrite(vault.path, noteTitle, {
            hash, metadata, content, force, sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        return formatJson(result);
    }, { vault: () => vault?.name ?? null });
}

export async function noteEditTool(deps, input) {
    const { notes: notesConfig } = resolveConfig(deps);
    const {
        note_title: noteTitle, hash, old_txt: oldTxt, new_txt: newTxt, metadata = null,
    } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_edit', input, async () => {
        vault = resolveToolVault(deps, input);
        const result = noteEdit(vault.path, noteTitle, {
            hash, oldTxt, newTxt, metadata, sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        return formatJson(result);
    }, { vault: () => vault?.name ?? null });
}

export async function noteAppendTool(deps, input) {
    const { note_title: noteTitle, hash, content } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_append', input, async () => {
        vault = resolveToolVault(deps, input);
        const result = noteAppend(vault.path, noteTitle, hash, content);
        return formatJson(result);
    }, { vault: () => vault?.name ?? null });
}

export async function noteRenameTool(deps, input) {
    const { old_title: oldTitle, new_title: newTitle, hash } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'note_rename', input, async () => {
        vault = resolveToolVault(deps, input);
        // Passes a freshly-opened db (mirrors cli/main.js's runRename) so the search index is
        // updated in place immediately — noteRename's write-through db param exists specifically
        // to avoid a rename briefly disappearing from search while waiting on the daemon's
        // fswatch loop.
        const result = vault.dbPath
            ? await withDb(vault.dbPath, (db) => noteRename(vault.path, oldTitle, newTitle, hash, db))
            : noteRename(vault.path, oldTitle, newTitle, hash, null);
        return formatJson(result);
    }, { vault: () => vault?.name ?? null });
}

export async function listVaultsTool(deps, input) {
    return callTool(deps.auditLogger, deps.mcpLogger, 'list_vaults', input,
        async () => formatVaultsTable(listVaults(resolveConfig(deps))));
}

// The Claude API's vision input only accepts these four raster formats — anything else (SVG, HEIC,
// PDF, docx, ...) can't be rendered as an `image` content block even though MCP's schema would
// allow it, so those fall through to `resource` (blob) instead.
const RENDERABLE_IMAGE_MIME_TYPES = new Set([ 'image/png', 'image/jpeg', 'image/gif', 'image/webp' ]);

export async function attachmentReadTool(deps, input) {
    const { attachments: attachmentsConfig } = resolveConfig(deps);
    const {
        attachment_path: attachmentPath, include_content: includeContent = true,
        start_page: startPage, end_page: endPage,
    } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'attachment_read', input, async () => {
        vault = resolveToolVault(deps, input);
        const result = await readAttachment(vault.path, attachmentPath, {
            includeContent, maxReadBytes: attachmentsConfig.max_read_bytes, startPage, endPage,
        });
        const { content, ...meta } = result;
        const metaBlock = { type: 'text', text: formatJson(meta) };
        if (!content) {
            return [ metaBlock ];
        }
        const data = content.toString('base64');
        const binaryBlock = RENDERABLE_IMAGE_MIME_TYPES.has(meta.mime_type)
            ? { type: 'image', data, mimeType: meta.mime_type }
            : { type: 'resource', resource: { uri: `attachment://${meta.path}`, mimeType: meta.mime_type, blob: data } };
        return [ metaBlock, binaryBlock ];
    }, { vault: () => vault?.name ?? null });
}

export async function attachmentWriteTool(deps, input) {
    const { attachment_path: attachmentPath, content_base64: contentBase64 } = input;
    let vault;

    return callTool(deps.auditLogger, deps.mcpLogger, 'attachment_write', input, async () => {
        vault = resolveToolVault(deps, input);
        const result = writeAttachment(vault.path, attachmentPath, Buffer.from(contentBase64, 'base64'));
        return formatJson(result);
    }, { vault: () => vault?.name ?? null });
}
