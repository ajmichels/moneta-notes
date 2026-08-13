import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRipgrepAvailable, grep } from './grep.js';
import { getLogger, runWithLogger } from '../logger.js';

const tempDirs = [];

function makeTempVault(files) {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-grep-test-'));
    tempDirs.push(dir);
    for (const [ relPath, content ] of Object.entries(files)) {
        writeFileSync(join(dir, relPath), content);
    }
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('assertRipgrepAvailable', () => {
    it('does not throw when rg is resolvable on PATH', () => {
        expect(() => assertRipgrepAvailable()).not.toThrow();
    });

    it('throws an actionable error when rg is not on PATH', () => {
        expect(() => assertRipgrepAvailable({ PATH: '' })).toThrow(/ripgrep not found/);
    });

    it('logs a warn line via the context logger before throwing', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-grep-test-log-'));
        const logger = getLogger('mcp-server', logDir);

        expect(() =>
            runWithLogger(logger, () => assertRipgrepAvailable({ PATH: '' })),
        ).toThrow(/ripgrep not found/);

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('WARN  [mcp-server] ripgrep not found on PATH');
        });
        rmSync(logDir, { recursive: true, force: true });
    });

    it('does not log when rg is resolvable (no enclosing context either way)', () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-grep-test-log-'));
        const logger = getLogger('mcp-server', logDir);

        runWithLogger(logger, () => assertRipgrepAvailable());

        expect(existsSync(join(logDir, 'mcp-server.log'))).toBe(false);
        rmSync(logDir, { recursive: true, force: true });
    });
});

describe('grep', () => {
    it('finds a literal match in a single note', () => {
        const vaultRoot = makeTempVault({
            'Recipe.md': 'line one\nsome hello world text\nline three\n',
        });

        const results = grep(vaultRoot, 'hello');

        expect(results).toHaveLength(1);
        expect(results[0].noteTitle).toBe('Recipe');
        expect(results[0].fileLineCount).toBe(3);
        expect(results[0].lineMatches).toEqual([ { line: 2, text: 'some hello world text' } ]);
        expect(results[0].totalMatchCount).toBe(1);
    });

    it('excludes frontmatter from fileLineCount, matching core/notes.js elsewhere', () => {
        const vaultRoot = makeTempVault({
            'Recipe.md': '---\nid: Recipe\ntags:\n  - food\n---\nhello world\nsecond line\n',
        });

        const results = grep(vaultRoot, 'hello');

        expect(results[0].fileLineCount).toBe(2);
    });
});

describe('grep: glob restriction', () => {
    it('only searches .md files and returns one row per matching note', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'first note mentions apple\n',
            'B.md': 'second note also mentions apple pie\n',
            'notes.txt': 'this is not a note but also mentions apple\n',
        });

        const results = grep(vaultRoot, 'apple');
        const titles = results.map(r => r.noteTitle).sort();

        expect(titles).toEqual([ 'A', 'B' ]);
    });
});

describe('grep: regex option', () => {
    it('matches literally by default even with regex metacharacters in the pattern', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'price is $5.00 exactly\n',
            'B.md': 'price is $5x00 which should not match the literal pattern\n',
        });

        const results = grep(vaultRoot, '5.00');

        expect(results.map(r => r.noteTitle)).toEqual([ 'A' ]);
    });

    it('treats the pattern as a regex when regex: true', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'price is $5.00 exactly\n',
            'B.md': 'price is $5x00 which should match the regex pattern\n',
        });

        const results = grep(vaultRoot, '5.00', { regex: true });

        expect(results.map(r => r.noteTitle).sort()).toEqual([ 'A', 'B' ]);
    });

    it('throws a descriptive error for an invalid regex pattern', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'hello\n' });

        expect(() => grep(vaultRoot, '(unclosed', { regex: true })).toThrow(/ripgrep failed/);
    });
});

describe('grep: smart-case', () => {
    it('matches any casing when the pattern is all-lowercase', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'calling the API directly\n' });

        const results = grep(vaultRoot, 'api');

        expect(results).toHaveLength(1);
    });

    it('narrows to exact casing when the pattern contains an uppercase letter', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'calling the API directly\n',
            'B.md': 'calling the api directly\n',
        });

        const results = grep(vaultRoot, 'API');

        expect(results.map(r => r.noteTitle)).toEqual([ 'A' ]);
    });
});

describe('grep: note_title scoping', () => {
    it('searches only the resolved note when noteTitle is given', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'apple pie recipe\n',
            'B.md': 'apple crumble recipe\n',
        });

        const results = grep(vaultRoot, 'apple', { noteTitle: 'A' });

        expect(results).toHaveLength(1);
        expect(results[0].noteTitle).toBe('A');
    });

    it('throws when the given note title does not resolve to a file', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'apple pie recipe\n' });

        expect(() => grep(vaultRoot, 'apple', { noteTitle: 'Nonexistent' })).toThrow(/note not found/);
    });
});

describe('grep: line-match cap', () => {
    it('caps lineMatches at 10 per note but reports the true total', () => {
        const lines = Array.from({ length: 15 }, (_, i) => `apple mention number ${i}`);
        const vaultRoot = makeTempVault({ 'A.md': `${lines.join('\n')}\n` });

        const results = grep(vaultRoot, 'apple');

        expect(results).toHaveLength(1);
        expect(results[0].lineMatches).toHaveLength(10);
        expect(results[0].totalMatchCount).toBe(15);
    });

    it('accepts a custom lineMatchCap', () => {
        const lines = Array.from({ length: 15 }, (_, i) => `apple mention number ${i}`);
        const vaultRoot = makeTempVault({ 'A.md': `${lines.join('\n')}\n` });

        const results = grep(vaultRoot, 'apple', { lineMatchCap: 3 });

        expect(results[0].lineMatches).toHaveLength(3);
        expect(results[0].totalMatchCount).toBe(15);
    });
});

describe('grep: zero matches', () => {
    it('returns an empty array when nothing matches, instead of throwing', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'nothing relevant here\n' });

        const results = grep(vaultRoot, 'no-such-term-anywhere');

        expect(results).toEqual([]);
    });
});
