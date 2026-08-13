import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DAEMON_LABEL = 'com.ajmichels.mnotes';

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

export async function startDaemon(deps = {}) {
    const { plistPath = defaultPlistPath(), domain = defaultDomain(), execFileFn = execFileAsync } = deps;
    await runLaunchctl([ 'bootstrap', domain, plistPath ], execFileFn);
}

export async function stopDaemon(deps = {}) {
    const { serviceTarget = defaultServiceTarget(), execFileFn = execFileAsync } = deps;
    await runLaunchctl([ 'bootout', serviceTarget ], execFileFn);
}

export async function restartDaemon(deps = {}) {
    const { serviceTarget = defaultServiceTarget(), execFileFn = execFileAsync } = deps;
    await runLaunchctl([ 'kickstart', '-k', serviceTarget ], execFileFn);
}

const SUBCOMMANDS = {
    start: { run: startDaemon, verb: 'started' },
    stop: { run: stopDaemon, verb: 'stopped' },
    restart: { run: restartDaemon, verb: 'restarted' },
};

export async function runDaemonCommand(args, deps) {
    const [ sub ] = args;
    if (sub === undefined) {
        return { stdout: '', stderr: 'mnotes: daemon requires a subcommand (start|stop|restart)\n', exitCode: 1 };
    }
    const subcommand = SUBCOMMANDS[sub];
    if (!subcommand) {
        return { stdout: '', stderr: `mnotes: unknown daemon subcommand "${sub}"\n`, exitCode: 1 };
    }
    await subcommand.run(deps);
    return { stdout: `daemon ${subcommand.verb}\n`, stderr: '', exitCode: 0 };
}
