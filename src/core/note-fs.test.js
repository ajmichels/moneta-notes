import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    titleToPath, pathToTitle, stripMdExtension, countLines, stripCodeRegions,
    buildTitleIndex, resolveAgainstIndex, resolveTitle, resolveVaultPath, loadIgnoreMatcher,
} from './note-fs.js';
import { openDb } from './db.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-note-fs-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('titleToPath / pathToTitle', () => {
    it('resolves a flat title to a vault-relative .md path', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, 'Some Note')).toBe(join(vaultRoot, 'Some Note.md'));
    });

    it('resolves a folder-prefixed title (e.g. Weekly Notes/2026-W32)', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, 'Weekly Notes/2026-W32')).toBe(
            join(vaultRoot, 'Weekly Notes', '2026-W32.md'),
        );
    });

    it('round-trips a path back to the original title', () => {
        const vaultRoot = makeTempVault();
        const title = 'Weekly Notes/2026-W32';
        expect(pathToTitle(vaultRoot, titleToPath(vaultRoot, title))).toBe(title);
    });

    it('rejects a title whose ../ segments escape the vault', () => {
        const vaultRoot = makeTempVault();
        expect(() => titleToPath(vaultRoot, '../../../../tmp/pwned')).toThrow(/outside the vault/);
    });

    it('rejects a title that escapes by exactly one level', () => {
        const vaultRoot = makeTempVault();
        expect(() => titleToPath(vaultRoot, '../pwned')).toThrow(/outside the vault/);
    });

    it('rejects an absolute-looking title (still resolved relative to vaultRoot, but rejects if it escapes)', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, '/etc/passwd')).toBe(join(vaultRoot, 'etc', 'passwd.md'));
    });

    it('allows a title that legitimately contains ".." as part of a longer segment', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, 'Notes on 1..2 scaling')).toBe(
            join(vaultRoot, 'Notes on 1..2 scaling.md'),
        );
    });
});

describe('resolveVaultPath', () => {
    it('joins vaultRoot and a relative path with no extension appended', () => {
        const vaultRoot = makeTempVault();
        expect(resolveVaultPath(vaultRoot, 'Attachments/receipt.pdf')).toBe(
            join(vaultRoot, 'Attachments', 'receipt.pdf'),
        );
    });

    it('rejects a relative path whose ../ segments escape the vault', () => {
        const vaultRoot = makeTempVault();
        expect(() => resolveVaultPath(vaultRoot, '../../../../tmp/pwned')).toThrow(/outside the vault/);
    });

    it('is what titleToPath is now built on', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, 'Some Note')).toBe(resolveVaultPath(vaultRoot, 'Some Note.md'));
    });
});

describe('stripMdExtension', () => {
    it('strips a .md suffix from an already vault-relative path', () => {
        expect(stripMdExtension('Weekly Notes/2026-W32.md')).toBe('Weekly Notes/2026-W32');
    });

    it('is a no-op when there is no .md suffix', () => {
        expect(stripMdExtension('Weekly Notes/2026-W32')).toBe('Weekly Notes/2026-W32');
    });

    it('is what pathToTitle is built on, for a path already relative to vault root', () => {
        const vaultRoot = makeTempVault();
        const absPath = titleToPath(vaultRoot, 'A/B');
        expect(pathToTitle(vaultRoot, absPath)).toBe(stripMdExtension('A/B.md'));
    });
});

describe('countLines', () => {
    it('counts 0 lines for empty content', () => {
        expect(countLines('')).toBe(0);
    });

    it('counts lines with no trailing newline', () => {
        expect(countLines('a\nb\nc')).toBe(3);
    });

    it('does not count a trailing newline as an extra line', () => {
        expect(countLines('a\nb\nc\n')).toBe(3);
    });
});

describe('stripCodeRegions', () => {
    it('blanks a fenced code block, preserving surrounding text and offsets', () => {
        const body = 'before\n```js\nconst x = 1;\n```\nafter';
        const stripped = stripCodeRegions(body);
        expect(stripped).not.toContain('const x');
        expect(stripped).toContain('before');
        expect(stripped).toContain('after');
        expect(stripped.length).toBe(body.length);
    });

    it('blanks an inline code span, preserving offsets', () => {
        const body = 'the tag syntax is `#project` written like that';
        const stripped = stripCodeRegions(body);
        expect(stripped).not.toContain('#project');
        expect(stripped.length).toBe(body.length);
    });

    it('leaves text with no code regions untouched', () => {
        expect(stripCodeRegions('plain text, no code here')).toBe('plain text, no code here');
    });
});

function insertNote(db, path) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'hash', 1, 1000, 1000);
}

describe('buildTitleIndex / resolveAgainstIndex / resolveTitle', () => {
    it('resolves an exact title match without consulting basenames', () => {
        const { db } = openDb(':memory:');
        insertNote(db, 'Weekly Notes/2026-W32.md');

        expect(resolveTitle(db, 'Weekly Notes/2026-W32')).toBe('Weekly Notes/2026-W32');
        db.close();
    });

    it('resolves a bare basename to the one note that has it', () => {
        const { db } = openDb(':memory:');
        insertNote(db, 'LoonStateHockey/JMS Hockey/Barbara Garn.md');

        expect(resolveTitle(db, 'Barbara Garn')).toBe('LoonStateHockey/JMS Hockey/Barbara Garn');
        db.close();
    });

    it('returns null for a basename shared by more than one note (ambiguous)', () => {
        const { db } = openDb(':memory:');
        insertNote(db, 'A/Notes.md');
        insertNote(db, 'B/Notes.md');

        expect(resolveTitle(db, 'Notes')).toBeNull();
        db.close();
    });

    it('returns null when nothing matches at all', () => {
        const { db } = openDb(':memory:');
        insertNote(db, 'Something.md');

        expect(resolveTitle(db, 'Nothing Like It')).toBeNull();
        db.close();
    });

    it('prefers an exact title match over a basename that happens to collide with it', () => {
        const { db } = openDb(':memory:');
        insertNote(db, 'Foo/Bar.md');
        insertNote(db, 'Bar.md');

        expect(resolveTitle(db, 'Bar')).toBe('Bar.md'.replace(/\.md$/, ''));
        db.close();
    });

    it('resolveAgainstIndex reuses a single built index across multiple lookups', () => {
        const { db } = openDb(':memory:');
        insertNote(db, 'X/Target.md');
        const index = buildTitleIndex(db);

        expect(resolveAgainstIndex(index, 'Target')).toBe('X/Target');
        expect(resolveAgainstIndex(index, 'Nope')).toBeNull();
        db.close();
    });
});

describe('loadIgnoreMatcher', () => {
    it('ignores nothing when the vault has no .mnotesignore file', () => {
        const vaultRoot = makeTempVault();
        const matcher = loadIgnoreMatcher(vaultRoot);

        expect(matcher.ignores('Templates/Daily Note.md')).toBe(false);
    });

    it('matches a plain-folder pattern against files nested under it', () => {
        const vaultRoot = makeTempVault();
        writeFileSync(join(vaultRoot, '.mnotesignore'), 'Templates/\n');

        const matcher = loadIgnoreMatcher(vaultRoot);

        expect(matcher.ignores('Templates/Daily Note.md')).toBe(true);
        expect(matcher.ignores(`${'Templates'}/`)).toBe(true);
        expect(matcher.ignores('Weekly Notes/2026-W32.md')).toBe(false);
    });

    it('supports gitignore-style comments, blank lines, and negation', () => {
        const vaultRoot = makeTempVault();
        writeFileSync(
            join(vaultRoot, '.mnotesignore'),
            '# ignore all templates except one\nTemplates/*\n!Templates/Extraction.md\n',
        );

        const matcher = loadIgnoreMatcher(vaultRoot);

        expect(matcher.ignores('Templates/Daily Note.md')).toBe(true);
        expect(matcher.ignores('Templates/Extraction.md')).toBe(false);
    });
});
