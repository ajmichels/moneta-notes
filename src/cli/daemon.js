import { startDaemonService, stopDaemonService, restartDaemonService } from '../platform/index.js';

const SUBCOMMANDS = {
    start: { run: startDaemonService, verb: 'started' },
    stop: { run: stopDaemonService, verb: 'stopped' },
    restart: { run: restartDaemonService, verb: 'restarted' },
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
