import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../platform/index.js', () => ({
    startDaemonService: vi.fn(),
    stopDaemonService: vi.fn(),
    restartDaemonService: vi.fn(),
}));

const { startDaemonService, stopDaemonService, restartDaemonService } = await import('../platform/index.js');
const { runDaemonCommand } = await import('./daemon.js');

beforeEach(() => {
    startDaemonService.mockReset();
    stopDaemonService.mockReset();
    restartDaemonService.mockReset();
});

describe('runDaemonCommand', () => {
    it('dispatches start/stop/restart to the platform module and reports the outcome', async () => {
        const deps = { execFileFn: vi.fn() };

        await expect(runDaemonCommand([ 'start' ], deps)).resolves.toEqual({
            stdout: 'daemon started\n', stderr: '', exitCode: 0,
        });
        expect(startDaemonService).toHaveBeenCalledWith(deps);

        await expect(runDaemonCommand([ 'stop' ], deps)).resolves.toEqual({
            stdout: 'daemon stopped\n', stderr: '', exitCode: 0,
        });
        expect(stopDaemonService).toHaveBeenCalledWith(deps);

        await expect(runDaemonCommand([ 'restart' ], deps)).resolves.toEqual({
            stdout: 'daemon restarted\n', stderr: '', exitCode: 0,
        });
        expect(restartDaemonService).toHaveBeenCalledWith(deps);
    });

    it('errors with a usage hint when no subcommand is given', async () => {
        const result = await runDaemonCommand([], {});
        expect(result).toEqual({
            stdout: '', stderr: 'mnotes: daemon requires a subcommand (start|stop|restart)\n', exitCode: 1,
        });
        expect(startDaemonService).not.toHaveBeenCalled();
    });

    it('errors on an unknown subcommand without touching the platform module', async () => {
        const result = await runDaemonCommand([ 'frobnicate' ], {});
        expect(result).toEqual({ stdout: '', stderr: 'mnotes: unknown daemon subcommand "frobnicate"\n', exitCode: 1 });
        expect(startDaemonService).not.toHaveBeenCalled();
        expect(stopDaemonService).not.toHaveBeenCalled();
        expect(restartDaemonService).not.toHaveBeenCalled();
    });

    it('propagates a platform-module failure as a rejected promise for dispatch() to catch', async () => {
        stopDaemonService.mockRejectedValueOnce(new Error('No such process'));
        await expect(runDaemonCommand([ 'stop' ], {})).rejects.toThrow(/No such process/);
    });
});
