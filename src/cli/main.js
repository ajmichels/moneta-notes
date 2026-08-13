#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveVaultRoot(env = process.env) {
    if (!env.MNOTES_VAULT_ROOT) {
        throw new Error(
            'MNOTES_VAULT_ROOT is not set — point it at your Obsidian vault directory '
            + '(stand-in for config.toml\'s vault_path until S009 lands)',
        );
    }
    return env.MNOTES_VAULT_ROOT;
}

export function resolveDbPath(env = process.env) {
    return env.MNOTES_DB_PATH
        ?? join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db');
}

const COMMANDS = {};

export function registerCommand(name, handler) {
    COMMANDS[name] = handler;
}

export async function dispatch(argv, deps) {
    const [ command, ...rest ] = argv;
    const handler = COMMANDS[command];

    if (!handler) {
        return { stdout: '', stderr: `mnotes: unknown command "${command}"\n`, exitCode: 1 };
    }

    try {
        return await handler(rest, deps);
    } catch (err) {
        return { stdout: '', stderr: `mnotes: ${err.message}\n`, exitCode: 1 };
    }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
    const result = await dispatch(argv, deps);
    if (result.stdout) {
        process.stdout.write(result.stdout);
    }
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    return result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
