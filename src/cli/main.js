#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { search, explainSearch } from '../core/search.js';
import { formatSearchTable, formatExplain, formatJson } from '../format.js';

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

export async function runSearch(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            mode: { type: 'string', default: 'hybrid' },
            limit: { type: 'string' },
            json: { type: 'boolean', default: false },
            explain: { type: 'boolean', default: false },
        },
    });
    const query = positionals[0];
    const limit = values.limit !== undefined ? Number(values.limit) : undefined;
    const searchOptions = {
        query, mode: values.mode, limit,
        embed: deps.embed, embeddingModel: deps.embeddingModel, embeddingVersion: deps.embeddingVersion,
    };

    if (values.explain) {
        const explained = await explainSearch(deps.db, searchOptions);
        return {
            stdout: values.json ? formatJson(explained) : formatExplain(explained),
            stderr: '',
            exitCode: 0,
        };
    }

    const results = await search(deps.db, searchOptions);
    const stdout = values.json ? formatJson(results) : formatSearchTable(results, values.mode);
    return { stdout, stderr: '', exitCode: 0 };
}

registerCommand('search', runSearch);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
