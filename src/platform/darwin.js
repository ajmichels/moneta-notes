import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DAEMON_LABEL = 'com.ajmichels.mnotes';

export function appSupportDir() {
    return join(homedir(), 'Library', 'Application Support', 'mnotes');
}

export function logDir() {
    return join(homedir(), 'Library', 'Logs', 'com.ajmichels.mnotes');
}

export function daemonServiceName() {
    return DAEMON_LABEL;
}

export function defaultPlistPath() {
    return join(homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
}

export function defaultDomain(uid = process.getuid()) {
    return `gui/${uid}`;
}

export function defaultServiceTarget(uid = process.getuid()) {
    return `${defaultDomain(uid)}/${DAEMON_LABEL}`;
}

async function runLaunchctl(args, execFileFn) {
    try {
        await execFileFn('launchctl', args);
    } catch (err) {
        const detail = (err.stderr || err.message || '').trim();
        throw new Error(`launchctl ${args.join(' ')} failed: ${detail}`, { cause: err });
    }
}

export async function startDaemonService(deps = {}) {
    const { plistPath = defaultPlistPath(), domain = defaultDomain(), execFileFn = execFileAsync } = deps;
    await runLaunchctl([ 'bootstrap', domain, plistPath ], execFileFn);
}

export async function stopDaemonService(deps = {}) {
    const { serviceTarget = defaultServiceTarget(), execFileFn = execFileAsync } = deps;
    await runLaunchctl([ 'bootout', serviceTarget ], execFileFn);
}

export async function restartDaemonService(deps = {}) {
    const { serviceTarget = defaultServiceTarget(), execFileFn = execFileAsync } = deps;
    await runLaunchctl([ 'kickstart', '-k', serviceTarget ], execFileFn);
}
