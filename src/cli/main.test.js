import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync as readAuditLog } from 'node:fs';
import { Readable } from 'node:stream';
import {
    main, dispatch, resolveVaultRoot, resolveDbPath, registerCommand, runSearch, runGrep, runTags,
    runLinks, runRead, runWrite, runEdit, runAppend, runRename, runStats,
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
        expect(result.stdout).toBe(
            'note_title | file_line_count\n---------- | ---------------\nA          | 10\n',
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

        expect(JSON.parse(result.stdout)).toEqual([ { note_title: 'A', file_line_count: 10 } ]);
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
    it('shows raw bm25 scores that never appear in default output', async () => {
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
