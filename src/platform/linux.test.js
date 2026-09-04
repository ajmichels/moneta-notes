import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
    appSupportDir, logDir, daemonServiceName,
    startDaemonService, stopDaemonService, restartDaemonService,
    DAEMON_SERVICE_NAME, watcherInstallHint, ripgrepInstallHint,
} from './linux.js';

function fakeExecFile(impl = async () => {}) {
    return vi.fn(impl);
}

let savedDataHome;
let savedStateHome;

beforeEach(() => {
    savedDataHome = process.env.XDG_DATA_HOME;
    savedStateHome = process.env.XDG_STATE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
});

afterEach(() => {
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedDataHome;
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedStateHome;
});

describe('appSupportDir', () => {
    it('falls back to ~/.local/share/mnotes when XDG_DATA_HOME is unset', () => {
        expect(appSupportDir()).toBe(join(homedir(), '.local', 'share', 'mnotes'));
    });

    it('honors XDG_DATA_HOME when set', () => {
        process.env.XDG_DATA_HOME = '/custom/data';
        expect(appSupportDir()).toBe(join('/custom/data', 'mnotes'));
    });
});

describe('logDir', () => {
    it('falls back to ~/.local/state/mnotes/log when XDG_STATE_HOME is unset', () => {
        expect(logDir()).toBe(join(homedir(), '.local', 'state', 'mnotes', 'log'));
    });

    it('honors XDG_STATE_HOME when set', () => {
        process.env.XDG_STATE_HOME = '/custom/state';
        expect(logDir()).toBe(join('/custom/state', 'mnotes', 'log'));
    });
});

describe('daemonServiceName', () => {
    it('is the systemd unit name', () => {
        expect(daemonServiceName()).toBe(DAEMON_SERVICE_NAME);
        expect(DAEMON_SERVICE_NAME).toBe('mnotes.service');
    });
});

describe('watcherInstallHint / ripgrepInstallHint', () => {
    it('point at distro package managers, not Homebrew', () => {
        expect(watcherInstallHint()).toMatch(/apt install fswatch/);
        expect(ripgrepInstallHint()).toMatch(/apt install ripgrep/);
    });
});

describe('startDaemonService', () => {
    it('starts the unit via systemctl --user', async () => {
        const execFileFn = fakeExecFile();
        await startDaemonService({ execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('systemctl', [ '--user', 'start', DAEMON_SERVICE_NAME ]);
    });

    it('surfaces systemctl stderr in a descriptive error', async () => {
        const execFileFn = fakeExecFile(async () => {
            const err = new Error('Command failed');
            err.stderr = 'Unit mnotes.service not found.';
            throw err;
        });
        await expect(startDaemonService({ execFileFn })).rejects.toThrow(/Unit mnotes.service not found/);
    });
});

describe('stopDaemonService', () => {
    it('stops the unit via systemctl --user', async () => {
        const execFileFn = fakeExecFile();
        await stopDaemonService({ execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('systemctl', [ '--user', 'stop', DAEMON_SERVICE_NAME ]);
    });
});

describe('restartDaemonService', () => {
    it('restarts the unit via systemctl --user', async () => {
        const execFileFn = fakeExecFile();
        await restartDaemonService({ execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('systemctl', [ '--user', 'restart', DAEMON_SERVICE_NAME ]);
    });

    it('accepts an overridden serviceName', async () => {
        const execFileFn = fakeExecFile();
        await restartDaemonService({ serviceName: 'other.service', execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('systemctl', [ '--user', 'restart', 'other.service' ]);
    });
});
