#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { search, explainSearch } from '../core/search.js';
import { grep } from '../core/grep.js';
import { tagList, tagNotes } from '../core/tags.js';
import {
    formatSearchTable, formatExplain, formatGrepTable, formatTagListTable, formatTagNotesTable, formatJson,
} from '../format.js';

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

export async function runGrep(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            regex: { type: 'boolean', default: false },
            note: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
    });
    const pattern = positionals[0];
    const results = grep(deps.vaultRoot, pattern, { regex: values.regex, noteTitle: values.note ?? null });

    if (values.json) {
        const mapped = results.map((r) => ({
            note_title: r.noteTitle,
            file_line_count: r.fileLineCount,
            total_match_count: r.totalMatchCount,
            line_matches: r.lineMatches,
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatGrepTable(results), stderr: '', exitCode: 0 };
}

registerCommand('grep', runGrep);

async function runTagsList(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
    const tags = tagList(deps.db);

    if (values.json) {
        const mapped = tags.map((t) => ({ tag: t.tag, notes_with_tag: t.notesWithTag }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagListTable(tags), stderr: '', exitCode: 0 };
}

async function runTagsNotes(args, deps) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { json: { type: 'boolean', default: false } },
    });
    const tagName = positionals[0];
    const notes = tagNotes(deps.db, tagName);

    if (values.json) {
        const mapped = notes.map((n) => ({ note_title: n.noteTitle, file_line_count: n.fileLineCount }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagNotesTable(notes), stderr: '', exitCode: 0 };
}

export async function runTags(args, deps) {
    const [ sub, ...rest ] = args;
    if (sub === 'list') {
        return runTagsList(rest, deps);
    }
    if (sub === 'notes') {
        return runTagsNotes(rest, deps);
    }
    return { stdout: '', stderr: `mnotes: unknown tags subcommand "${sub}"\n`, exitCode: 1 };
}

registerCommand('tags', runTags);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then((exitCode) => {
        process.exitCode = exitCode;
    });
}
