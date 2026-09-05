#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SCHEMA_VERSION } from '../core/db.js';
import { getAuditLogger, getLogger, defaultLogDir } from '../logger.js';
import { embedQueryOverSocket } from '../indexer/embed.js';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_VERSION, defaultSocketPath } from '../indexer/daemon.js';
import { loadConfig } from '../config.js';
import { registerPrompts } from './prompts.js';
import {
    searchTool, grepTool, tagListTool, tagNotesTool, metadataKeysTool, metadataQueryTool,
    noteReadTool, noteWriteTool, noteEditTool, noteAppendTool, noteRenameTool, attachmentReadTool,
    attachmentWriteTool,
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
    + 'expression is a hard error in either mode, not just fulltext. In semantic mode, and in hybrid '
    + 'mode for results that matched via the semantic side, results also include chunk_line_start/ '
    + 'chunk_line_end — the line span (within the note body) of the specific passage that matched, '
    + 'not the whole note. Pass these straight through as note_read\'s start_line/end_line to fetch '
    + 'just that slice of a large note instead of reading it in full. fulltext mode results include '
    + 'bm25_score (lower is more relevant); semantic mode results include cosine_distance (lower is '
    + 'more similar). hybrid mode has neither — it reports fulltext_rank/semantic_rank position only, '
    + 'since its fused RRF score isn\'t independently meaningful.';

const TAG_ESCAPE_NOTE = ' Content is scanned for inline #tags on reindex. An isolated ref like #5 is '
    + 'already safe (rejected as purely numeric) — the risk is adjacency (#1/#2 from prose issue '
    + 'refs) or a hex-looking run (#3498db), both of which become real tags. Escape a single value '
    + 'with a backslash (\\#foo) or wrap a longer run in backticks, e.g. `#1/#2`.';

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
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
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
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: grepTool,
    },
    {
        name: 'tag_list',
        description: 'List every tag currently in use, with an exact-match note count per tag.',
        inputSchema: { reason: z.string() },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: tagListTool,
    },
    {
        name: 'tag_notes',
        description: 'List notes carrying a tag, including nested child tags (parent-includes-child).',
        inputSchema: { tag: z.string(), reason: z.string() },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: tagNotesTool,
    },
    {
        name: 'metadata_keys',
        description: 'Discover which frontmatter fields are currently in use across the vault. '
            + 'tags is never listed here even though it IS filterable via metadata_query — use '
            + 'tag_list to discover the tag vocabulary instead. One row per distinct field: key, an '
            + 'inferred type (string/number/boolean/date, sampled from one non-null value — a hint, '
            + 'not an enforced schema), an example value, and the count of notes carrying that field.',
        inputSchema: { reason: z.string() },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: metadataKeysTool,
    },
    {
        name: 'metadata_query',
        description: 'Filter notes by frontmatter field conditions — see metadata_keys for '
            + 'discovering what fields exist. Each filter is { key, op, value?, negate? }: key is a '
            + 'bare top-level field ("status") or exactly one level of nesting '
            + '("depends_on.project" — e.g. one field of an array-of-objects entry, matched '
            + "independently of that array's other entries); deeper nesting isn't addressable here, "
            + "only via note_read's raw metadata. op is eq/gt/gte/lt/lte/in/exists — there is no ne; "
            + "negate: true wraps the whole condition instead (the only version that's correct "
            + 'against a field with multiple values per note). value is required for every op except '
            + 'exists; for in, value is an array ("any of these"). A date literal like '
            + '"2026-01-01" compares correctly against a full-precision stored timestamp regardless '
            + "of how a caller's literal is written. key: \"tags\" is a special case, routed through "
            + 'the same tag-matching tag_notes uses (including nested-child matching) instead of '
            + "frontmatter — only eq/in/exists are valid against it (tags aren't ordered), and it "
            + 'takes no dot-path nesting; note that tags does NOT appear in metadata_keys\' output '
            + '(use tag_list to discover tag names), even though it\'s filterable here. Multiple '
            + 'filters combine via match: "all" (default, AND) or "any" (OR) — one flat toggle over '
            + 'every filter, not nested boolean grouping.',
        inputSchema: {
            filters: z.array(z.object({
                key: z.string(),
                op: z.enum([ 'eq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists' ]),
                value: z.union([
                    z.string(), z.number(), z.boolean(),
                    z.array(z.union([ z.string(), z.number(), z.boolean() ])),
                ]).optional(),
                negate: z.boolean().optional(),
            })).min(1),
            match: z.enum([ 'all', 'any' ]).optional(),
            reason: z.string(),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: metadataQueryTool,
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
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: noteReadTool,
    },
    {
        name: 'note_write',
        description: 'Create a note (hash: null) or fully replace an existing one (hash matches its '
            + 'current content_hash). No hash against an existing title is an error, not a silent '
            + 'overwrite. note_title must be the note\'s exact absolute title (full path from vault '
            + 'root) — as returned by search or note_read, never a short or ambiguous wikilink '
            + 'reference.' + TAG_ESCAPE_NOTE,
        inputSchema: {
            note_title: z.string(),
            hash: z.string().nullable(),
            metadata: z.record(z.string(), z.any()).nullable().optional(),
            content: z.string(),
            force: z.boolean().optional(),
            reason: z.string(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        },
        handler: noteWriteTool,
    },
    {
        name: 'note_edit',
        description: 'Surgically replace old_txt with new_txt in an existing note. old_txt must '
            + 'match exactly once. note_title must be the note\'s exact absolute title, as returned '
            + 'by search or note_read — no resolution fallback.' + TAG_ESCAPE_NOTE,
        inputSchema: {
            note_title: z.string(),
            hash: z.string(),
            old_txt: z.string(),
            new_txt: z.string(),
            metadata: z.record(z.string(), z.any()).nullable().optional(),
            reason: z.string(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        },
        handler: noteEditTool,
    },
    {
        name: 'note_append',
        description: 'Append content to the end of an existing note. note_title must be the note\'s '
            + 'exact absolute title, as returned by search or note_read — no resolution fallback.'
            + TAG_ESCAPE_NOTE,
        inputSchema: {
            note_title: z.string(),
            hash: z.string(),
            content: z.string(),
            reason: z.string(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
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
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        },
        handler: noteRenameTool,
    },
    {
        name: 'attachment_read',
        description: 'Read a binary vault file that is not a note (image, PDF, etc.), referenced '
            + 'from a note via a [[wikilink]]/![[embed]]/markdown-link. attachment_path must be the '
            + 'exact vault-relative path as it appears in that reference — there is no short-form or '
            + 'basename resolution for attachments, unlike note_title. Returns two content blocks '
            + 'when include_content is true (the default) and the file is under the configured size '
            + 'cap: a text block with { path, size_bytes, mime_type, total_pages? } as JSON, plus a '
            + 'second block carrying the actual bytes — an image block for PNG/JPEG/GIF/WebP, or a '
            + 'resource block (base64 blob) for everything else, including PDFs — never inlined as a '
            + 'base64 string inside the JSON metadata. include_content: false (or an over-cap file) '
            + 'returns only the metadata text block, no second block; an over-cap file with '
            + 'include_content left true is a hard error directing you to retry with '
            + 'include_content: false, or (PDFs) with start_page/end_page. For PDFs, total_pages is '
            + 'also returned (metadata-only reads included) whenever the file parses as a valid PDF. '
            + 'start_page/end_page (1-indexed, inclusive, PDF only) fetch just that page range as a '
            + 'standalone PDF instead of the whole file — both are required together, must fall '
            + 'within 1..total_pages, and cannot be combined with include_content: false.',
        inputSchema: {
            attachment_path: z.string(),
            include_content: z.boolean().optional(),
            start_page: z.number().int().positive().optional(),
            end_page: z.number().int().positive().optional(),
            reason: z.string(),
        },
        _meta: { 'anthropic/maxResultSizeChars': 500_000 },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        handler: attachmentReadTool,
    },
    {
        name: 'attachment_write',
        description: 'Create or overwrite a binary vault file that is not a note (image, PDF, etc.) '
            + '— always a full replace, no hash guard (unlike the note_* mutating tools — binary '
            + 'attachments have no diffable text content for a hash guard to protect). '
            + 'attachment_path must be the exact vault-relative path; parent directories are created '
            + 'as needed. content_base64 is the file\'s bytes, base64-encoded.',
        inputSchema: {
            attachment_path: z.string(),
            content_base64: z.string(),
            reason: z.string(),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
        },
        handler: attachmentWriteTool,
    },
];

export function createServer(deps) {
    const server = new McpServer({ name: 'mnotes-mcp', version: '0.1.0' });

    for (const { name, description, inputSchema, _meta, annotations, handler } of TOOL_DEFS) {
        server.registerTool(
            name,
            {
                description,
                inputSchema,
                ...(_meta ? { _meta } : {}),
                ...(annotations ? { annotations } : {}),
            },
            (input) => handler(deps, input),
        );
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
    const socketPath = defaultSocketPath();

    const server = createServer({
        dbPath,
        vaultRoot,
        config,
        // The daemon is the only process that ever loads the embedding model (S005) — this asks it
        // over IPC rather than loading a second copy in this MCP server process.
        embed: (text) => embedQueryOverSocket(socketPath, text),
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
