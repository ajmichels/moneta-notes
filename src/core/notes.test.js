import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { titleToPath, pathToTitle, hashContent, countLines } from './notes.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
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
});

describe('hashContent', () => {
    it('returns a 40-char SHA-1 hex digest', () => {
        expect(hashContent('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('produces different hashes for different content', () => {
        expect(hashContent('a')).not.toBe(hashContent('b'));
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
