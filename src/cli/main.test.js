import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync as readAuditLog } from 'node:fs';
import { Readable } from 'node:stream';
import {
    main, dispatch, resolveVaultRoot, resolveDbPath, registerCommand, runSearch, runGrep, runTags,
    runMetadata, parseFilterString, runLinks, runRead, runWrite, runEdit, runAppend, runRename,
    runStats, runAttachment, runAttachmentRead, runAttachmentWrite,
} from './main.js';
import { openDb } from '../core/db.js';
import { syncNoteTags } from '../core/tags.js';
import { getAuditLogger } from '../logger.js';
import { buildDefaultConfig } from '../config.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

// resolveVaultRoot()/resolveDbPath() default to loadConfig() (no argument), which reads the real
// ~/.config/mnotes/config.toml on whatever machine the suite runs on (S009's documented behavior
// for a real invocation). Mocking loadConfig() here keeps the "no config passed" tests below
// hermetic — they'd otherwise pass or fail depending on the developer's own local config file.
vi.mock('../config.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, loadConfig: () => actual.buildDefaultConfig() };
});

function fakeStdin(text) {
    return Readable.from([ text ]);
}

function insertTestNote(db, path, lineCount = 5) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'hash', lineCount, 1000, 1000);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

function insertTestNoteWithMetadata(db, path, metadata, lineCount = 5) {
    db.prepare(`
        INSERT INTO notes (path, content_hash, line_count, mtime, updated_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(path, 'hash', lineCount, 1000, 1000, JSON.stringify(metadata));
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

// logAudit is fire-and-forget (S008/S006), so concurrent appendFile calls to the same audit.log
// can complete out of call order — a test writing more than one audit entry before the one it's
// checking can't assume the entry under test is the *last* line. Matching tool + title instead of
// position sidesteps the race instead of just making it less likely to show up.
// (tool, noteTitle, outcome) is unique per test even when a title gets more than one audit entry
// (e.g. an initial successful write followed by a rejected mismatched one) — matching on outcome
// too, rather than just tool+title, means the result doesn't depend on which of two fire-and-forget
// appendFile calls to the same file happens to land first.
function findAuditLine(logDir, tool, noteTitle, outcome) {
    const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
    return lines.find((line) => (
        line.includes(`[audit] ${tool}`)
        && line.includes(`note_title="${noteTitle}"`)
        && line.includes(`outcome=${outcome}`)
    ));
}

describe('dispatch: unknown command', () => {
    it('returns exitCode 1 and a descriptive stderr message', async () => {
        const result = await dispatch([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown command "bogus"/);
        expect(result.stdout).toBe('');
    });
});

describe('dispatch: centralized error handling', () => {
    it('catches a thrown error from a handler and formats it to stderr with exitCode 1', async () => {
        registerCommand('__test_throw__', async () => {
            throw new Error('boom');
        });

        const result = await dispatch([ '__test_throw__' ], {});

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('mnotes: boom\n');
    });
});

describe('main: stdout/stderr write order', () => {
    it('writes stderr before stdout, so read\'s metadata prints ahead of the note body', async () => {
        registerCommand('__test_both_streams__', async () => (
            { stdout: 'STDOUT\n', stderr: 'STDERR\n', exitCode: 0 }
        ));
        const writes = [];
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            writes.push([ 'stdout', chunk ]);
            return true;
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            writes.push([ 'stderr', chunk ]);
            return true;
        });

        await main([ '__test_both_streams__' ], {});

        expect(writes).toEqual([ [ 'stderr', 'STDERR\n' ], [ 'stdout', 'STDOUT\n' ] ]);
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
    });
});

describe('resolveVaultRoot', () => {
    it('returns vault_path from the given config', () => {
        expect(resolveVaultRoot({ vault_path: '/tmp/vault' })).toBe('/tmp/vault');
    });

    it('defaults to loadConfig()\'s vault_path when no config is passed', () => {
        expect(resolveVaultRoot()).toBe(buildDefaultConfig().vault_path);
    });
});

describe('resolveDbPath', () => {
    it('returns db_path from the given config', () => {
        expect(resolveDbPath({ db_path: '/tmp/index.db' })).toBe('/tmp/index.db');
    });

    it('defaults to loadConfig()\'s db_path when no config is passed', () => {
        expect(resolveDbPath()).toBe(buildDefaultConfig().db_path);
    });
});

describe('runSearch', () => {
    it('formats fulltext results as pipe-delimited text by default', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph search notes');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(
            /^note_title \| file_line_count \| bm25_score\n-+ \| -+ \| -+\nA\s+\| 10\s+\| -?\d+(\.\d+)?\n$/,
        );
        db.close();
    });

    it('emits JSON when --json is passed', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext', '--json' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(JSON.parse(result.stdout)).toEqual([
            { note_title: 'A', file_line_count: 10, bm25_score: expect.any(Number) },
        ]);
        db.close();
    });

    it('defaults to hybrid mode when --mode is omitted', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph');

        const result = await runSearch(
            [ 'graph' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(result.stdout).toContain('note_title | file_line_count | fulltext_rank | semantic_rank');
        expect(result.stdout).toMatch(/A\s+\| 10\s+\|/);
        db.close();
    });

    it('uses deps.config.search.limit_default when --limit is omitted (config.toml-backed, S009)', async () => {
        const { db } = openDb(':memory:');
        for (let i = 0; i < 5; i += 1) {
            const noteId = insertTestNote(db, `Note${i}.md`, 1);
            db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, `Note${i}`, 'shared');
        }

        const result = await runSearch([ 'shared', '--mode=fulltext' ], {
            db,
            embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1',
            config: {
                search: { limit_default: 2, limit_max: 100, overfetch_multiplier: 5, overfetch_cap: 500, rrf_k: 60 },
            },
        });

        expect(result.stdout.trim().split('\n')).toHaveLength(4); // header + separator + 2 rows
        db.close();
    });
});

describe('runSearch: --explain', () => {
    it('shows a rank/bm25-formula breakdown table not present in default output', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph graph graph');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext', '--explain' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        expect(result.stdout).toContain('rank | note_title | file_line_count | bm25');
        expect(result.stdout).toMatch(/\| -\d+(\.\d+)?\s*$/m);
        db.close();
    });

    it('emits structured explain JSON when --explain --json are both passed', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 10);
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, 'A', 'graph');

        const result = await runSearch(
            [ 'graph', '--mode=fulltext', '--explain', '--json' ],
            { db, embed: async () => new Float32Array(1024), embeddingModel: 'm', embeddingVersion: 'v1' },
        );

        const parsed = JSON.parse(result.stdout);
        expect(parsed.pipeline.mode).toBe('fulltext');
        expect(typeof parsed.results[0].bm25_score).toBe('number');
        db.close();
    });
});

describe('runGrep', () => {
    it('formats line numbers only by default (no match text)', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'line one\nsome hello world text\n');

        const result = await runGrep([ 'hello' ], { vaultRoot });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('note_title | file_line_count | line_matches');
        expect(result.stdout).toMatch(/Recipe\s+\| 2\s+\| L2/);
        expect(result.stdout).not.toContain('hello world text');
    });

    it('includes match text with --content', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'line one\nsome hello world text\n');

        const result = await runGrep([ 'hello', '--content' ], { vaultRoot });

        expect(result.stdout).toMatch(/Recipe\s+\| 2\s+\| L2: some hello world text/);
    });

    it('supports --json', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello world\n');

        const result = await runGrep([ 'hello', '--json' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout)[0];
        expect(parsed.note_title).toBe('Recipe');
        expect(parsed.line_matches[0].text).toBeUndefined();
    });

    it('uses deps.config.grep.line_match_cap instead of the built-in default (config.toml-backed, S009)', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello\nhello\nhello\nhello\n');

        const result = await runGrep([ 'hello' ], { vaultRoot, config: { grep: { line_match_cap: 2 } } });

        expect(result.stdout).toMatch(/Recipe\s+\| 4\s+\| L1, L2 \(\+2 more\)/);
    });

    it('supports --json --content, including match text', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello world\n');

        const result = await runGrep([ 'hello', '--json', '--content' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout)[0];
        expect(parsed.line_matches[0].text).toBe('hello world');
    });

    it('--note resolves a short/basename title via deps.db', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn.md', 'hello world\n');
        const { db } = openDb(':memory:');
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');

        const result = await runGrep([ 'hello', '--note=Barbara Garn' ], { vaultRoot, db });

        expect(result.stdout).toContain('LoonStateHockey/JMS Hockey/Barbara Garn');
        db.close();
    });
});

describe('runTags', () => {
    it('list: formats tag inventory', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'list' ], { db });

        expect(result.stdout).toBe('tag     | notes_with_tag\n------- | --------------\nproject | 1\n');
        db.close();
    });

    it('notes <tag>: formats notes carrying that tag', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 7);
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'notes', 'project' ], { db });

        expect(result.stdout).toBe(
            'note_title | file_line_count\n---------- | ---------------\nA          | 7\n',
        );
        db.close();
    });

    it('returns an error for an unknown tags subcommand', async () => {
        const result = await runTags([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown tags subcommand "bogus"/);
    });

    it('returns a helpful error when no subcommand is given, not literal "undefined"', async () => {
        const result = await runTags([], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/tags requires a subcommand \(list\|notes\)/);
        expect(result.stderr).not.toMatch(/undefined/);
    });
});

describe('parseFilterString', () => {
    it('parses "key=value" into an eq condition', () => {
        expect(parseFilterString('status=active')).toEqual({
            key: 'status', op: 'eq', value: 'active', negate: false,
        });
    });

    it('parses "key!=value" into a negated eq condition', () => {
        expect(parseFilterString('status!=active')).toEqual({
            key: 'status', op: 'eq', value: 'active', negate: true,
        });
    });

    it('parses ">"/">="/"<"/"<=" without misreading ">=" as "="', () => {
        expect(parseFilterString('priority>3')).toEqual({
            key: 'priority', op: 'gt', value: 3, negate: false,
        });
        expect(parseFilterString('priority>=3')).toEqual({
            key: 'priority', op: 'gte', value: 3, negate: false,
        });
        expect(parseFilterString('due<2026-01-01')).toEqual({
            key: 'due', op: 'lt', value: '2026-01-01', negate: false,
        });
        expect(parseFilterString('due<=2026-01-01')).toEqual({
            key: 'due', op: 'lte', value: '2026-01-01', negate: false,
        });
    });

    it('parses a numeric-looking value as a JS number', () => {
        expect(parseFilterString('priority=3').value).toBe(3);
    });

    it('parses a "true"/"false" value as a JS boolean', () => {
        expect(parseFilterString('done=true').value).toBe(true);
        expect(parseFilterString('done=false').value).toBe(false);
    });

    it('parses "key in v1,v2" into an in condition with a value array', () => {
        expect(parseFilterString('status in draft,review')).toEqual({
            key: 'status', op: 'in', value: [ 'draft', 'review' ],
        });
    });

    it('parses a dot-path key unchanged', () => {
        expect(parseFilterString('depends_on.project=foo/bar')).toEqual({
            key: 'depends_on.project', op: 'eq', value: 'foo/bar', negate: false,
        });
    });

    it('throws on an unrecognized expression', () => {
        expect(() => parseFilterString('nonsense')).toThrow(/not a recognized expression/);
    });
});

describe('runMetadata', () => {
    it('keys: formats key discovery', async () => {
        const { db } = openDb(':memory:');
        insertTestNoteWithMetadata(db, 'A.md', { status: 'active' });

        const result = await runMetadata([ 'keys' ], { db });

        expect(result.stdout).toBe(
            'key    | type   | example | notes_with_key\n'
            + '------ | ------ | ------- | --------------\n'
            + 'status | string | active  | 1\n',
        );
        db.close();
    });

    it('keys --json: formats key discovery as JSON', async () => {
        const { db } = openDb(':memory:');
        insertTestNoteWithMetadata(db, 'A.md', { status: 'active' });

        const result = await runMetadata([ 'keys', '--json' ], { db });

        expect(JSON.parse(result.stdout)).toEqual([
            { key: 'status', type: 'string', example: 'active', notes_with_key: 1 },
        ]);
        db.close();
    });

    it('query --filter: filters notes by a scalar condition', async () => {
        const { db } = openDb(':memory:');
        insertTestNoteWithMetadata(db, 'A.md', { status: 'active' }, 7);
        insertTestNoteWithMetadata(db, 'B.md', { status: 'archived' });

        const result = await runMetadata([ 'query', '--filter=status=active' ], { db });

        expect(result.stdout).toBe(
            'note_title | file_line_count\n---------- | ---------------\nA          | 7\n',
        );
        db.close();
    });

    it('query --exists/--missing: sugar for {op: exists}/{op: exists, negate: true}', async () => {
        const { db } = openDb(':memory:');
        insertTestNoteWithMetadata(db, 'A.md', { due: '2026-01-01' });
        insertTestNoteWithMetadata(db, 'B.md', { status: 'active' });

        const withDue = await runMetadata([ 'query', '--exists=due' ], { db });
        expect(withDue.stdout).toContain('A');
        expect(withDue.stdout).not.toContain('B');

        const withoutDue = await runMetadata([ 'query', '--missing=due' ], { db });
        expect(withoutDue.stdout).toContain('B');
        expect(withoutDue.stdout).not.toContain('A');
        db.close();
    });

    it('query --match=any: ORs conditions instead of ANDing', async () => {
        const { db } = openDb(':memory:');
        insertTestNoteWithMetadata(db, 'A.md', { status: 'active' });
        insertTestNoteWithMetadata(db, 'B.md', { priority: 9 });
        insertTestNoteWithMetadata(db, 'C.md', { status: 'archived' });

        const result = await runMetadata([
            'query', '--filter=status=active', '--filter=priority>5', '--match=any',
        ], { db });

        expect(result.stdout).toContain('A');
        expect(result.stdout).toContain('B');
        expect(result.stdout).not.toContain('C');
        db.close();
    });

    it('query --json: formats results as JSON', async () => {
        const { db } = openDb(':memory:');
        insertTestNoteWithMetadata(db, 'A.md', { status: 'active' }, 3);

        const result = await runMetadata([ 'query', '--filter=status=active', '--json' ], { db });

        expect(JSON.parse(result.stdout)).toEqual([ { note_title: 'A', file_line_count: 3 } ]);
        db.close();
    });

    it('propagates a validation error (e.g. no filters at all) as a thrown error', async () => {
        const { db } = openDb(':memory:');
        await expect(runMetadata([ 'query' ], { db })).rejects.toThrow(/non-empty array/);
        db.close();
    });

    it('returns an error for an unknown metadata subcommand', async () => {
        const result = await runMetadata([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown metadata subcommand "bogus"/);
    });

    it('returns a helpful error when no subcommand is given, not literal "undefined"', async () => {
        const result = await runMetadata([], {});
        expect(result.stderr).toMatch(/metadata requires a subcommand \(keys\|query\)/);
        expect(result.stderr).not.toMatch(/undefined/);
    });
});

function writeRawNote(vaultRoot, relPath, raw) {
    const filePath = join(vaultRoot, relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');
}

describe('runLinks', () => {
    it('<title>: formats backlinks then links_out as a table', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Target.md', 'linking out to [[Other]]');
        const { db } = openDb(':memory:');
        insertTestNote(db, 'Target.md');
        const linkerId = insertTestNote(db, 'Linker.md');
        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(linkerId, 'Target');

        const result = await runLinks([ 'Target' ], { vaultRoot, db });

        expect(result.stdout).toBe(
            'direction | note_title\n--------- | ----------\nbacklink  | Linker\nlink_out  | Other\n',
        );
        db.close();
    });

    it('<title> --json: returns { backlinks, links_out }', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Target.md', 'linking out to [[Other]]');
        const { db } = openDb(':memory:');

        const result = await runLinks([ 'Target', '--json' ], { vaultRoot, db });

        expect(JSON.parse(result.stdout)).toEqual({ backlinks: [], links_out: [ 'Other' ] });
        db.close();
    });

    it('broken: formats dangling links as a table', async () => {
        const { db } = openDb(':memory:');
        const linkerId = insertTestNote(db, 'Linker.md');
        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(linkerId, 'Nonexistent');

        const result = await runLinks([ 'broken' ], { db });

        expect(result.stdout).toBe(
            'note_title | broken_target\n---------- | -------------\nLinker     | Nonexistent\n',
        );
        db.close();
    });

    it('broken --json: returns note_title/broken_target rows', async () => {
        const { db } = openDb(':memory:');
        const linkerId = insertTestNote(db, 'Linker.md');
        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(linkerId, 'Nonexistent');

        const result = await runLinks([ 'broken', '--json' ], { db });

        expect(JSON.parse(result.stdout)).toEqual([ { note_title: 'Linker', broken_target: 'Nonexistent' } ]);
        db.close();
    });

    it('returns an error when no title or subcommand is given', async () => {
        const result = await runLinks([], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/links requires a note title or "broken"/);
    });
});

describe('runRead', () => {
    it('default mode: body on stdout, parsed metadata JSON on stderr', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', '---\nid: A\ntags:\n  - x\n---\nbody text');

        const result = await runRead([ 'A' ], { vaultRoot });

        expect(result.stdout).toBe('body text\n');
        expect(JSON.parse(result.stderr)).toEqual({ id: 'A', tags: [ 'x' ] });
        expect(result.stderr).toBe('{\n  "id": "A",\n  "tags": [\n    "x"\n  ]\n}\n\n');
        expect(result.exitCode).toBe(0);
    });

    it('--raw: exact file bytes, nothing on stderr', async () => {
        const vaultRoot = makeTempVault();
        const raw = '---\nid: A\n---\nbody text\n';
        writeRawNote(vaultRoot, 'A.md', raw);

        const result = await runRead([ 'A', '--raw' ], { vaultRoot });

        expect(result.stdout).toBe(raw);
        expect(result.stderr).toBe('');
    });

    it('--raw resolves a short/basename title via deps.db, same as the default/--json modes', async () => {
        const vaultRoot = makeTempVault();
        const raw = 'body text\n';
        writeRawNote(vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn.md', raw);
        const { db } = openDb(':memory:');
        insertTestNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');

        const result = await runRead([ 'Barbara Garn', '--raw' ], { vaultRoot, db });

        expect(result.stdout).toBe(raw);
        db.close();
    });

    it('--json: full structured result including content_hash', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', 'body text');

        const result = await runRead([ 'A', '--json' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.title).toBe('A');
        expect(typeof parsed.content_hash).toBe('string');
        expect(result.stderr).toBe('');
    });

    it('--json includes backlinks (from deps.db) and links_out (parsed from content)', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Target.md', 'the target note, linking out to [[Other]]');
        const { db } = openDb(':memory:');
        insertTestNote(db, 'Target.md');
        const linkerId = insertTestNote(db, 'Linker.md');
        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(linkerId, 'Target');

        const result = await runRead([ 'Target', '--json' ], { vaultRoot, db });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.backlinks).toEqual([ 'Linker' ]);
        expect(parsed.links_out).toEqual([ 'Other' ]);
        db.close();
    });

    it('--start/--end window the body', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', 'l1\nl2\nl3\n');

        const result = await runRead([ 'A', '--start=2', '--end=3' ], { vaultRoot });

        expect(result.stdout).toBe('l2\nl3\n');
    });

    it('--raw on a missing note produces a "Note not found" error, not a raw ENOENT', async () => {
        const vaultRoot = makeTempVault();
        const result = await dispatch([ 'read', 'Ghost', '--raw' ], { vaultRoot });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Note not found: "Ghost"/);
    });
});

describe('runWrite', () => {
    it('creates a note from --content and logs a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);

        const result = await runWrite(
            [ 'New Note', '--content=hello world' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).title).toBe('New Note');

        await vi.waitFor(() => {
            const line = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim();
            expect(line).toContain('INFO  [audit] write');
            expect(line).toContain('note_title="New Note"');
            expect(line).toContain('source=cli');
            expect(line).toContain('outcome=success');
            expect(line).not.toContain('reason=');
        });
    });

    it('reads content from stdin when --content is omitted', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());

        const result = await runWrite(
            [ 'From Stdin' ],
            { vaultRoot, auditLogger, stdin: fakeStdin('piped body') },
        );

        expect(JSON.parse(result.stdout).title).toBe('From Stdin');
    });

    it('logs an error audit entry and rethrows (via dispatch) on a hash mismatch', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        await runWrite([ 'Existing', '--content=first' ], { vaultRoot, auditLogger });

        const result = await dispatch(
            [ 'write', 'Existing', '--hash=wrong', '--content=second' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(1);

        await vi.waitFor(() => {
            const line = findAuditLine(logDir, 'write', 'Existing', 'error');
            expect(line).toBeDefined();
            expect(line).toContain('source=cli');
            expect(line).toMatch(/error_message=".*hash mismatch.*"/i);
        });
    });

    it('rejects invalid --metadata JSON with a descriptive error', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());

        await expect(
            runWrite([ 'Bad Meta', '--content=x', '--metadata={not json' ], { vaultRoot, auditLogger }),
        ).rejects.toThrow(/--metadata is not valid JSON/);
    });

    it('honors deps.config.notes.size_drop_threshold (config.toml-backed, S009)', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());
        const config = { notes: { size_drop_threshold: 0.9 } };
        const created = await runWrite(
            [ 'Strict Threshold', '--content=l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10' ],
            { vaultRoot, auditLogger, config },
        );
        const { hash } = JSON.parse(created.stdout);

        // Default threshold (0.5) would allow this drop to 5 lines; 0.9 rejects it.
        await expect(
            runWrite(
                [ 'Strict Threshold', `--hash=${hash}`, '--content=l1\nl2\nl3\nl4\nl5' ],
                { vaultRoot, auditLogger, config },
            ),
        ).rejects.toThrow(/size-drop|below/i);
    });
});

describe('runEdit', () => {
    it('applies a surgical replace and logs a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Editable', '--content=the quick fox' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runEdit(
            [ 'Editable', `--hash=${hash}`, '--old=quick', '--new=slow' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).title).toBe('Editable');

        await vi.waitFor(() => {
            const line = findAuditLine(logDir, 'edit', 'Editable', 'success');
            expect(line).toBeDefined();
            expect(line).toContain('source=cli');
        });
    });

    it('propagates an ambiguous-match error via dispatch and logs an error audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Ambiguous', '--content=foo bar foo' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await dispatch(
            [ 'edit', 'Ambiguous', `--hash=${hash}`, '--old=foo', '--new=baz' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/ambiguous|matches \d+ times/i);

        await vi.waitFor(() => {
            const line = findAuditLine(logDir, 'edit', 'Ambiguous', 'error');
            expect(line).toBeDefined();
            expect(line).toMatch(/error_message=".*ambiguous.*"/i);
        });
    });

    it('honors deps.config.notes.size_drop_threshold (config.toml-backed, S009)', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());
        const config = { notes: { size_drop_threshold: 0.9 } };
        const created = await runWrite(
            [ 'Edit Strict Threshold', '--content=l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10' ],
            { vaultRoot, auditLogger, config },
        );
        const { hash } = JSON.parse(created.stdout);

        // Default threshold (0.5) would allow this drop; 0.9 rejects it.
        await expect(
            runEdit(
                [ 'Edit Strict Threshold', `--hash=${hash}`, '--old=l6\nl7\nl8\nl9\nl10', '--new=' ],
                { vaultRoot, auditLogger, config },
            ),
        ).rejects.toThrow(/size-drop|below/i);
    });
});

describe('runAppend', () => {
    it('appends --content to the end of the body and logs a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const created = await runWrite([ 'Appendable', '--content=first line' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runAppend(
            [ 'Appendable', `--hash=${hash}`, '--content=second line' ],
            { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        const read = await runRead([ 'Appendable' ], { vaultRoot });
        expect(read.stdout).toBe('first line\nsecond line\n');

        await vi.waitFor(() => {
            const line = findAuditLine(logDir, 'append', 'Appendable', 'success');
            expect(line).toBeDefined();
            expect(line).toContain('source=cli');
        });
    });

    it('reads content from stdin when --content is omitted', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());
        const created = await runWrite([ 'StdinAppend', '--content=first' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runAppend(
            [ 'StdinAppend', `--hash=${hash}` ],
            { vaultRoot, auditLogger, stdin: fakeStdin('second') },
        );

        expect(result.exitCode).toBe(0);
    });
});

describe('runRename', () => {
    it('moves the note and logs success against the new title', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const { db } = openDb(':memory:');
        const created = await runWrite([ 'Old Name', '--content=body' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(created.stdout).hash;

        const result = await runRename(
            [ 'Old Name', 'New Name', `--hash=${hash}` ],
            { vaultRoot, auditLogger, db },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).title).toBe('New Name');

        // Audit entry is logged against the *new* title, per this task's "Interfaces" note above —
        // not the old one, even though the command's first positional was 'Old Name'.
        await vi.waitFor(() => {
            const line = findAuditLine(logDir, 'rename', 'New Name', 'success');
            expect(line).toBeDefined();
            expect(line).toContain('source=cli');
        });
        db.close();
    });

    it('propagates a target-exists error via dispatch, with no force override, and logs an error audit entry', async () => {
        const vaultRoot = makeTempVault();
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);
        const { db } = openDb(':memory:');
        const source = await runWrite([ 'Source', '--content=a' ], { vaultRoot, auditLogger });
        await runWrite([ 'Target', '--content=b' ], { vaultRoot, auditLogger });
        const hash = JSON.parse(source.stdout).hash;

        const result = await dispatch(
            [ 'rename', 'Source', 'Target', `--hash=${hash}` ],
            { vaultRoot, auditLogger, db },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/already exists/i);

        await vi.waitFor(() => {
            const line = findAuditLine(logDir, 'rename', 'Target', 'error');
            expect(line).toBeDefined();
            expect(line).toMatch(/error_message=".*already exists.*"/i);
        });
        db.close();
    });
});

function writeAttachmentFixture(vaultRoot, relPath, buffer) {
    const filePath = join(vaultRoot, relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buffer);
    return filePath;
}

describe('runAttachmentRead', () => {
    it('default mode: shells out to the injected openAttachment with the resolved absolute path', async () => {
        const vaultRoot = makeTempVault();
        const filePath = writeAttachmentFixture(vaultRoot, 'Attachments/receipt.pdf', Buffer.from('pdf bytes'));
        const openAttachment = vi.fn();

        const result = await runAttachmentRead(
            [ 'Attachments/receipt.pdf' ], { vaultRoot, openAttachment },
        );

        expect(openAttachment).toHaveBeenCalledWith(filePath);
        expect(result.stdout).toBe('opened Attachments/receipt.pdf\n');
        expect(result.exitCode).toBe(0);
    });

    it('--raw: streams the exact file bytes to stdout', async () => {
        const vaultRoot = makeTempVault();
        const content = Buffer.from('exact raw bytes');
        writeAttachmentFixture(vaultRoot, 'Attachments/receipt.pdf', content);

        const result = await runAttachmentRead([ 'Attachments/receipt.pdf', '--raw' ], { vaultRoot });

        expect(Buffer.isBuffer(result.stdout)).toBe(true);
        expect(result.stdout.equals(content)).toBe(true);
    });

    it('--metadata: prints { path, size_bytes, mime_type } with no bytes', async () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFixture(vaultRoot, 'Attachments/receipt.pdf', Buffer.from('pdf bytes'));

        const result = await runAttachmentRead([ 'Attachments/receipt.pdf', '--metadata' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout);
        expect(parsed).toEqual({
            path: 'Attachments/receipt.pdf', size_bytes: 9, mime_type: 'application/pdf',
        });
    });

    it('--json is an alias for --metadata', async () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFixture(vaultRoot, 'Attachments/receipt.pdf', Buffer.from('pdf bytes'));

        const result = await runAttachmentRead([ 'Attachments/receipt.pdf', '--json' ], { vaultRoot });

        expect(JSON.parse(result.stdout).mime_type).toBe('application/pdf');
    });

    it('a missing attachment produces a descriptive error via dispatch', async () => {
        const vaultRoot = makeTempVault();

        const result = await dispatch(
            [ 'attachment', 'read', 'Attachments/missing.pdf' ], { vaultRoot },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/not found/i);
    });
});

describe('runAttachmentWrite', () => {
    it('reads a local file and writes it into the vault, logging a success audit entry', async () => {
        const vaultRoot = makeTempVault();
        const localDir = makeTempVault();
        const localFile = join(localDir, 'source.png');
        writeFileSync(localFile, Buffer.from('local image bytes'));
        const logDir = makeTempVault();
        const auditLogger = getAuditLogger(logDir);

        const result = await runAttachmentWrite(
            [ 'Attachments/logo.png', localFile ], { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toEqual({
            path: 'Attachments/logo.png', size_bytes: 17, mime_type: 'image/png',
        });

        await vi.waitFor(() => {
            const line = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim();
            expect(line).toContain('INFO  [audit] attachment_write');
            expect(line).toContain('attachment_path="Attachments/logo.png"');
            expect(line).toContain('source=cli');
            expect(line).toContain('outcome=success');
        });
    });

    it('reads bytes from stdin when local-file is omitted', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());
        const content = Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x00, 0x01 ]); // binary, not valid utf8

        const result = await runAttachmentWrite(
            [ 'Attachments/piped.png' ], { vaultRoot, auditLogger, stdin: Readable.from([ content ]) },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).size_bytes).toBe(6);
        const written = readAuditLog(join(vaultRoot, 'Attachments/piped.png'));
        expect(written.equals(content)).toBe(true);
    });

    it('overwrites an existing attachment unconditionally, no hash flag involved', async () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFixture(vaultRoot, 'Attachments/logo.png', Buffer.from('old bytes'));
        const localDir = makeTempVault();
        const localFile = join(localDir, 'source.png');
        writeFileSync(localFile, Buffer.from('new bytes'));
        const auditLogger = getAuditLogger(makeTempVault());

        const result = await runAttachmentWrite(
            [ 'Attachments/logo.png', localFile ], { vaultRoot, auditLogger },
        );

        expect(result.exitCode).toBe(0);
        expect(readAuditLog(join(vaultRoot, 'Attachments/logo.png'), 'utf8')).toBe('new bytes');
    });
});

describe('runAttachment dispatcher', () => {
    it('routes "read"/"write" to their handlers and errors on an unknown subcommand', async () => {
        const result = await runAttachment([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown attachment subcommand "bogus"/);
    });

    it('returns a helpful error when no subcommand is given, not literal "undefined"', async () => {
        const result = await runAttachment([], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/attachment requires a subcommand \(read\|write\)/);
        expect(result.stderr).not.toMatch(/undefined/);
    });
});

describe('runStats', () => {
    it('formats computeStats output plus daemon status', async () => {
        const dbPath = join(makeTempVault(), 'index.db');
        const { db } = openDb(dbPath);

        const result = await runStats(
            [],
            { db, dbPath, embeddingModel: 'm', embeddingVersion: 'v1', socketPath: join(makeTempVault(), 'nobody.sock') },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('note_count: 0');
        expect(result.stdout).toContain('daemon_running: false');
        db.close();
    });
});

describe('dispatch: reindex and stats are registered', () => {
    it('routes "reindex" through runReindexCommand and "stats" through runStats', async () => {
        const dbPath = join(makeTempVault(), 'index.db');
        const { db } = openDb(dbPath);

        const statsResult = await dispatch(
            [ 'stats' ],
            { db, dbPath, embeddingModel: 'm', embeddingVersion: 'v1', socketPath: join(makeTempVault(), 'nobody.sock') },
        );

        expect(statsResult.exitCode).toBe(0);
        db.close();
    });
});

describe('dispatch: "vectors" bypasses the generic --help short-circuit', () => {
    it('mnotes vectors --help lists subcommands, not a flat usage line', async () => {
        const result = await dispatch([ 'vectors', '--help' ], {});
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Subcommands:');
        expect(result.stdout).toContain('compare');
        expect(result.stdout).toContain('calibrate');
    });

    it('mnotes vectors compare --help shows compare-specific flag documentation', async () => {
        const result = await dispatch([ 'vectors', 'compare', '--help' ], {});
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Usage: mnotes vectors compare <a> <b>');
        expect(result.stdout).toContain('--aggregate=centroid|best-chunk|all-pairs');
        expect(result.stdout).not.toContain('mnotes vectors nearest');
    });
});
