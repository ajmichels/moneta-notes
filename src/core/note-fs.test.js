import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { titleToPath, pathToTitle, stripMdExtension, countLines } from './note-fs.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-note-fs-test-'));
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
