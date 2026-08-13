import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
