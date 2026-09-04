import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
    appSupportDir, logDir, daemonServiceName,
    startDaemonService, stopDaemonService, restartDaemonService,
    defaultPlistPath, defaultDomain, defaultServiceTarget, DAEMON_LABEL,
    watcherInstallHint, ripgrepInstallHint,
} from './darwin.js';

function fakeExecFile(impl = async () => {}) {
    return vi.fn(impl);
}

describe('appSupportDir / logDir', () => {
    it('points at the macOS Library conventions', () => {
        expect(appSupportDir()).toBe(join(homedir(), 'Library', 'Application Support', 'mnotes'));
        expect(logDir()).toBe(join(homedir(), 'Library', 'Logs', 'com.ajmichels.mnotes'));
    });
});

describe('daemonServiceName', () => {
    it('is the LaunchAgent label', () => {
        expect(daemonServiceName()).toBe(DAEMON_LABEL);
    });
});

describe('watcherInstallHint / ripgrepInstallHint', () => {
    it('point at Homebrew', () => {
        expect(watcherInstallHint()).toBe('brew install fswatch');
        expect(ripgrepInstallHint()).toBe('brew install ripgrep');
    });
});

describe('defaultPlistPath / defaultDomain / defaultServiceTarget', () => {
    it('builds a domain and service target from the given uid and daemon label', () => {
        expect(defaultDomain(501)).toBe('gui/501');
        expect(defaultServiceTarget(501)).toBe(`gui/501/${DAEMON_LABEL}`);
        expect(defaultPlistPath()).toContain(`${DAEMON_LABEL}.plist`);
    });
});

describe('startDaemonService', () => {
    it('bootstraps the plist into the gui domain', async () => {
        const execFileFn = fakeExecFile();
        await startDaemonService({ plistPath: '/tmp/x.plist', domain: 'gui/501', execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('launchctl', [ 'bootstrap', 'gui/501', '/tmp/x.plist' ]);
    });

    it('surfaces launchctl stderr in a descriptive error', async () => {
        const execFileFn = fakeExecFile(async () => {
            const err = new Error('Command failed');
            err.stderr = 'Bootstrap failed: 5: Input/output error';
            throw err;
        });
        await expect(startDaemonService({ plistPath: '/tmp/x.plist', domain: 'gui/501', execFileFn }))
            .rejects.toThrow(/Bootstrap failed/);
    });
});

describe('stopDaemonService', () => {
    it('boots the service out of the gui domain', async () => {
        const execFileFn = fakeExecFile();
        await stopDaemonService({ serviceTarget: `gui/501/${DAEMON_LABEL}`, execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('launchctl', [ 'bootout', `gui/501/${DAEMON_LABEL}` ]);
    });
});

describe('restartDaemonService', () => {
    it('kickstarts the service with -k', async () => {
        const execFileFn = fakeExecFile();
        await restartDaemonService({ serviceTarget: `gui/501/${DAEMON_LABEL}`, execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('launchctl', [ 'kickstart', '-k', `gui/501/${DAEMON_LABEL}` ]);
    });
});
