import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync as readAuditLog } from 'node:fs';
import { Readable } from 'node:stream';
import {
    dispatch, resolveVaultRoot, resolveDbPath, registerCommand, runSearch, runGrep, runTags, runRead,
    runWrite, runEdit, runAppend, runRename, runStats,
} from './main.js';
import { openDb } from '../core/db.js';
import { syncNoteTags } from '../core/tags.js';
import { getAuditLogger } from '../logger.js';
import { buildDefaultConfig } from '../config.js';

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

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

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
        expect(result.stdout).toBe('note_title|file_line_count\nA|10\n');
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

        expect(result.stdout).toContain('note_title|file_line_count|fulltext_rank|semantic_rank');
        expect(result.stdout).toContain('A|10|');
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

        expect(result.stdout).toContain('bm25=');
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
        expect(result.stdout).toContain('note_title|file_line_count|line_matches');
        expect(result.stdout).toContain('Recipe|2|L2');
        expect(result.stdout).not.toContain('hello world text');
    });

    it('includes match text with --content', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'line one\nsome hello world text\n');

        const result = await runGrep([ 'hello', '--content' ], { vaultRoot });

        expect(result.stdout).toContain('Recipe|2|L2: some hello world text');
    });

    it('supports --json', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello world\n');

        const result = await runGrep([ 'hello', '--json' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout)[0];
        expect(parsed.note_title).toBe('Recipe');
        expect(parsed.line_matches[0].text).toBeUndefined();
    });

    it('supports --json --content, including match text', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello world\n');

        const result = await runGrep([ 'hello', '--json', '--content' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout)[0];
        expect(parsed.line_matches[0].text).toBe('hello world');
    });
});

describe('runTags', () => {
    it('list: formats tag inventory', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'list' ], { db });

        expect(result.stdout).toBe('tag|notes_with_tag\nproject|1\n');
        db.close();
    });

    it('notes <tag>: formats notes carrying that tag', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 7);
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'notes', 'project' ], { db });

        expect(result.stdout).toBe('note_title|file_line_count\nA|7\n');
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

describe('runRead', () => {
    it('default mode: body on stdout, parsed metadata JSON on stderr', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', '---\nid: A\ntags:\n  - x\n---\nbody text');

        const result = await runRead([ 'A' ], { vaultRoot });

        expect(result.stdout).toBe('body text\n');
        expect(JSON.parse(result.stderr)).toEqual({ id: 'A', tags: [ 'x' ] });
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

    it('--json: full structured result including content_hash', async () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A.md', 'body text');

        const result = await runRead([ 'A', '--json' ], { vaultRoot });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.title).toBe('A');
        expect(typeof parsed.content_hash).toBe('string');
        expect(result.stderr).toBe('');
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
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] write');
            expect(lastLine).toContain('note_title="Existing"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=error');
            expect(lastLine).toMatch(/error_message=".*hash mismatch.*"/i);
        });
    });

    it('rejects invalid --metadata JSON with a descriptive error', async () => {
        const vaultRoot = makeTempVault();
        const auditLogger = getAuditLogger(makeTempVault());

        await expect(
            runWrite([ 'Bad Meta', '--content=x', '--metadata={not json' ], { vaultRoot, auditLogger }),
        ).rejects.toThrow(/--metadata is not valid JSON/);
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
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] edit');
            expect(lastLine).toContain('note_title="Editable"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=success');
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
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] edit');
            expect(lastLine).toContain('note_title="Ambiguous"');
            expect(lastLine).toContain('outcome=error');
            expect(lastLine).toMatch(/error_message=".*ambiguous.*"/i);
        });
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
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] append');
            expect(lastLine).toContain('note_title="Appendable"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=success');
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
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] rename');
            expect(lastLine).toContain('note_title="New Name"');
            expect(lastLine).toContain('source=cli');
            expect(lastLine).toContain('outcome=success');
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
            const lines = readAuditLog(join(logDir, 'audit.log'), 'utf8').trim().split('\n');
            const lastLine = lines[lines.length - 1];
            expect(lastLine).toContain('INFO  [audit] rename');
            expect(lastLine).toContain('note_title="Target"');
            expect(lastLine).toContain('outcome=error');
            expect(lastLine).toMatch(/error_message=".*already exists.*"/i);
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
