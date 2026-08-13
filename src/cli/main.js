#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { search, explainSearch } from '../core/search.js';
import { grep } from '../core/grep.js';
import { tagList, tagNotes } from '../core/tags.js';
import { noteRead, noteWrite, noteEdit, noteAppend, noteRename } from '../core/notes.js';
import { titleToPath } from '../core/note-fs.js';
import { logAudit, getAuditLogger, defaultLogDir } from '../logger.js';
import { openDb } from '../core/db.js';
import { defaultSocketPath, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_VERSION } from '../indexer/daemon.js';
import { embed as realEmbed, configureEmbedder } from '../indexer/embed.js';
import { loadConfig, resolveConfig } from '../config.js';
import { computeStats, checkDaemonRunning } from './stats.js';
import { runReindexCommand } from './reindex.js';
import { runDaemonCommand } from './daemon.js';
import {
    formatSearchTable, formatExplain, formatGrepTable, formatTagListTable, formatTagNotesTable,
    formatStats, formatJson,
} from '../format.js';

export function resolveVaultRoot(config = loadConfig()) {
    return config.vault_path;
}

export function resolveDbPath(config = loadConfig()) {
    return config.db_path;
}

const COMMANDS = {};

export function registerCommand(name, handler) {
    COMMANDS[name] = handler;
}

const TOP_LEVEL_HELP = `Usage: mnotes <command> [flags]

Commands:
  search    Full-text, semantic, or hybrid search over the vault
  grep      Ripgrep-backed literal/regex search over note files
  tags      list | notes <tag>
  read      Read a note by title
  write     Create a note or fully replace an existing one
  edit      Surgically replace text in an existing note
  append    Append content to an existing note
  rename    Rename a note
  reindex   Trigger a reindex via the indexing daemon
  daemon    start | stop | restart the indexing daemon
  stats     Show index/daemon stats

Run 'mnotes <command> --help' for command-specific flags.
`;

const COMMAND_USAGE = {
    search: 'mnotes search <query> [--mode=hybrid|fulltext|semantic] [--limit=N] [--explain] [--json]',
    grep: 'mnotes grep <pattern> [--regex] [--note=<title>] [--content] [--json]',
    tags: "mnotes tags list [--json]\n       mnotes tags notes <tag> [--json]",
    read: 'mnotes read <title> [--start=N] [--end=N] [--raw] [--json]',
    write: "mnotes write <title> [--hash=H] [--metadata='{...}'] [--content=\"...\"]\n"
        + '       (content is read from stdin if --content is omitted)',
    edit: 'mnotes edit <title> --hash=H --old="..." --new="..." [--metadata=\'{...}\']',
    append: 'mnotes append <title> [--hash=H] [--content="..."]\n'
        + '       (content is read from stdin if --content is omitted)',
    rename: 'mnotes rename <old-title> <new-title> [--hash=H]',
    reindex: 'mnotes reindex [title]',
    daemon: 'mnotes daemon <start|stop|restart>',
    stats: 'mnotes stats [--json]',
};

export async function dispatch(argv, deps) {
    const [ command, ...rest ] = argv;

    if (command === undefined || command === '--help' || command === '-h') {
        return { stdout: TOP_LEVEL_HELP, stderr: '', exitCode: 0 };
    }

    const handler = COMMANDS[command];

    if (!handler) {
        return { stdout: '', stderr: `mnotes: unknown command "${command}"\n`, exitCode: 1 };
    }

    if (rest.includes('--help') || rest.includes('-h')) {
        return { stdout: `Usage: ${COMMAND_USAGE[command]}\n`, stderr: '', exitCode: 0 };
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
    const { search: searchConfig } = resolveConfig(deps);
    const searchOptions = {
        query, mode: values.mode, limit,
        embed: deps.embed, embeddingModel: deps.embeddingModel, embeddingVersion: deps.embeddingVersion,
        limitDefault: searchConfig.limit_default,
        limitMax: searchConfig.limit_max,
        overfetchMultiplier: searchConfig.overfetch_multiplier,
        overfetchCap: searchConfig.overfetch_cap,
        rrfK: searchConfig.rrf_k,
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
            content: { type: 'boolean', default: false },
        },
    });
    const pattern = positionals[0];
    const { grep: grepConfig } = resolveConfig(deps);
    const results = grep(deps.vaultRoot, pattern, {
        regex: values.regex,
        noteTitle: values.note ?? null,
        lineMatchCap: grepConfig.line_match_cap,
    });

    if (values.json) {
        const mapped = results.map((r) => ({
            note_title: r.noteTitle,
            file_line_count: r.fileLineCount,
            total_match_count: r.totalMatchCount,
            line_matches: values.content
                ? r.lineMatches
                : r.lineMatches.map((m) => ({ line: m.line })),
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatGrepTable(results, { includeText: values.content }), stderr: '', exitCode: 0 };
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

function readRawNoteBytes(vaultRoot, title) {
    const filePath = titleToPath(vaultRoot, title);
    try {
        return readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Note not found: "${title}"`, { cause: err });
        }
        throw err;
    }
}

export async function runRead(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            start: { type: 'string' },
            end: { type: 'string' },
            raw: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    });
    const title = positionals[0];

    if (values.raw) {
        return { stdout: readRawNoteBytes(deps.vaultRoot, title), stderr: '', exitCode: 0 };
    }

    const startLine = values.start !== undefined ? Number(values.start) : undefined;
    const endLine = values.end !== undefined ? Number(values.end) : undefined;
    const result = noteRead(deps.vaultRoot, title, { startLine, endLine });

    if (values.json) {
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    }

    return {
        stdout: result.content.length > 0 ? `${result.content}\n` : '',
        stderr: formatJson(result.metadata),
        exitCode: 0,
    };
}

registerCommand('read', runRead);

export async function readStdinContent(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function parseMetadataFlag(raw) {
    if (raw === undefined) {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`--metadata is not valid JSON: ${err.message}`, { cause: err });
    }
}

export async function runWrite(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            hash: { type: 'string' },
            metadata: { type: 'string' },
            content: { type: 'string' },
        },
    });
    const title = positionals[0];
    const metadata = parseMetadataFlag(values.metadata);
    const content = values.content ?? await readStdinContent(deps.stdin ?? process.stdin);

    try {
        const { notes: notesConfig } = resolveConfig(deps);
        const result = noteWrite(deps.vaultRoot, title, {
            hash: values.hash ?? null, metadata, content,
            sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        logAudit(deps.auditLogger, { tool: 'write', noteTitle: title, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'write', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('write', runWrite);

export async function runEdit(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            hash: { type: 'string' },
            old: { type: 'string' },
            new: { type: 'string' },
            metadata: { type: 'string' },
        },
    });
    const title = positionals[0];
    const metadata = parseMetadataFlag(values.metadata);

    try {
        const { notes: notesConfig } = resolveConfig(deps);
        const result = noteEdit(deps.vaultRoot, title, {
            hash: values.hash, oldTxt: values.old, newTxt: values.new, metadata,
            sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        logAudit(deps.auditLogger, { tool: 'edit', noteTitle: title, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'edit', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('edit', runEdit);

export async function runAppend(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { hash: { type: 'string' }, content: { type: 'string' } },
    });
    const title = positionals[0];
    const content = values.content ?? await readStdinContent(deps.stdin ?? process.stdin);

    try {
        const result = noteAppend(deps.vaultRoot, title, values.hash ?? null, content);
        logAudit(deps.auditLogger, { tool: 'append', noteTitle: title, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'append', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('append', runAppend);

export async function runRename(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { hash: { type: 'string' } },
    });
    const [ oldTitle, newTitle ] = positionals;

    try {
        // Passes deps.db (unlike this task's original literal spec draft) so the search index is
        // updated in place immediately — noteRename's write-through db param exists specifically
        // to avoid a rename briefly disappearing from search while waiting on the daemon's fswatch
        // loop to notice the file move.
        const result = noteRename(deps.vaultRoot, oldTitle, newTitle, values.hash ?? null, deps.db ?? null);
        logAudit(deps.auditLogger, { tool: 'rename', noteTitle: newTitle, source: 'cli', outcome: 'success' });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'rename', noteTitle: newTitle, source: 'cli', outcome: 'error', errorMessage: err.message,
        });
        throw err;
    }
}

registerCommand('rename', runRename);

export async function runStats(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
    const stats = computeStats(deps.db, deps.dbPath, deps.embeddingModel, deps.embeddingVersion);
    const daemonRunning = await checkDaemonRunning(deps.socketPath);
    return { stdout: formatStats(stats, { json: values.json, daemonRunning }), stderr: '', exitCode: 0 };
}

registerCommand('reindex', runReindexCommand);
registerCommand('daemon', runDaemonCommand);
registerCommand('stats', runStats);

function buildRealDeps() {
    const config = loadConfig();
    const vaultRoot = resolveVaultRoot(config);
    const dbPath = resolveDbPath(config);
    const { db } = openDb(dbPath);
    configureEmbedder({
        dtype: config.index.embedding_dtype,
        idleTimeoutMs: config.index.model_idle_unload_minutes * 60 * 1000,
    });
    return {
        vaultRoot,
        dbPath,
        db,
        config,
        embed: realEmbed,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        embeddingVersion: DEFAULT_EMBEDDING_VERSION,
        auditLogger: getAuditLogger(defaultLogDir()),
        socketPath: defaultSocketPath(),
    };
}

// realpathSync(argv[1]), not a raw string compare: mnotes is invoked through pnpm's global bin
// symlink (itself pointing at a symlinked node_modules/moneta-notes -> the repo), so argv[1] is a
// symlinked path while import.meta.url is already the resolved real path — a raw compare never
// matches through that symlink hop, silently skipping main() entirely (no error, no output).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.title = 'mnotes';
    main(process.argv.slice(2), buildRealDeps()).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
