import { describe, it, expect, vi } from 'vitest';
import {
    startDaemon, stopDaemon, restartDaemon, runDaemonCommand,
    defaultPlistPath, defaultDomain, defaultServiceTarget, DAEMON_LABEL,
} from './daemon.js';

function fakeExecFile(impl = async () => {}) {
    return vi.fn(impl);
}

describe('defaultPlistPath / defaultDomain / defaultServiceTarget', () => {
    it('builds a domain and service target from the given uid and daemon label', () => {
        expect(defaultDomain(501)).toBe('gui/501');
        expect(defaultServiceTarget(501)).toBe(`gui/501/${DAEMON_LABEL}`);
        expect(defaultPlistPath()).toContain(`${DAEMON_LABEL}.plist`);
    });
});

describe('startDaemon', () => {
    it('bootstraps the plist into the gui domain', async () => {
        const execFileFn = fakeExecFile();
        await startDaemon({ plistPath: '/tmp/x.plist', domain: 'gui/501', execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('launchctl', [ 'bootstrap', 'gui/501', '/tmp/x.plist' ]);
    });

    it('surfaces launchctl stderr in a descriptive error', async () => {
        const execFileFn = fakeExecFile(async () => {
            const err = new Error('Command failed');
            err.stderr = 'Bootstrap failed: 5: Input/output error';
            throw err;
        });
        await expect(startDaemon({ plistPath: '/tmp/x.plist', domain: 'gui/501', execFileFn }))
            .rejects.toThrow(/Bootstrap failed/);
    });
});

describe('stopDaemon', () => {
    it('boots the service out of the gui domain', async () => {
        const execFileFn = fakeExecFile();
        await stopDaemon({ serviceTarget: `gui/501/${DAEMON_LABEL}`, execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('launchctl', [ 'bootout', `gui/501/${DAEMON_LABEL}` ]);
    });
});

describe('restartDaemon', () => {
    it('kickstarts the service with -k', async () => {
        const execFileFn = fakeExecFile();
        await restartDaemon({ serviceTarget: `gui/501/${DAEMON_LABEL}`, execFileFn });
        expect(execFileFn).toHaveBeenCalledWith('launchctl', [ 'kickstart', '-k', `gui/501/${DAEMON_LABEL}` ]);
    });
});

describe('runDaemonCommand', () => {
    it('dispatches start/stop/restart and reports the outcome', async () => {
        const execFileFn = fakeExecFile();
        const deps = { plistPath: '/tmp/x.plist', domain: 'gui/501', serviceTarget: `gui/501/${DAEMON_LABEL}`, execFileFn };

        await expect(runDaemonCommand([ 'start' ], deps)).resolves.toEqual({
            stdout: 'daemon started\n', stderr: '', exitCode: 0,
        });
        await expect(runDaemonCommand([ 'stop' ], deps)).resolves.toEqual({
            stdout: 'daemon stopped\n', stderr: '', exitCode: 0,
        });
        await expect(runDaemonCommand([ 'restart' ], deps)).resolves.toEqual({
            stdout: 'daemon restarted\n', stderr: '', exitCode: 0,
        });
    });

    it('errors with a usage hint when no subcommand is given', async () => {
        const execFileFn = fakeExecFile();
        const result = await runDaemonCommand([], { execFileFn });
        expect(result).toEqual({
            stdout: '', stderr: 'mnotes: daemon requires a subcommand (start|stop|restart)\n', exitCode: 1,
        });
        expect(execFileFn).not.toHaveBeenCalled();
    });

    it('errors on an unknown subcommand without touching launchctl', async () => {
        const execFileFn = fakeExecFile();
        const result = await runDaemonCommand([ 'frobnicate' ], { execFileFn });
        expect(result).toEqual({ stdout: '', stderr: 'mnotes: unknown daemon subcommand "frobnicate"\n', exitCode: 1 });
        expect(execFileFn).not.toHaveBeenCalled();
    });

    it('propagates a launchctl failure as a rejected promise for dispatch() to catch', async () => {
        const execFileFn = fakeExecFile(async () => {
            const err = new Error('Command failed');
            err.stderr = 'No such process';
            throw err;
        });
        await expect(runDaemonCommand([ 'stop' ], { execFileFn })).rejects.toThrow(/No such process/);
    });
});
