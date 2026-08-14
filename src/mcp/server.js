#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SCHEMA_VERSION } from '../core/db.js';
import { getAuditLogger, getLogger, defaultLogDir } from '../logger.js';
import { embedQuery, configureEmbedder } from '../indexer/embed.js';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_VERSION } from '../indexer/daemon.js';
import { loadConfig } from '../config.js';
import { registerPrompts } from './prompts.js';
import {
    searchTool, grepTool, tagListTool, tagNotesTool, noteReadTool, noteWriteTool,
    noteEditTool, noteAppendTool, noteRenameTool,
} from './tools.js';

function readStoredSchemaVersion(dbPath) {
    const db = new DatabaseSync(dbPath);
    try {
        const tableRow = db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        ).get();
        if (!tableRow) {
            return null;
        }
        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        return row ? Number(row.value) : null;
    } finally {
        db.close();
    }
}

export function assertSchemaCurrent(dbPath) {
    const storedVersion = readStoredSchemaVersion(dbPath);

    if (storedVersion !== SCHEMA_VERSION) {
        throw new Error(
            `mnotes-mcp: index schema is out of date or missing (expected version ${SCHEMA_VERSION}, `
            + `found ${storedVersion === null ? 'none' : storedVersion}). Ensure the mnotes indexing `
            + 'daemon is running — it owns schema migration and rebuilds the index on startup.',
        );
    }
}

const SEARCH_DESCRIPTION = 'Full-text, semantic, or hybrid search over the vault. FTS5 query syntax '
    + '(AND/OR/NOT, "phrase", word*, NEAR) is live in both fulltext and hybrid mode — a malformed '
    + 'expression is a hard error in either mode, not just fulltext.';

const TOOL_DEFS = [
    {
        name: 'search',
        description: SEARCH_DESCRIPTION,
        inputSchema: {
            query: z.string(),
            mode: z.enum([ 'fulltext', 'semantic', 'hybrid' ]).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            reason: z.string(),
        },
        handler: searchTool,
    },
    {
        name: 'grep',
        description: 'Ripgrep-backed literal or regex search over vault note files. Returns matching '
            + 'line numbers only, not line content — use note_read to view the matched lines. '
            + 'note_title (if given) resolves like note_read\'s does: exact title match, or a unique '
            + 'basename match (e.g. text copied from inside a [[wikilink]]).',
        inputSchema: {
            pattern: z.string(),
            regex: z.boolean().optional(),
            note_title: z.string().optional(),
            reason: z.string(),
        },
        handler: grepTool,
    },
    {
        name: 'tag_list',
        description: 'List every tag currently in use, with an exact-match note count per tag.',
        inputSchema: { reason: z.string() },
        handler: tagListTool,
    },
    {
        name: 'tag_notes',
        description: 'List notes carrying a tag, including nested child tags (parent-includes-child).',
        inputSchema: { tag: z.string(), reason: z.string() },
        handler: tagNotesTool,
    },
    {
        name: 'note_read',
        description: 'Read a note by title, optionally windowed to a line range. note_title may be a '
            + 'short or ambiguous reference (e.g. text from inside a [[wikilink]]) — this tool '
            + 'resolves it (exact title match, or a unique basename match) and returns the note\'s '
            + 'true absolute title in its response. Every mutating tool below requires that absolute '
            + 'title exactly; read a note first if you only have a short reference to it.',
        inputSchema: {
            note_title: z.string(),
            start_line: z.number().int().optional(),
            end_line: z.number().int().optional(),
            reason: z.string(),
        },
        handler: noteReadTool,
    },
    {
        name: 'note_write',
        description: 'Create a note (hash: null) or fully replace an existing one (hash matches its '
            + 'current content_hash). No hash against an existing title is an error, not a silent '
            + 'overwrite. note_title must be the note\'s exact absolute title (full path from vault '
            + 'root) — as returned by search or note_read, never a short or ambiguous wikilink '
            + 'reference.',
        inputSchema: {
            note_title: z.string(),
            hash: z.string().nullable(),
            metadata: z.record(z.string(), z.any()).nullable().optional(),
            content: z.string(),
            force: z.boolean().optional(),
            reason: z.string(),
        },
        handler: noteWriteTool,
    },
    {
        name: 'note_edit',
        description: 'Surgically replace old_txt with new_txt in an existing note. old_txt must '
            + 'match exactly once. note_title must be the note\'s exact absolute title, as returned '
            + 'by search or note_read — no resolution fallback.',
        inputSchema: {
            note_title: z.string(),
            hash: z.string(),
            old_txt: z.string(),
            new_txt: z.string(),
            metadata: z.record(z.string(), z.any()).nullable().optional(),
            reason: z.string(),
        },
        handler: noteEditTool,
    },
    {
        name: 'note_append',
        description: 'Append content to the end of an existing note. note_title must be the note\'s '
            + 'exact absolute title, as returned by search or note_read — no resolution fallback.',
        inputSchema: {
            note_title: z.string(),
            hash: z.string(),
            content: z.string(),
            reason: z.string(),
        },
        handler: noteAppendTool,
    },
    {
        name: 'note_rename',
        description: 'Rename a note. Hard error if new_title already exists — no force override. '
            + 'Also rewrites [[wikilink]] references to old_title in every other note that links to '
            + 'it. old_title and new_title must both be exact absolute titles, as returned by search '
            + 'or note_read — no resolution fallback.',
        inputSchema: {
            old_title: z.string(),
            new_title: z.string(),
            hash: z.string(),
            reason: z.string(),
        },
        handler: noteRenameTool,
    },
];

export function createServer(deps) {
    const server = new McpServer({ name: 'mnotes-mcp', version: '0.1.0' });

    for (const { name, description, inputSchema, handler } of TOOL_DEFS) {
        server.registerTool(name, { description, inputSchema }, (input) => handler(deps, input));
    }

    registerPrompts(server);

    // S007 "Logging": the SDK's underlying `Server` (a `Protocol`) exposes `onclose`/`onerror` as
    // plain settable fields, invoked whenever *this* connection closes or hits a protocol-level
    // error (malformed JSON-RPC framing, an unsupported request) — independent of which transport
    // ends up calling `.connect()` on this server (always `StdioServerTransport` in `main()`; an
    // `InMemoryTransport` in this file's own tests). The SDK only exposes one `onerror` hook, not a
    // separate warn/error-tier pair, so every protocol-level error lands at `error` here.
    server.server.onclose = () => deps.mcpLogger.info('stdio transport disconnected');
    server.server.onerror = (err) => deps.mcpLogger.error('protocol error', { message: err.message });

    return server;
}

function resolveVaultRoot(config = loadConfig()) {
    return config.vault_path;
}

function resolveDbPath(config = loadConfig()) {
    return config.db_path;
}

export async function main() {
    const config = loadConfig();
    const vaultRoot = resolveVaultRoot(config);
    const dbPath = resolveDbPath(config);
    const mcpLogger = getLogger('mcp-server', defaultLogDir());

    assertSchemaCurrent(dbPath);
    const auditLogger = getAuditLogger(defaultLogDir());

    configureEmbedder({
        dtype: config.index.embedding_dtype,
        idleTimeoutMs: config.index.model_idle_unload_minutes * 60 * 1000,
    });

    const server = createServer({
        dbPath,
        vaultRoot,
        config,
        embed: embedQuery,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        embeddingVersion: DEFAULT_EMBEDDING_VERSION,
        auditLogger,
        mcpLogger,
    });

    mcpLogger.info('server started');
    await server.connect(new StdioServerTransport());
    mcpLogger.info('stdio transport connected');
}

// realpathSync(argv[1]), not a raw string compare — see the identical comment in cli/main.js.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.title = 'mnotes-mcp';
    main().catch((err) => {
        process.stderr.write(`mnotes-mcp: fatal: ${err.message}\n`);
        process.exit(1);
    });
}
