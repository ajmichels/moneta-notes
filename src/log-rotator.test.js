import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldRotate } from './log-rotator.js';

const tempDirs = [];

function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-rotator-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('shouldRotate: size threshold', () => {
    it('returns false for a file below the size threshold', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'small');

        expect(shouldRotate(filePath, { maxSizeBytes: 1024, maxAgeMs: Infinity })).toBe(false);
    });

    it('returns true for a file at or above the size threshold', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, Buffer.alloc(2048));

        expect(shouldRotate(filePath, { maxSizeBytes: 1024, maxAgeMs: Infinity })).toBe(true);
    });

    it('returns false when the file does not exist', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'missing.log');

        expect(shouldRotate(filePath, { maxSizeBytes: 1024, maxAgeMs: Infinity })).toBe(false);
    });
});

describe('shouldRotate: age threshold', () => {
    it('returns true for a file older than the age threshold even if small', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'small');

        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        utimesSync(filePath, eightDaysAgo, eightDaysAgo);

        expect(
            shouldRotate(filePath, {
                maxSizeBytes: 10 * 1024 * 1024,
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
            }),
        ).toBe(true);
    });

    it('returns false for a small, recently modified file', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'small');

        expect(
            shouldRotate(filePath, {
                maxSizeBytes: 10 * 1024 * 1024,
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
            }),
        ).toBe(false);
    });
});
