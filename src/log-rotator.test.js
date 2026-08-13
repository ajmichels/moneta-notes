import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldRotate, rotateLogFile } from './log-rotator.js';

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

describe('rotateLogFile', () => {
    it('shifts numbered files up by one and recreates an empty active file', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'active content');
        writeFileSync(`${filePath}.1`, 'rotated-1');
        writeFileSync(`${filePath}.2`, 'rotated-2');

        rotateLogFile(filePath, 5);

        expect(readFileSync(filePath, 'utf8')).toBe('');
        expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('active content');
        expect(readFileSync(`${filePath}.2`, 'utf8')).toBe('rotated-1');
        expect(readFileSync(`${filePath}.3`, 'utf8')).toBe('rotated-2');
    });

    it('deletes the oldest file beyond the keep count', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'active content');
        for (let n = 1; n <= 5; n += 1) {
            writeFileSync(`${filePath}.${n}`, `rotated-${n}`);
        }

        rotateLogFile(filePath, 5);

        expect(existsSync(`${filePath}.6`)).toBe(false);
        expect(readFileSync(`${filePath}.5`, 'utf8')).toBe('rotated-4');
        expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('active content');
    });
});
