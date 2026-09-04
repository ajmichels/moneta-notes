import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DAEMON_SERVICE_NAME = 'mnotes.service';

export function appSupportDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    return join(base, 'mnotes');
}

export function logDir() {
    const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    return join(base, 'mnotes', 'log');
}

export function daemonServiceName() {
    return DAEMON_SERVICE_NAME;
}

async function runSystemctl(args, execFileFn) {
    try {
        await execFileFn('systemctl', [ '--user', ...args ]);
    } catch (err) {
        const detail = (err.stderr || err.message || '').trim();
        throw new Error(`systemctl --user ${args.join(' ')} failed: ${detail}`, { cause: err });
    }
}

export async function startDaemonService(deps = {}) {
    const { serviceName = DAEMON_SERVICE_NAME, execFileFn = execFileAsync } = deps;
    await runSystemctl([ 'start', serviceName ], execFileFn);
}

export async function stopDaemonService(deps = {}) {
    const { serviceName = DAEMON_SERVICE_NAME, execFileFn = execFileAsync } = deps;
    await runSystemctl([ 'stop', serviceName ], execFileFn);
}

export async function restartDaemonService(deps = {}) {
    const { serviceName = DAEMON_SERVICE_NAME, execFileFn = execFileAsync } = deps;
    await runSystemctl([ 'restart', serviceName ], execFileFn);
}
