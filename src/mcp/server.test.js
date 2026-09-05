import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, setMeta } from '../core/db.js';
import { getAuditLogger, getLogger } from '../logger.js';
import { assertSchemaCurrent, createServer } from './server.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-mcp-server-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('assertSchemaCurrent', () => {
    it('does not throw when the stored schema_version matches SCHEMA_VERSION', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const { db } = openDb(dbPath);
        db.close();

        expect(() => assertSchemaCurrent(dbPath)).not.toThrow();
    });

    it('throws a clear, actionable error mentioning the daemon when the version is stale', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const { db } = openDb(dbPath);
        setMeta(db, 'schema_version', '999');
        db.close();

        expect(() => assertSchemaCurrent(dbPath)).toThrow(/schema.*out of date|daemon/i);
    });

    it('throws the same guard error when the meta table does not exist at all', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const bootstrap = new DatabaseSync(dbPath);
        bootstrap.close();

        expect(() => assertSchemaCurrent(dbPath)).toThrow(/schema.*out of date|daemon/i);
    });

    it('never performs a schema rebuild as a side effect of checking', () => {
        const dbPath = join(makeTempDir(), 'index.sqlite');
        const { db } = openDb(dbPath);
        setMeta(db, 'schema_version', '999');
        db.close();

        expect(() => assertSchemaCurrent(dbPath)).toThrow();

        // Re-inspect with a fresh raw connection: still stale, proving assertSchemaCurrent did not
        // rebuild/rewrite the version the way openDb would have.
        const inspect = new DatabaseSync(dbPath);
        const row = inspect.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        inspect.close();
        expect(row.value).toBe('999');
    });
});

async function connectedClient(deps) {
    const server = createServer(deps);
    const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
    ]);

    return client;
}

async function fakeEmbed() {
    return new Float32Array(1024).fill(0.1);
}

function baseDeps() {
    return {
        vaultRoot: makeTempDir(),
        embed: fakeEmbed,
        embeddingModel: 'm',
        embeddingVersion: 'v1',
        auditLogger: getAuditLogger(makeTempDir()),
        mcpLogger: getLogger('mcp-server', makeTempDir()),
    };
}

function makeTempDbPath() {
    return join(makeTempDir(), 'index.sqlite');
}

describe('createServer', () => {
    it('registers all 13 tools, listable over a real (in-memory) MCP connection', async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();

        const client = await connectedClient({ dbPath, ...baseDeps() });
        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name).sort()).toEqual([
            'attachment_read', 'attachment_write', 'grep', 'metadata_keys', 'metadata_query',
            'note_append', 'note_edit', 'note_read', 'note_rename', 'note_write', 'search',
            'tag_list', 'tag_notes',
        ]);
    });

    it('registers attachment_read with a raised maxResultSizeChars, so large base64 reads are not '
        + 'silently truncated by Claude Code\'s default MCP output limit', async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();

        const client = await connectedClient({ dbPath, ...baseDeps() });
        const { tools } = await client.listTools();

        const { _meta } = tools.find((t) => t.name === 'attachment_read');
        expect(_meta).toEqual({ 'anthropic/maxResultSizeChars': 500_000 });
    });

    it('round-trips a real search tool call end-to-end through the client', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'h', 3, 1000, 1000);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(1, 'A', 'hello world');
        db.close();

        const client = await connectedClient({ dbPath, ...baseDeps() });
        const result = await client.callTool({
            name: 'search',
            arguments: { query: 'hello', mode: 'fulltext', reason: 'end-to-end test' },
        });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toMatch(/^note_title\|file_line_count\|bm25_score\nA\|3\|-?\d+(\.\d+)?\n$/);
    });

    it('round-trips a real metadata_query tool call end-to-end through the client', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        db.prepare(`
            INSERT INTO notes (path, content_hash, line_count, mtime, updated_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('A.md', 'h', 3, 1000, 1000, JSON.stringify({ status: 'active' }));
        db.close();

        const client = await connectedClient({ dbPath, ...baseDeps() });
        const result = await client.callTool({
            name: 'metadata_query',
            arguments: {
                filters: [ { key: 'status', op: 'eq', value: 'active' } ],
                reason: 'end-to-end test',
            },
        });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toBe('note_title|file_line_count\nA|3\n');
    });

    it('round-trips attachment_write then attachment_read, decoding back to the original bytes', async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();
        const content = Buffer.from('round-trip attachment bytes');

        const client = await connectedClient({ dbPath, ...baseDeps() });
        const writeResult = await client.callTool({
            name: 'attachment_write',
            arguments: {
                attachment_path: 'Attachments/test.bin',
                content_base64: content.toString('base64'),
                reason: 'end-to-end attachment write',
            },
        });
        expect(writeResult.isError).toBeFalsy();

        const readResult = await client.callTool({
            name: 'attachment_read',
            arguments: { attachment_path: 'Attachments/test.bin', reason: 'end-to-end attachment read' },
        });

        expect(readResult.isError).toBeFalsy();
        const parsed = JSON.parse(readResult.content[0].text);
        expect(parsed.content_base64).toBeUndefined();
        expect(Buffer.from(readResult.content[1].resource.blob, 'base64').equals(content)).toBe(true);
    });

    it('rejects a tool call missing the required reason argument', async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();

        const client = await connectedClient({ dbPath, ...baseDeps() });
        const result = await client.callTool({ name: 'tag_list', arguments: {} });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/reason/i);
    });

    it('logs a stdio transport disconnected line via mcpLogger when the connection closes', async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();
        const logDir = makeTempDir();
        const deps = { dbPath, ...baseDeps(), mcpLogger: getLogger('mcp-server', logDir) };

        const client = await connectedClient(deps);
        await client.close();

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('INFO  [mcp-server] stdio transport disconnected');
        });
    });
});
