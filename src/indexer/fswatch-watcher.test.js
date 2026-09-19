import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { assertFswatchAvailable, spawnFswatch, createResilientWatcher } from './fswatch-watcher.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-fswatch-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

function writeNote(vaultRoot, relativePath, content, mtimeSec) {
    const filePath = join(vaultRoot, relativePath);
    writeFileSync(filePath, content, 'utf8');
    if (mtimeSec !== undefined) {
        utimesSync(filePath, mtimeSec, mtimeSec);
    }
    return filePath;
}

describe('assertFswatchAvailable', () => {
    it('does not throw when fswatch is resolvable on PATH', () => {
        expect(() => assertFswatchAvailable()).not.toThrow();
    });

    it('throws an actionable error when fswatch is not on PATH', () => {
        expect(() => assertFswatchAvailable({ PATH: '' })).toThrow(/fswatch not found/);
    });
});

describe('spawnFswatch (real binary)', () => {
    it('reports a path when a file changes under the watched directory', async () => {
        const vaultRoot = makeTempVault();

        const seenPaths = await new Promise((resolve, reject) => {
            const found = [];
            // Both timers below fire (or are cancelled) as a pair — without clearing the loser, an
            // early resolve (the fswatch event usually arrives well before 300ms) leaves the
            // writeNote timer pending, firing after afterEach() has already removed the vault.
            const timers = [];
            function settle(result) {
                for (const timer of timers) clearTimeout(timer);
                resolve(result);
            }
            const child = spawnFswatch(vaultRoot, (path) => {
                found.push(path);
                child.kill();
                settle(found);
            });
            child.on('error', reject);
            timers.push(setTimeout(() => writeNote(vaultRoot, 'Triggered.md', 'content', undefined), 300));
            timers.push(setTimeout(() => { child.kill(); settle(found); }, 5000));
        });

        expect(seenPaths.length).toBeGreaterThan(0);
    }, 10000);
});

describe('createResilientWatcher', () => {
    function fakeChild() {
        const child = new EventEmitter();
        child.kill = vi.fn();
        return child;
    }

    it('spawns once immediately via spawnFn', () => {
        const spawnFn = vi.fn(() => fakeChild());

        createResilientWatcher('/some/path', () => {}, { spawnFn, scheduleFn: () => {}, cancelFn: () => {} });

        expect(spawnFn).toHaveBeenCalledWith('/some/path', expect.any(Function));
        expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('schedules a respawn on the backoff schedule after an unexpected exit', () => {
        let currentChild = fakeChild();
        const spawnFn = vi.fn(() => currentChild);
        const scheduled = [];
        const scheduleFn = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };

        createResilientWatcher('/p', () => {}, {
            spawnFn, scheduleFn, cancelFn: () => {}, backoffSchedule: [ 100, 200, 300 ],
        });
        currentChild.emit('exit');

        expect(scheduled).toEqual([ { fn: expect.any(Function), ms: 100 } ]);
        expect(spawnFn).toHaveBeenCalledTimes(1);

        currentChild = fakeChild();
        scheduled[0].fn();
        expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    it('escalates through the full backoff schedule then gives up without spawning again', () => {
        let currentChild = fakeChild();
        const spawnFn = vi.fn(() => currentChild);
        const scheduled = [];
        const scheduleFn = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };

        createResilientWatcher('/p', () => {}, {
            spawnFn, scheduleFn, cancelFn: () => {}, backoffSchedule: [ 10, 20, 30 ],
        });

        for (let i = 0; i < 3; i += 1) {
            currentChild.emit('exit');
            const next = scheduled[scheduled.length - 1];
            currentChild = fakeChild();
            next.fn();
        }
        expect(spawnFn).toHaveBeenCalledTimes(4); // initial spawn + 3 respawns
        expect(scheduled.map((s) => s.ms)).toEqual([ 10, 20, 30 ]);

        currentChild.emit('exit'); // 4th death — schedule exhausted, gives up
        expect(scheduled).toHaveLength(3);
        expect(spawnFn).toHaveBeenCalledTimes(4);
    });

    it('treats a synchronous spawnFn throw (e.g. fswatch missing) as another failed attempt', () => {
        let attempt = 0;
        const spawnFn = vi.fn(() => {
            attempt += 1;
            if (attempt === 1) {
                return fakeChild();
            }
            throw new Error('fswatch not found');
        });
        const scheduled = [];
        const scheduleFn = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };

        createResilientWatcher('/p', () => {}, {
            spawnFn, scheduleFn, cancelFn: () => {}, backoffSchedule: [ 10, 20 ],
        });
        spawnFn.mock.results[0].value.emit('exit');
        expect(scheduled).toHaveLength(1);

        scheduled[0].fn(); // spawnFn throws synchronously here
        expect(scheduled).toHaveLength(2);
        expect(scheduled[1].ms).toBe(20);
    });

    it('does not respawn after stop(), even if the child exits afterward', () => {
        const child = fakeChild();
        const spawnFn = vi.fn(() => child);
        const scheduleFn = vi.fn();

        const watcher = createResilientWatcher('/p', () => {}, { spawnFn, scheduleFn, cancelFn: vi.fn() });
        watcher.stop();
        child.emit('exit');

        expect(scheduleFn).not.toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalled();
    });

    it('stops trying once isStillValid reports the target is gone, without scheduling a retry', () => {
        const child = fakeChild();
        const spawnFn = vi.fn(() => child);
        const scheduleFn = vi.fn();

        createResilientWatcher('/p', () => {}, {
            spawnFn, scheduleFn, cancelFn: () => {}, isStillValid: () => false,
        });
        child.emit('exit');

        expect(scheduleFn).not.toHaveBeenCalled();
    });
});
