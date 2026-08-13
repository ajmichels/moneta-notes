import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
    dispatch, resolveVaultRoot, resolveDbPath, registerCommand, runSearch, runGrep, runTags,
} from './main.js';
import { openDb } from '../core/db.js';
import { syncNoteTags } from '../core/tags.js';

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
    it('throws a descriptive error when MNOTES_VAULT_ROOT is not set', () => {
        expect(() => resolveVaultRoot({})).toThrow(/MNOTES_VAULT_ROOT/);
    });

    it('returns the env value when set', () => {
        expect(resolveVaultRoot({ MNOTES_VAULT_ROOT: '/tmp/vault' })).toBe('/tmp/vault');
    });
});

describe('resolveDbPath', () => {
    it('falls back to the documented Application Support default when unset', () => {
        expect(resolveDbPath({})).toBe(
            join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db'),
        );
    });

    it('returns MNOTES_DB_PATH when set', () => {
        expect(resolveDbPath({ MNOTES_DB_PATH: '/tmp/index.db' })).toBe('/tmp/index.db');
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
        expect(result.stdout).toBe('note_title|file_line_count\nA|10');
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
    it('formats a text match by default', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'line one\nsome hello world text\n');

        const result = await runGrep([ 'hello' ], { vaultRoot });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('note_title|file_line_count|line_matches');
        expect(result.stdout).toContain('Recipe|3|L2: some hello world text');
    });

    it('supports --json', async () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, 'Recipe.md'), 'hello world\n');

        const result = await runGrep([ 'hello', '--json' ], { vaultRoot });

        expect(JSON.parse(result.stdout)[0].note_title).toBe('Recipe');
    });
});

describe('runTags', () => {
    it('list: formats tag inventory', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'list' ], { db });

        expect(result.stdout).toBe('tag|notes_with_tag\nproject|1');
        db.close();
    });

    it('notes <tag>: formats notes carrying that tag', async () => {
        const { db } = openDb(':memory:');
        const noteId = insertTestNote(db, 'A.md', 7);
        syncNoteTags(db, noteId, [ 'project' ]);

        const result = await runTags([ 'notes', 'project' ], { db });

        expect(result.stdout).toBe('note_title|file_line_count\nA|7');
        db.close();
    });

    it('returns an error for an unknown tags subcommand', async () => {
        const result = await runTags([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown tags subcommand "bogus"/);
    });
});
