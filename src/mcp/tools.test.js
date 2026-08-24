import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { openDb } from '../core/db.js';
import { syncNoteTags } from '../core/tags.js';
import { getAuditLogger, getLogger, getContextLogger } from '../logger.js';
import {
    callTool, searchTool, grepTool, tagListTool, tagNotesTool, noteReadTool, noteWriteTool,
    noteEditTool, noteAppendTool, noteRenameTool, attachmentReadTool, attachmentWriteTool,
} from './tools.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), `mnotes-mcp-${prefix}-test-`));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

function makeDeps(extra = {}) {
    const logDir = makeTempDir('log');
    return {
        auditLogger: getAuditLogger(logDir),
        mcpLogger: getLogger('mcp-server', logDir),
        logDir,
        ...extra,
    };
}

function readAuditLines(logDir) {
    const text = readFileSync(join(logDir, 'audit.log'), 'utf8').trim();
    return text === '' ? [] : text.split('\n');
}

async function waitForAuditLines(logDir, count = 1) {
    await vi.waitFor(() => {
        expect(readAuditLines(logDir).length).toBeGreaterThanOrEqual(count);
    });
    return readAuditLines(logDir);
}

function insertNote(db, { path, contentHash = 'hash', lineCount = 10, mtime = 1000 }) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, contentHash, lineCount, mtime, mtime);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function insertFtsRow(db, noteId, title, body) {
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
}

async function fakeEmbed() {
    return new Float32Array(1024).fill(0.1);
}

function makeTempVault(files = {}) {
    const dir = makeTempDir('vault');
    for (const [ relPath, content ] of Object.entries(files)) {
        writeFileSync(join(dir, relPath), content);
    }
    return dir;
}

function writeRawNote(vaultRoot, title, raw) {
    const filePath = join(vaultRoot, `${title}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');
    return filePath;
}

describe('callTool', () => {
    it('wraps a successful result and logs a success audit entry', async () => {
        const { auditLogger, mcpLogger, logDir } = makeDeps();

        const result = await callTool(
            auditLogger, mcpLogger, 'search', { reason: 'testing audit success' },
            async () => 'ok',
        );

        expect(result).toEqual({ content: [ { type: 'text', text: 'ok' } ] });
        const [ line ] = await waitForAuditLines(logDir);
        expect(line).toContain('INFO  [audit] search');
        expect(line).toContain('source=mcp');
        expect(line).toContain('reason="testing audit success"');
        expect(line).toContain('outcome=success');
        expect(line).not.toContain('error_message=');
    });

    it('maps a thrown Error to isError: true and logs an error audit entry', async () => {
        const { auditLogger, mcpLogger, logDir } = makeDeps();

        const result = await callTool(
            auditLogger, mcpLogger, 'note_write', { note_title: 'X', reason: 'testing audit failure' },
            async () => { throw new Error('hash mismatch'); },
        );

        expect(result).toEqual({
            content: [ { type: 'text', text: 'hash mismatch' } ],
            isError: true,
        });
        const [ line ] = await waitForAuditLines(logDir);
        expect(line).toContain('INFO  [audit] note_write');
        expect(line).toContain('note_title="X"');
        expect(line).toContain('source=mcp');
        expect(line).toContain('reason="testing audit failure"');
        expect(line).toContain('outcome=error');
        expect(line).toContain('error_message="hash mismatch"');
    });

    it('maps a synchronous throw the same way as an async rejection', async () => {
        const { auditLogger, mcpLogger } = makeDeps();

        const result = await callTool(auditLogger, mcpLogger, 'search', { reason: 'sync throw' }, () => {
            throw new Error('sync boom');
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('sync boom');
    });

    it('logs note_title from old_title when present (note_rename), null otherwise', async () => {
        const { auditLogger, mcpLogger, logDir } = makeDeps();

        await callTool(
            auditLogger, mcpLogger, 'note_rename',
            { old_title: 'Old', new_title: 'New', reason: 'testing rename audit' },
            async () => 'ok',
        );
        await callTool(
            auditLogger, mcpLogger, 'search', { reason: 'testing null note_title' }, async () => 'ok',
        );

        const lines = await waitForAuditLines(logDir, 2);
        const renameLine = lines.find((l) => l.includes('[audit] note_rename'));
        const searchLine = lines.find((l) => l.includes('[audit] search'));
        expect(renameLine).toContain('note_title="Old"');
        expect(searchLine).not.toContain('note_title=');
    });

    it('logs attachment_path instead of note_title when input has attachment_path', async () => {
        const { auditLogger, mcpLogger, logDir } = makeDeps();

        await callTool(
            auditLogger, mcpLogger, 'attachment_write',
            { attachment_path: 'Attachments/receipt.pdf', reason: 'testing attachment audit' },
            async () => 'ok',
        );

        const [ line ] = await waitForAuditLines(logDir);
        expect(line).toContain('INFO  [audit] attachment_write');
        expect(line).toContain('attachment_path="Attachments/receipt.pdf"');
        expect(line).not.toContain('note_title=');
    });

    it('runs fn inside a runWithLogger context, so a getContextLogger call in fn reaches mcp-server.log',
        async () => {
            const { auditLogger, mcpLogger, logDir } = makeDeps();

            await callTool(auditLogger, mcpLogger, 'search', { reason: 'testing context logger' },
                async () => {
                    getContextLogger().info('inside fn', { probe: 'search' });
                    return 'ok';
                });

            await vi.waitFor(() => {
                const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
                expect(line).toContain('INFO  [mcp-server] inside fn');
                expect(line).toContain('probe="search"');
            });
        });

    it('still reaches getContextLogger via runWithLogger on the error path before logging the audit '
        + 'entry', async () => {
        const { auditLogger, mcpLogger, logDir } = makeDeps();

        await callTool(auditLogger, mcpLogger, 'note_write', { note_title: 'X', reason: 'testing' },
            async () => {
                getContextLogger().warn('about to fail');
                throw new Error('hash mismatch');
            });

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('WARN  [mcp-server] about to fail');
        });
    });
});

function makeTempDbPath() {
    return join(makeTempDir('db'), 'index.sqlite');
}

describe('searchTool', () => {
    it('returns a pipe-delimited table for a fulltext hit', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        const noteId = insertNote(db, { path: 'Recipe.md', lineCount: 5 });
        insertFtsRow(db, noteId, 'Recipe', 'a note about knowledge graphs');
        db.close();

        const result = await searchTool(
            makeDeps({ dbPath, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' }),
            { query: 'graphs', mode: 'fulltext', limit: 20, reason: 'testing search' },
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe('note_title|file_line_count\nRecipe|5\n');
    });

    it('maps a thrown search() error (malformed FTS5 syntax) to isError: true', async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();

        const result = await searchTool(
            makeDeps({ dbPath, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' }),
            { query: '"unterminated', mode: 'fulltext', limit: 20, reason: 'testing search' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/malformed/i);
    });

    it('defaults mode to hybrid and includes rank columns when omitted', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        const noteId = insertNote(db, { path: 'Both.md' });
        insertFtsRow(db, noteId, 'Both', 'graph search');
        db.close();

        const result = await searchTool(
            makeDeps({ dbPath, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' }),
            { query: 'graph', reason: 'testing default mode' },
        );

        expect(result.content[0].text).toContain('fulltext_rank|semantic_rank');
    });

    it('sees a note written by a separate connection after the tool\'s deps were created '
        + '(regression: a stale shared connection previously missed writes from other processes)',
    async () => {
        const dbPath = makeTempDbPath();
        openDb(dbPath).db.close();
        const deps = makeDeps({ dbPath, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1' });

        // Simulates the indexer daemon writing to the same file via its own connection, after
        // this tool's deps (and dbPath) already existed.
        const { db: writer } = openDb(dbPath);
        const noteId = insertNote(writer, { path: 'Late.md', lineCount: 2 });
        insertFtsRow(writer, noteId, 'Late', 'a note written after deps existed');
        writer.close();

        const result = await searchTool(deps, {
            query: 'written', mode: 'fulltext', limit: 20, reason: 'testing freshness',
        });

        expect(result.content[0].text).toContain('Late|2');
    });

    it('uses deps.config.search.limit_default when input.limit is omitted (config.toml-backed, S009)', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertNote(db, { path: `Note${i}.md` });
            insertFtsRow(db, noteId, `Note${i}`, 'shared term');
        }
        db.close();

        const deps = makeDeps({
            dbPath, embed: fakeEmbed, embeddingModel: 'm', embeddingVersion: 'v1',
            config: { search: { limit_default: 2, limit_max: 100, overfetch_multiplier: 5, overfetch_cap: 500, rrf_k: 60 } },
        });

        const result = await searchTool(deps, { query: 'shared', mode: 'fulltext', reason: 'testing config limit' });

        expect(result.content[0].text.trim().split('\n')).toHaveLength(3); // header + 2 rows
    });
});

describe('grepTool', () => {
    it('returns a pipe-delimited table with capped line_matches, line numbers only (no match text)', async () => {
        const vaultRoot = makeTempVault({ 'Recipe.md': 'line one\nsome hello world text\n' });

        const result = await grepTool(
            makeDeps({ vaultRoot }),
            { pattern: 'hello', reason: 'testing grep' },
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe(
            'note_title|file_line_count|line_matches\nRecipe|2|L2\n',
        );
        expect(result.content[0].text).not.toContain('hello world text');
    });

    it('resolves note_title via dbPath when it does not match exactly', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'apple pie recipe\n');
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        insertNote(db, { path: 'LoonStateHockey/JMS Hockey/Barbara Garn.md' });
        db.close();

        const result = await grepTool(
            makeDeps({ vaultRoot, dbPath }),
            { pattern: 'apple', note_title: 'Barbara Garn', reason: 'testing resolution' },
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('LoonStateHockey/JMS Hockey/Barbara Garn');
    });

    it('maps a thrown grep() error (unknown note_title) to isError: true', async () => {
        const vaultRoot = makeTempVault({ 'A.md': 'apple pie\n' });

        const result = await grepTool(
            makeDeps({ vaultRoot }),
            { pattern: 'apple', note_title: 'Nonexistent', reason: 'testing scoped grep' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/note not found/i);
    });

    it('uses deps.config.grep.line_match_cap instead of the built-in default (config.toml-backed, S009)', async () => {
        const vaultRoot = makeTempVault({ 'Recipe.md': 'hello\nhello\nhello\nhello\n' });

        const result = await grepTool(
            makeDeps({ vaultRoot, config: { grep: { line_match_cap: 2 } } }),
            { pattern: 'hello', reason: 'testing config line_match_cap' },
        );

        expect(result.content[0].text).toBe('note_title|file_line_count|line_matches\nRecipe|4|L1, L2 (+2 more)\n');
    });
});

describe('tagListTool', () => {
    it('returns a pipe-delimited table of tag/notes_with_tag', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        const noteId = insertNote(db, { path: 'A.md' });
        syncNoteTags(db, noteId, [ 'project' ]);
        db.close();

        const result = await tagListTool(makeDeps({ dbPath }), { reason: 'testing tag_list' });

        expect(result.content[0].text).toBe('tag|notes_with_tag\nproject|1\n');
    });
});

describe('tagNotesTool', () => {
    it('returns a pipe-delimited table of matching notes, parent-includes-child', async () => {
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        const noteId = insertNote(db, { path: 'A.md', lineCount: 3 });
        syncNoteTags(db, noteId, [ 'project/api-migration' ]);
        db.close();

        const result = await tagNotesTool(
            makeDeps({ dbPath }), { tag: 'project', reason: 'testing tag_notes' },
        );

        expect(result.content[0].text).toBe('note_title|file_line_count\nA|3\n');
    });
});

describe('noteReadTool', () => {
    it('returns structured JSON with title/content/metadata/content_hash', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Plain Note', 'body text');

        const result = await noteReadTool(
            makeDeps({ vaultRoot }),
            { note_title: 'Plain Note', reason: 'testing note_read' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.title).toBe('Plain Note');
        expect(parsed.content).toBe('body text');
        expect(parsed.metadata).toEqual({});
        expect(typeof parsed.content_hash).toBe('string');
    });

    it('maps a missing-note error to isError: true with the message preserved', async () => {
        const vaultRoot = makeTempVault({});

        const result = await noteReadTool(
            makeDeps({ vaultRoot }),
            { note_title: 'Does Not Exist', reason: 'testing missing note' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/not found/i);
    });

    it('passes start_line/end_line through to noteRead for windowing', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Multi', 'line1\nline2\nline3\n');

        const result = await noteReadTool(
            makeDeps({ vaultRoot }),
            { note_title: 'Multi', start_line: 2, end_line: 3, reason: 'testing windowing' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.content).toBe('line2\nline3');
    });

    it('returns backlinks (from dbPath) and links_out (parsed from content)', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Target', 'the target note, linking out to [[Other]]');
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        insertNote(db, { path: 'Target.md' });
        const linkerId = insertNote(db, { path: 'Linker.md' });
        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(linkerId, 'Target');
        db.close();

        const result = await noteReadTool(
            makeDeps({ vaultRoot, dbPath }),
            { note_title: 'Target', reason: 'testing backlinks' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.backlinks).toEqual([ 'Linker' ]);
        expect(parsed.links_out).toEqual([ 'Other' ]);
    });

    it('returns an empty backlinks array when no dbPath is configured', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'NoDb', 'body text');

        const result = await noteReadTool(
            makeDeps({ vaultRoot }),
            { note_title: 'NoDb', reason: 'testing no dbPath' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.backlinks).toEqual([]);
    });
});

describe('noteWriteTool', () => {
    it('creates a new note when hash is null, returning { title, hash, line_count } as JSON', async () => {
        const vaultRoot = makeTempVault({});

        const result = await noteWriteTool(
            makeDeps({ vaultRoot }),
            { note_title: 'New Note', hash: null, content: 'hello world', reason: 'testing create' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.title).toBe('New Note');
        expect(parsed.line_count).toBe(1);
        expect(typeof parsed.hash).toBe('string');
    });

    it('maps "already exists" (null hash against existing title) to isError: true', async () => {
        const vaultRoot = makeTempVault({});
        writeRawNote(vaultRoot, 'Existing', 'already here');

        const result = await noteWriteTool(
            makeDeps({ vaultRoot }),
            { note_title: 'Existing', hash: null, content: 'overwrite attempt', reason: 'testing guard' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/already exists/i);
    });

    it('bypasses the size-drop guard when force: true is passed', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot });
        const created = await noteWriteTool(
            deps,
            {
                note_title: 'Shrinking', hash: null,
                content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10', reason: 'setup',
            },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteWriteTool(
            deps,
            { note_title: 'Shrinking', hash, content: 'l1', force: true, reason: 'testing force' },
        );

        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text).line_count).toBe(1);
    });

    it('honors deps.config.notes.size_drop_threshold (config.toml-backed, S009)', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot, config: { notes: { size_drop_threshold: 0.9 } } });
        const created = await noteWriteTool(
            deps,
            {
                note_title: 'Strict Threshold', hash: null,
                content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10', reason: 'setup',
            },
        );
        const { hash } = JSON.parse(created.content[0].text);

        // Default threshold (0.5) would allow this drop to 5 lines; 0.9 rejects it.
        const result = await noteWriteTool(
            deps,
            { note_title: 'Strict Threshold', hash, content: 'l1\nl2\nl3\nl4\nl5', reason: 'testing config threshold' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/size-drop|below/i);
    });
});

describe('noteEditTool', () => {
    it('replaces old_txt with new_txt exactly once, returning JSON', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot });
        const created = await noteWriteTool(
            deps,
            { note_title: 'Editable', hash: null, content: 'the quick fox', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteEditTool(
            deps,
            {
                note_title: 'Editable', hash, old_txt: 'quick', new_txt: 'slow',
                reason: 'testing edit',
            },
        );

        expect(result.isError).toBeUndefined();
        const read = await noteReadTool(deps, { note_title: 'Editable', reason: 'verify' });
        expect(JSON.parse(read.content[0].text).content).toBe('the slow fox');
    });

    it('maps an ambiguous old_txt match to isError: true', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot });
        const created = await noteWriteTool(
            deps,
            { note_title: 'Ambiguous', hash: null, content: 'foo bar foo', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteEditTool(
            deps,
            { note_title: 'Ambiguous', hash, old_txt: 'foo', new_txt: 'baz', reason: 'testing ambiguity' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/ambiguous|matches \d+ times/i);
    });
});

describe('noteAppendTool', () => {
    it('appends content and returns { title, hash, line_count } as JSON', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot });
        const created = await noteWriteTool(
            deps,
            { note_title: 'Appendable', hash: null, content: 'first line', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteAppendTool(
            deps,
            { note_title: 'Appendable', hash, content: 'second line', reason: 'testing append' },
        );

        expect(JSON.parse(result.content[0].text).line_count).toBe(2);
    });
});

describe('noteRenameTool', () => {
    it('renames and returns { title: new_title, hash, line_count } as JSON', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot });
        const created = await noteWriteTool(
            deps,
            { note_title: 'Old Name', hash: null, content: 'body unchanged', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteRenameTool(
            deps,
            { old_title: 'Old Name', new_title: 'New Name', hash, reason: 'testing rename' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.title).toBe('New Name');
    });

    it('hard-errors when new_title already exists, with no force override available', async () => {
        const vaultRoot = makeTempVault({});
        const deps = makeDeps({ vaultRoot });
        const created = await noteWriteTool(
            deps,
            { note_title: 'Source', hash: null, content: 'source body', reason: 'setup' },
        );
        await noteWriteTool(
            deps,
            { note_title: 'Target', hash: null, content: 'target body', reason: 'setup' },
        );
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteRenameTool(
            deps,
            { old_title: 'Source', new_title: 'Target', hash, reason: 'testing collision' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/already exists/i);
    });

    it('updates the search index in place when deps.dbPath is provided (write-through)', async () => {
        const vaultRoot = makeTempVault({});
        const dbPath = makeTempDbPath();
        const { db } = openDb(dbPath);
        const deps = makeDeps({ vaultRoot, dbPath });
        const created = await noteWriteTool(
            deps,
            { note_title: 'Indexed', hash: null, content: 'body', reason: 'setup' },
        );
        insertNote(db, { path: 'Indexed.md' });
        db.close();
        const { hash } = JSON.parse(created.content[0].text);

        const result = await noteRenameTool(
            deps,
            { old_title: 'Indexed', new_title: 'Renamed', hash, reason: 'testing write-through' },
        );

        expect(result.isError).toBeUndefined();
        const { db: verify } = openDb(dbPath);
        const row = verify.prepare('SELECT path FROM notes WHERE path = ?').get('Renamed.md');
        expect(row.path).toBe('Renamed.md');
        verify.close();
    });
});

describe('attachmentReadTool', () => {
    it('returns size_bytes/mime_type/content_base64, decodable back to the original bytes', async () => {
        const vaultRoot = makeTempVault({});
        const content = Buffer.from('pdf bytes here');
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });
        writeFileSync(join(vaultRoot, 'Attachments/receipt.pdf'), content);

        const result = await attachmentReadTool(
            makeDeps({ vaultRoot }),
            { attachment_path: 'Attachments/receipt.pdf', reason: 'testing attachment read' },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.path).toBe('Attachments/receipt.pdf');
        expect(parsed.size_bytes).toBe(content.length);
        expect(parsed.mime_type).toBe('application/pdf');
        expect(Buffer.from(parsed.content_base64, 'base64').equals(content)).toBe(true);
    });

    it('omits content_base64 when include_content is false', async () => {
        const vaultRoot = makeTempVault({});
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });
        writeFileSync(join(vaultRoot, 'Attachments/receipt.pdf'), 'bytes');

        const result = await attachmentReadTool(
            makeDeps({ vaultRoot }),
            {
                attachment_path: 'Attachments/receipt.pdf', include_content: false,
                reason: 'testing metadata only',
            },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.content_base64).toBeUndefined();
        expect(parsed.size_bytes).toBe(5);
    });

    it('maps an over-cap read with include_content: true to isError: true', async () => {
        const vaultRoot = makeTempVault({});
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });
        writeFileSync(join(vaultRoot, 'Attachments/big.bin'), Buffer.alloc(100));

        const result = await attachmentReadTool(
            makeDeps({ vaultRoot, config: { attachments: { max_read_bytes: 10 } } }),
            { attachment_path: 'Attachments/big.bin', reason: 'testing cap' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/100 bytes.*10/);
    });

    it('maps a missing attachment to isError: true', async () => {
        const vaultRoot = makeTempVault({});

        const result = await attachmentReadTool(
            makeDeps({ vaultRoot }),
            { attachment_path: 'Attachments/missing.pdf', reason: 'testing missing' },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/not found/i);
    });

    it('returns a page-range slice of a real PDF, with total_pages naming the full document', async () => {
        const vaultRoot = makeTempVault({});
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });
        const doc = await PDFDocument.create();
        for (let i = 0; i < 6; i += 1) {
            doc.addPage([ 200, 200 ]);
        }
        writeFileSync(join(vaultRoot, 'Attachments/doc.pdf'), Buffer.from(await doc.save()));

        const result = await attachmentReadTool(
            makeDeps({ vaultRoot }),
            {
                attachment_path: 'Attachments/doc.pdf', start_page: 2, end_page: 3,
                reason: 'testing page-range read',
            },
        );

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.total_pages).toBe(6);
        const sliced = await PDFDocument.load(Buffer.from(parsed.content_base64, 'base64'));
        expect(sliced.getPageCount()).toBe(2);
    });

    it('maps an out-of-range start_page/end_page to isError: true, naming total_pages', async () => {
        const vaultRoot = makeTempVault({});
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });
        const doc = await PDFDocument.create();
        doc.addPage([ 200, 200 ]);
        writeFileSync(join(vaultRoot, 'Attachments/doc.pdf'), Buffer.from(await doc.save()));

        const result = await attachmentReadTool(
            makeDeps({ vaultRoot }),
            {
                attachment_path: 'Attachments/doc.pdf', start_page: 1, end_page: 5,
                reason: 'testing out-of-range page',
            },
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/total_pages/);
    });
});

describe('attachmentWriteTool', () => {
    it('creates a new attachment from base64 content, returning { path, size_bytes, mime_type }', async () => {
        const vaultRoot = makeTempVault({});
        const content = Buffer.from('brand new image bytes');

        const result = await attachmentWriteTool(
            makeDeps({ vaultRoot }),
            {
                attachment_path: 'Attachments/logo.png', content_base64: content.toString('base64'),
                reason: 'testing attachment write',
            },
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toEqual({
            path: 'Attachments/logo.png', size_bytes: content.length, mime_type: 'image/png',
        });
        expect(readFileSync(join(vaultRoot, 'Attachments/logo.png')).equals(content)).toBe(true);
    });

    it('overwrites an existing attachment unconditionally (no hash guard)', async () => {
        const vaultRoot = makeTempVault({});
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });
        writeFileSync(join(vaultRoot, 'Attachments/logo.png'), 'old bytes');
        const deps = makeDeps({ vaultRoot });

        const result = await attachmentWriteTool(
            deps,
            {
                attachment_path: 'Attachments/logo.png',
                content_base64: Buffer.from('new bytes').toString('base64'),
                reason: 'testing overwrite',
            },
        );

        expect(result.isError).toBeUndefined();
        expect(readFileSync(join(vaultRoot, 'Attachments/logo.png'), 'utf8')).toBe('new bytes');
    });
});
