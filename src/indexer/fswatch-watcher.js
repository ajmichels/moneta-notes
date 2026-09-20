import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getContextLogger } from '../logger.js';
import { watcherInstallHint } from '../platform/index.js';

export const DEFAULT_BACKOFF_SCHEDULE_MS = [ 30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000 ];

export function assertFswatchAvailable(env = process.env) {
    try {
        execFileSync('fswatch', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`fswatch not found — install via \`${watcherInstallHint()}\``, { cause: error });
        }
        throw error;
    }
}

// `watchedPath` is any directory, not necessarily the vault root — S005's per-symlink-directory
// watchers pass the symlink's own path here too, one process per currently-known symlinked
// directory (a single recursive watch on the vault root never sees changes inside one — see S005).
// `vaultName` (S009) is which configured vault this watcher belongs to — null for a caller (e.g. a
// test) that doesn't care, never omitted by the daemon's own per-vault startup loop.
export function spawnFswatch(watchedPath, onPath, vaultName = null) {
    assertFswatchAvailable();
    const child = spawn('fswatch', [ '-r', watchedPath ]);
    getContextLogger().info('fswatch watcher started', { vault: vaultName, watched_path: watchedPath });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
        const path = line.trim();
        if (path.length > 0) {
            onPath(path);
        }
    });
    return child;
}

// Exit-triggered respawn with exponential backoff (S005), reusing backoffSchedule rather than a
// second schedule of its own — same as the queue drainer's retries. `isStillValid` lets a
// per-symlink watcher bow out quietly once its target's gone, deferring to live-removal teardown.
function createRespawnScheduler({ watchedPath, backoffSchedule, isStillValid, scheduleFn, spawnChild, vaultName }) {
    let attemptCount = 0;
    let timer = null;

    function scheduleNext() {
        if (!isStillValid()) {
            return;
        }
        if (attemptCount > backoffSchedule.length) {
            getContextLogger().error('fswatch watcher permanently failed', {
                vault: vaultName, watched_path: watchedPath, attempts: attemptCount,
            });
            return;
        }
        const delay = backoffSchedule[attemptCount - 1];
        getContextLogger().warn('fswatch watcher exited unexpectedly', {
            vault: vaultName, watched_path: watchedPath, attempt: attemptCount, next_attempt_at: Date.now() + delay,
        });
        timer = scheduleFn(() => {
            try {
                spawnChild();
            } catch {
                attemptCount += 1;
                scheduleNext();
            }
        }, delay);
    }

    return {
        notifyExit() {
            attemptCount += 1;
            scheduleNext();
        },
        cancel(cancelFn) {
            if (timer !== null) {
                cancelFn(timer);
            }
        },
    };
}

// Wraps spawnFswatch with the scheduler above so a killed/crashed child (main or per-symlink) no
// longer leaves the daemon silently blind until a manual restart. `spawnFn`/`scheduleFn`/`cancelFn`
// are injectable (matching createDebouncer) so tests can drive this without a real binary/timers.
export function createResilientWatcher(watchedPath, onRawPath, options = {}) {
    const {
        backoffSchedule = DEFAULT_BACKOFF_SCHEDULE_MS,
        isStillValid = () => true,
        spawnFn = spawnFswatch,
        scheduleFn = setTimeout,
        cancelFn = clearTimeout,
        vaultName = null,
    } = options;

    let stopped = false;
    let child = null;

    function spawnChild() {
        child = spawnFn(watchedPath, onRawPath, vaultName);
        child.on('exit', () => {
            if (!stopped) {
                respawner.notifyExit();
            }
        });
    }

    const respawner = createRespawnScheduler({
        watchedPath, backoffSchedule, isStillValid, scheduleFn, spawnChild, vaultName,
    });
    spawnChild();

    return {
        stop() {
            stopped = true;
            respawner.cancel(cancelFn);
            if (child !== null) {
                child.kill();
            }
        },
    };
}
