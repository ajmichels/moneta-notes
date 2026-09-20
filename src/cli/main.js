#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { search, explainSearch } from '../core/search.js';
import { grep } from '../core/grep.js';
import { tagList, tagNotes } from '../core/tags.js';
import { metadataKeys, metadataQuery } from '../core/metadata.js';
import { getBrokenLinks } from '../core/links.js';
import { noteRead, noteWrite, noteEdit, noteAppend, noteRename } from '../core/notes.js';
import { readAttachment, writeAttachment, resolveAttachmentPath } from '../core/attachments.js';
import { titleToPath, resolveTitle, loadReadonlyMatcher, checkReadonly } from '../core/note-fs.js';
import { logAudit, getAuditLogger, defaultLogDir } from '../logger.js';
import { openDb } from '../core/db.js';
import { defaultSocketPath, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_VERSION } from '../indexer/daemon.js';
import { embedQueryOverSocket } from '../indexer/embed.js';
import { loadConfig, resolveConfig, resolveVault, resolveVaultsForQuery, listVaults } from '../config.js';
import { computeStats, checkDaemonRunning } from './stats.js';
import { runReindexCommand } from './reindex.js';
import { runDaemonCommand } from './daemon.js';
import { runVectorsCommand } from './vectors.js';
import { runLogsCommand } from './logs.js';
import {
    formatSearchTable, formatExplain, formatGrepTable, formatTagListTable, formatTagNotesTable,
    formatMetadataKeysTable, formatLinksTable, formatBrokenLinksTable, formatStats, formatJson,
    formatJsonPretty, formatVaultsTable,
} from '../format.js';

// Every vault-scoped command accepts this bypass: a test double (or any other caller) that already
// knows exactly which vault it wants passes vaultRoot/dbPath directly, skipping config-driven
// resolution entirely — the same "explicit deps win" precedence resolveConfig() already documents
// for the tunable-parameter sections. Real CLI usage never sets deps.vaultRoot (buildRealDeps below
// stopped doing that), so it always resolves through config + whatever --vault the caller typed.
function hasDirectVaultDeps(deps) {
    return deps.vaultRoot !== undefined || deps.db !== undefined;
}

function resolveCliVault(deps, vaultFlag) {
    if (hasDirectVaultDeps(deps)) {
        return { name: null, path: deps.vaultRoot, dbPath: deps.dbPath ?? null, description: null };
    }
    return resolveVault(resolveConfig(deps), vaultFlag ?? null);
}

// Same bypass, for the five commands that fan out across every configured vault when --vault is
// omitted (S006/S009) instead of resolving to a single default.
function resolveCliVaultsForQuery(deps, vaultFlag) {
    if (hasDirectVaultDeps(deps)) {
        return [ { name: null, path: deps.vaultRoot, dbPath: deps.dbPath ?? null, description: null } ];
    }
    return resolveVaultsForQuery(resolveConfig(deps), vaultFlag ?? null).vaults;
}

function openCliDb(deps, dbPath) {
    return deps.db ?? openDb(dbPath).db;
}

// A handful of commands (grep, read, links <title>, rename) treat a missing db as an acceptable
// degraded mode rather than a hard requirement (S010) — title resolution just falls back to an
// exact-match-only path. That "no db" case only ever arises from a test double exercising
// filesystem-only behavior; real resolution (no deps.vaultRoot bypass) always opens one.
function optionalCliDb(deps, dbPath) {
    if (deps.db !== undefined) {
        return deps.db;
    }
    if (deps.vaultRoot !== undefined) {
        return null;
    }
    return openDb(dbPath).db;
}

const VAULT_FLAG_OPTION = { vault: { type: 'string' } };

const COMMANDS = {};

export function registerCommand(name, handler) {
    COMMANDS[name] = handler;
}

const TOP_LEVEL_HELP = `Usage: mnotes <command> [flags]

Commands:
  search    Full-text, semantic, or hybrid search over the vault
  grep      Ripgrep-backed literal/regex search over note files
  tags      list | notes <tag>
  metadata  keys | query
  links     <title> | broken
  read      Read a note by title
  write     Create a note or fully replace an existing one
  edit      Surgically replace text in an existing note
  append    Append content to an existing note
  rename    Rename a note
  attachment  read <path> | write <path> <local-file>
  reindex   Trigger a reindex via the indexing daemon
  daemon    start | stop | restart the indexing daemon
  stats     Show index/daemon stats
  logs      Filter/tail audit.log (default), or any other log file raw (--file=<name>)
  vectors   compare | nearest | cluster | reduce | tag-fit | tag-redundancy | outliers | calibrate
  vaults    List every configured vault (S009)

Run 'mnotes <command> --help' for command-specific flags.
`;

const COMMAND_USAGE = {
    search: 'mnotes search <query> [--mode=hybrid|fulltext|semantic] [--limit=N] [--explain] [--json]\n'
        + '       [--vault=<name>]\n'
        + '       (--vault omitted with 2+ vaults configured fans out across all of them, grouped by\n'
        + '        vault, --limit applied per vault — see S009)',
    grep: 'mnotes grep <pattern> [--regex] [--note=<title>] [--content] [--json] [--vault=<name>]\n'
        + '       (--note resolves like read\'s <title> does — exact match, or a unique basename match)\n'
        + '       (--vault omitted with 2+ vaults configured fans out across all of them — see S009)',
    tags: 'mnotes tags list [--json] [--vault=<name>]\n'
        + '       mnotes tags notes <tag> [--json] [--vault=<name>]\n'
        + '       (list requires --vault when 2+ vaults are configured; notes fans out when omitted)',
    metadata: 'mnotes metadata keys [--json] [--vault=<name>]\n'
        + '       mnotes metadata query [--filter="key op value"]... [--exists=key]...\n'
        + '                              [--missing=key]... [--match=any] [--json] [--vault=<name>]\n'
        + '       (--filter op is one of = != > >= < <=, or "key in v1,v2,...";\n'
        + "        --exists/--missing are sugar for {op: 'exists'}/{op: 'exists', negate: true};\n"
        + '        --match=any ORs conditions together instead of ANDing;\n'
        + '        key="tags" is filterable via query (eg. --filter="tags=project") but never\n'
        + '        listed by `keys` — run `mnotes tags list` for the tag vocabulary instead;\n'
        + '        keys requires --vault when 2+ vaults are configured; query fans out when omitted)',
    links: 'mnotes links <title> [--json] [--vault=<name>]\n       mnotes links broken [--json] [--vault=<name>]\n'
        + '       (<title> form requires --vault when 2+ vaults configured; broken fans out when omitted)',
    read: 'mnotes read <title> [--start=N] [--end=N] [--raw] [--json] [--vault=<name>]\n'
        + '       (<title> resolves: exact match, or a unique basename match, e.g. text from a [[wikilink]])',
    write: "mnotes write <title> [--hash=H] [--metadata='{...}'] [--content=\"...\"] [--vault=<name>]\n"
        + '       (content is read from stdin if --content is omitted)\n'
        + '       (<title> must be the exact absolute title — as returned by read/search — no resolution)',
    edit: 'mnotes edit <title> --hash=H --old="..." --new="..." [--metadata=\'{...}\'] [--vault=<name>]\n'
        + '       (<title> must be the exact absolute title — as returned by read/search — no resolution)',
    append: 'mnotes append <title> [--hash=H] [--content="..."] [--vault=<name>]\n'
        + '       (content is read from stdin if --content is omitted)\n'
        + '       (<title> must be the exact absolute title — as returned by read/search — no resolution)',
    rename: 'mnotes rename <old-title> <new-title> [--hash=H] [--vault=<name>]\n'
        + '       (both titles must be exact absolute titles — as returned by read/search — no resolution)',
    attachment: 'mnotes attachment read <path> [--raw] [--metadata|--json] [--vault=<name>]\n'
        + '       mnotes attachment write <path> [local-file] [--vault=<name>]\n'
        + '       (content is read from stdin if local-file is omitted)\n'
        + '       (<path> is the exact vault-relative path — no resolution; default read action opens\n'
        + '       the file via the OS default app)',
    reindex: 'mnotes reindex [title] [--vault=<name>]',
    daemon: 'mnotes daemon <start|stop|restart>',
    stats: 'mnotes stats [--json] [--vault=<name>]',
    logs: 'mnotes logs [--file=<name>] [--limit=N] [--follow]\n'
        + '       mnotes logs [--source=mcp|cli] [--tool=<name>] [--note=<title>] [--outcome=success|error]\n'
        + '                   [--vault=<name>] [--since=<1h|30m|ISO8601>] [--limit=N] [--follow] [--json]\n'
        + '       (--file is one of: audit (default), indexer, mcp-server, daemon.stdout, daemon.stderr,\n'
        + '        logrotate.stdout, logrotate.stderr; --source/--tool/--note/--outcome/--vault/--since/\n'
        + '        --json only apply to --file=audit — every other file prints raw lines, no parsing;\n'
        + '        --json is one compact object per line, not a single array;\n'
        + '        --follow streams live and defaults --limit to 20 for its printed backlog;\n'
        + '        --vault omitted shows every vault\'s entries — it is a plain equality filter, not\n'
        + '        subject to default-vault resolution)',
    vaults: 'mnotes vaults [--json]',
    // No entry for 'vectors': unlike every other command here, `vectors` has enough
    // sub-subcommands with distinct flag sets that a single flat usage line doesn't cut it —
    // dispatch() below special-cases 'vectors' to skip this table entirely and let
    // runVectorsCommand (cli/vectors.js) handle --help itself, per-subcommand.
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

    // 'vectors' has its own per-subcommand --help handling (cli/vectors.js) — richer than a
    // single flat usage line, since each subcommand's flag set is genuinely distinct. Every
    // other command's --help is this one generic short-circuit.
    if (command !== 'vectors' && (rest.includes('--help') || rest.includes('-h'))) {
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
    // stderr before stdout: `read`'s parsed-metadata-on-stderr / body-on-stdout split relies on
    // metadata printing first when both land on the same terminal.
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    if (result.stdout) {
        process.stdout.write(result.stdout);
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
            ...VAULT_FLAG_OPTION,
        },
    });
    const query = positionals[0];
    const limit = values.limit !== undefined ? Number(values.limit) : undefined;
    const { search: searchConfig } = resolveConfig(deps);
    const vaults = resolveCliVaultsForQuery(deps, values.vault);
    const fannedOut = vaults.length > 1;

    const optionsFor = (vaultRoot) => ({
        query, mode: values.mode, limit, vaultRoot,
        embed: deps.embed, embeddingModel: deps.embeddingModel, embeddingVersion: deps.embeddingVersion,
        limitDefault: searchConfig.limit_default,
        limitMax: searchConfig.limit_max,
        overfetchMultiplier: searchConfig.overfetch_multiplier,
        overfetchCap: searchConfig.overfetch_cap,
        rrfK: searchConfig.rrf_k,
    });

    // --explain's fan-out output is each vault's own summary-line-then-table block printed in
    // sequence (S006/S009) — never a merged summary, since RRF/BM25/cosine are corpus-relative.
    if (values.explain) {
        const blocks = [];
        for (const v of vaults) {
            const db = openCliDb(deps, v.dbPath);
            const explained = await explainSearch(db, optionsFor(v.path));
            const rendered = values.json ? formatJson(explained) : formatExplain(explained);
            blocks.push(fannedOut ? `vault: ${v.name}\n${rendered}` : rendered);
        }
        return { stdout: blocks.join('\n'), stderr: '', exitCode: 0 };
    }

    let allResults = [];
    for (const v of vaults) {
        const db = openCliDb(deps, v.dbPath);
        const results = await search(db, optionsFor(v.path));
        allResults = allResults.concat(fannedOut ? results.map((r) => ({ ...r, vault: v.name })) : results);
    }

    const stdout = values.json
        ? formatJson(allResults)
        : formatSearchTable(allResults, values.mode, { align: true, showVault: fannedOut });
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
            ...VAULT_FLAG_OPTION,
        },
    });
    const pattern = positionals[0];
    const { grep: grepConfig } = resolveConfig(deps);
    const vaults = resolveCliVaultsForQuery(deps, values.vault);
    const fannedOut = vaults.length > 1;

    let allResults = [];
    for (const v of vaults) {
        const db = optionalCliDb(deps, v.dbPath);
        const results = grep(v.path, pattern, {
            regex: values.regex,
            noteTitle: values.note ?? null,
            lineMatchCap: grepConfig.line_match_cap,
            db,
        });
        allResults = allResults.concat(fannedOut ? results.map((r) => ({ ...r, vault: v.name })) : results);
    }

    if (values.json) {
        const mapped = allResults.map((r) => ({
            ...(r.vault !== undefined ? { vault: r.vault } : {}),
            note_title: r.noteTitle,
            file_line_count: r.fileLineCount,
            total_match_count: r.totalMatchCount,
            line_matches: values.content
                ? r.lineMatches
                : r.lineMatches.map((m) => ({ line: m.line })),
            ...(r.readonly ? { readonly: true } : {}),
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return {
        stdout: formatGrepTable(allResults, { includeText: values.content, align: true, showVault: fannedOut }),
        stderr: '',
        exitCode: 0,
    };
}

registerCommand('grep', runGrep);

async function runTagsList(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, ...VAULT_FLAG_OPTION } });
    const vault = resolveCliVault(deps, values.vault);
    const db = openCliDb(deps, vault.dbPath);
    const tags = tagList(db);

    if (values.json) {
        const mapped = tags.map((t) => ({ tag: t.tag, notes_with_tag: t.notesWithTag }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagListTable(tags, { align: true }), stderr: '', exitCode: 0 };
}

async function runTagsNotes(args, deps) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { json: { type: 'boolean', default: false }, ...VAULT_FLAG_OPTION },
    });
    const tagName = positionals[0];
    const vaults = resolveCliVaultsForQuery(deps, values.vault);
    const fannedOut = vaults.length > 1;

    let notes = [];
    for (const v of vaults) {
        const db = openCliDb(deps, v.dbPath);
        const result = tagNotes(db, tagName, { vaultRoot: v.path });
        notes = notes.concat(fannedOut ? result.map((n) => ({ ...n, vault: v.name })) : result);
    }

    if (values.json) {
        const mapped = notes.map((n) => ({
            ...(n.vault !== undefined ? { vault: n.vault } : {}),
            note_title: n.noteTitle, file_line_count: n.fileLineCount,
            ...(n.readonly ? { readonly: true } : {}),
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagNotesTable(notes, { align: true, showVault: fannedOut }), stderr: '', exitCode: 0 };
}

export async function runTags(args, deps) {
    const [ sub, ...rest ] = args;
    if (sub === undefined) {
        return { stdout: '', stderr: 'mnotes: tags requires a subcommand (list|notes)\n', exitCode: 1 };
    }
    if (sub === 'list') {
        return runTagsList(rest, deps);
    }
    if (sub === 'notes') {
        return runTagsNotes(rest, deps);
    }
    return { stdout: '', stderr: `mnotes: unknown tags subcommand "${sub}"\n`, exitCode: 1 };
}

registerCommand('tags', runTags);

// Longest operator token first so e.g. '>=' isn't misread as '=' at the wrong index — '!=' maps to
// eq(negate) since metadata_query has no separate `ne` op (S014).
const FILTER_OPERATOR_TOKENS = [
    [ '>=', 'gte' ], [ '<=', 'lte' ], [ '!=', 'eq' ], [ '>', 'gt' ], [ '<', 'lt' ], [ '=', 'eq' ],
];

// CLI-only presentation-layer translation (S014/S006) — parses a friendly "key op value" string
// into the exact {key, op, value, negate} shape core/metadata.js's metadataQuery (and the MCP tool)
// take directly, the same relationship --metadata='{...}' already has with note_write.
export function parseFilterString(raw) {
    const numericOrBoolean = (token) => {
        if (/^-?\d+(\.\d+)?$/.test(token)) {
            return Number(token);
        }
        if (token === 'true' || token === 'false') {
            return token === 'true';
        }
        return token;
    };

    const inMatch = raw.match(/^(.+?)\s+in\s+(.+)$/);
    if (inMatch) {
        const [ , key, valueList ] = inMatch;
        return {
            key: key.trim(), op: 'in',
            value: valueList.split(',').map((v) => numericOrBoolean(v.trim())),
        };
    }

    for (const [ token, op ] of FILTER_OPERATOR_TOKENS) {
        const index = raw.indexOf(token);
        if (index === -1) {
            continue;
        }
        return {
            key: raw.slice(0, index).trim(),
            op,
            value: numericOrBoolean(raw.slice(index + token.length).trim()),
            negate: token === '!=',
        };
    }

    throw new Error(`--filter is not a recognized expression: "${raw}"`);
}

async function runMetadataKeys(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, ...VAULT_FLAG_OPTION } });
    const vault = resolveCliVault(deps, values.vault);
    const db = openCliDb(deps, vault.dbPath);
    const keys = metadataKeys(db);

    if (values.json) {
        const mapped = keys.map((k) => (
            { key: k.key, type: k.type, example: k.example, notes_with_key: k.notesWithKey }
        ));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatMetadataKeysTable(keys, { align: true }), stderr: '', exitCode: 0 };
}

async function runMetadataQuery(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            filter: { type: 'string', multiple: true, default: [] },
            exists: { type: 'string', multiple: true, default: [] },
            missing: { type: 'string', multiple: true, default: [] },
            match: { type: 'string', default: 'all' },
            json: { type: 'boolean', default: false },
            ...VAULT_FLAG_OPTION,
        },
    });

    const filters = [
        ...values.filter.map(parseFilterString),
        ...values.exists.map((key) => ({ key, op: 'exists' })),
        ...values.missing.map((key) => ({ key, op: 'exists', negate: true })),
    ];
    const vaults = resolveCliVaultsForQuery(deps, values.vault);
    const fannedOut = vaults.length > 1;

    let notes = [];
    for (const v of vaults) {
        const db = openCliDb(deps, v.dbPath);
        const result = metadataQuery(db, { filters, match: values.match, vaultRoot: v.path });
        notes = notes.concat(fannedOut ? result.map((n) => ({ ...n, vault: v.name })) : result);
    }

    if (values.json) {
        const mapped = notes.map((n) => ({
            ...(n.vault !== undefined ? { vault: n.vault } : {}),
            note_title: n.noteTitle, file_line_count: n.fileLineCount,
            ...(n.readonly ? { readonly: true } : {}),
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }

    return { stdout: formatTagNotesTable(notes, { align: true, showVault: fannedOut }), stderr: '', exitCode: 0 };
}

export async function runMetadata(args, deps) {
    const [ sub, ...rest ] = args;
    if (sub === undefined) {
        return {
            stdout: '', stderr: 'mnotes: metadata requires a subcommand (keys|query)\n', exitCode: 1,
        };
    }
    if (sub === 'keys') {
        return runMetadataKeys(rest, deps);
    }
    if (sub === 'query') {
        return runMetadataQuery(rest, deps);
    }
    return { stdout: '', stderr: `mnotes: unknown metadata subcommand "${sub}"\n`, exitCode: 1 };
}

registerCommand('metadata', runMetadata);

async function runLinksTitle(args, deps) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { json: { type: 'boolean', default: false }, ...VAULT_FLAG_OPTION },
    });
    const title = positionals[0];
    const vault = resolveCliVault(deps, values.vault);
    const db = optionalCliDb(deps, vault.dbPath);
    const { backlinks, links_out: linksOut } = noteRead(vault.path, title, { db });

    if (values.json) {
        return { stdout: formatJson({ backlinks, links_out: linksOut }), stderr: '', exitCode: 0 };
    }
    return {
        stdout: formatLinksTable(
            { backlinks, links_out: linksOut },
            { align: true, readonlyMatcher: readonlyMatcherFor(vault.path) },
        ),
        stderr: '',
        exitCode: 0,
    };
}

// A resolved vault path is always set on a real CLI invocation, but links broken has historically
// needed only db — stay tolerant of a missing vaultRoot (e.g. a caller/test that only cares about
// the db-backed broken-link listing) rather than crashing on it, same additive-only posture as
// every other optional readonly hookup in S015.
function readonlyMatcherFor(vaultRoot) {
    return vaultRoot ? loadReadonlyMatcher(vaultRoot) : null;
}

async function runLinksBroken(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, ...VAULT_FLAG_OPTION } });
    const vaults = resolveCliVaultsForQuery(deps, values.vault);
    const fannedOut = vaults.length > 1;

    let broken = [];
    for (const v of vaults) {
        const db = openCliDb(deps, v.dbPath);
        const readonlyMatcher = readonlyMatcherFor(v.path);
        const result = getBrokenLinks(db).map((b) => ({
            ...b,
            readonly: readonlyMatcher ? checkReadonly(readonlyMatcher, `${b.sourceTitle}.md`).readonly : false,
        }));
        broken = broken.concat(fannedOut ? result.map((b) => ({ ...b, vault: v.name })) : result);
    }

    if (values.json) {
        const mapped = broken.map((b) => ({
            ...(b.vault !== undefined ? { vault: b.vault } : {}),
            note_title: b.sourceTitle,
            broken_target: b.targetTitle,
            ...(b.readonly ? { readonly: true } : {}),
        }));
        return { stdout: formatJson(mapped), stderr: '', exitCode: 0 };
    }
    return { stdout: formatBrokenLinksTable(broken, { align: true, showVault: fannedOut }), stderr: '', exitCode: 0 };
}

export async function runLinks(args, deps) {
    const [ sub, ...rest ] = args;
    if (sub === 'broken') {
        return runLinksBroken(rest, deps);
    }
    if (sub === undefined) {
        return { stdout: '', stderr: 'mnotes: links requires a note title or "broken"\n', exitCode: 1 };
    }
    return runLinksTitle(args, deps);
}

registerCommand('links', runLinks);

function readRawNoteBytes(vaultRoot, title, db) {
    let filePath = titleToPath(vaultRoot, title);
    // --raw reads the file directly rather than going through noteRead, but title resolution
    // (exact match, then unique-basename fallback per S010) applies here too — a caller shouldn't
    // get worse behavior from --raw than from the default/--json modes for the same title.
    if (!existsSync(filePath) && db) {
        const resolved = resolveTitle(db, title);
        if (resolved !== null) {
            filePath = titleToPath(vaultRoot, resolved);
        }
    }
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
            ...VAULT_FLAG_OPTION,
        },
    });
    const title = positionals[0];
    const vault = resolveCliVault(deps, values.vault);
    const db = optionalCliDb(deps, vault.dbPath);

    if (values.raw) {
        return { stdout: readRawNoteBytes(vault.path, title, db), stderr: '', exitCode: 0 };
    }

    const startLine = values.start !== undefined ? Number(values.start) : undefined;
    const endLine = values.end !== undefined ? Number(values.end) : undefined;
    const result = noteRead(vault.path, title, { startLine, endLine, db });

    if (values.json) {
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    }

    return {
        stdout: result.content.length > 0 ? `${result.content}\n` : '',
        stderr: formatJsonPretty(result.metadata),
        exitCode: 0,
    };
}

registerCommand('read', runRead);

export async function readStdinBytes(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

export async function readStdinContent(stream) {
    return (await readStdinBytes(stream)).toString('utf8');
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
            ...VAULT_FLAG_OPTION,
        },
    });
    const title = positionals[0];
    const metadata = parseMetadataFlag(values.metadata);
    const content = values.content ?? await readStdinContent(deps.stdin ?? process.stdin);
    const vault = resolveCliVault(deps, values.vault);

    try {
        const { notes: notesConfig } = resolveConfig(deps);
        const result = noteWrite(vault.path, title, {
            hash: values.hash ?? null, metadata, content,
            sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        logAudit(deps.auditLogger, {
            tool: 'write', noteTitle: title, source: 'cli', outcome: 'success', vault: vault.name,
        });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'write', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
            vault: vault.name,
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
            ...VAULT_FLAG_OPTION,
        },
    });
    const title = positionals[0];
    const metadata = parseMetadataFlag(values.metadata);
    const vault = resolveCliVault(deps, values.vault);

    try {
        const { notes: notesConfig } = resolveConfig(deps);
        const result = noteEdit(vault.path, title, {
            hash: values.hash, oldTxt: values.old, newTxt: values.new, metadata,
            sizeDropThreshold: notesConfig.size_drop_threshold,
        });
        logAudit(deps.auditLogger, {
            tool: 'edit', noteTitle: title, source: 'cli', outcome: 'success', vault: vault.name,
        });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'edit', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
            vault: vault.name,
        });
        throw err;
    }
}

registerCommand('edit', runEdit);

export async function runAppend(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { hash: { type: 'string' }, content: { type: 'string' }, ...VAULT_FLAG_OPTION },
    });
    const title = positionals[0];
    const content = values.content ?? await readStdinContent(deps.stdin ?? process.stdin);
    const vault = resolveCliVault(deps, values.vault);

    try {
        const result = noteAppend(vault.path, title, values.hash ?? null, content);
        logAudit(deps.auditLogger, {
            tool: 'append', noteTitle: title, source: 'cli', outcome: 'success', vault: vault.name,
        });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'append', noteTitle: title, source: 'cli', outcome: 'error', errorMessage: err.message,
            vault: vault.name,
        });
        throw err;
    }
}

registerCommand('append', runAppend);

export async function runRename(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { hash: { type: 'string' }, ...VAULT_FLAG_OPTION },
    });
    const [ oldTitle, newTitle ] = positionals;
    const vault = resolveCliVault(deps, values.vault);
    const db = optionalCliDb(deps, vault.dbPath);

    try {
        // Passes a freshly-opened db (unlike this task's original literal spec draft) so the search
        // index is updated in place immediately — noteRename's write-through db param exists
        // specifically to avoid a rename briefly disappearing from search while waiting on the
        // daemon's fswatch loop to notice the file move.
        const result = noteRename(vault.path, oldTitle, newTitle, values.hash ?? null, db);
        logAudit(deps.auditLogger, {
            tool: 'rename', noteTitle: newTitle, source: 'cli', outcome: 'success', vault: vault.name,
        });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'rename', noteTitle: newTitle, source: 'cli', outcome: 'error', errorMessage: err.message,
            vault: vault.name,
        });
        throw err;
    }
}

registerCommand('rename', runRename);

function defaultOpenAttachment(filePath) {
    spawn('open', [ filePath ], { detached: true, stdio: 'ignore' }).unref();
}

export async function runAttachmentRead(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            raw: { type: 'boolean', default: false },
            metadata: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            ...VAULT_FLAG_OPTION,
        },
    });
    const path = positionals[0];
    const { attachments: attachmentsConfig } = resolveConfig(deps);
    const vault = resolveCliVault(deps, values.vault);

    if (values.metadata || values.json) {
        const result = await readAttachment(vault.path, path, { includeContent: false });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    }

    if (values.raw) {
        const result = await readAttachment(vault.path, path, {
            includeContent: true, maxReadBytes: attachmentsConfig.max_read_bytes,
        });
        return { stdout: result.content, stderr: '', exitCode: 0 };
    }

    const filePath = resolveAttachmentPath(vault.path, path);
    (deps.openAttachment ?? defaultOpenAttachment)(filePath);
    return { stdout: `opened ${path}\n`, stderr: '', exitCode: 0 };
}

export async function runAttachmentWrite(args, deps) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...VAULT_FLAG_OPTION } });
    const [ path, localFile ] = positionals;
    const vault = resolveCliVault(deps, values.vault);

    try {
        const buffer = localFile !== undefined
            ? readFileSync(localFile)
            : await readStdinBytes(deps.stdin ?? process.stdin);
        const result = writeAttachment(vault.path, path, buffer);
        logAudit(deps.auditLogger, {
            tool: 'attachment_write', attachmentPath: path, source: 'cli', outcome: 'success', vault: vault.name,
        });
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    } catch (err) {
        logAudit(deps.auditLogger, {
            tool: 'attachment_write', attachmentPath: path, source: 'cli', outcome: 'error',
            errorMessage: err.message, vault: vault.name,
        });
        throw err;
    }
}

export async function runAttachment(args, deps) {
    const [ sub, ...rest ] = args;
    if (sub === undefined) {
        return { stdout: '', stderr: 'mnotes: attachment requires a subcommand (read|write)\n', exitCode: 1 };
    }
    if (sub === 'read') {
        return runAttachmentRead(rest, deps);
    }
    if (sub === 'write') {
        return runAttachmentWrite(rest, deps);
    }
    return { stdout: '', stderr: `mnotes: unknown attachment subcommand "${sub}"\n`, exitCode: 1 };
}

registerCommand('attachment', runAttachment);

export async function runStats(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, ...VAULT_FLAG_OPTION } });
    const vault = resolveCliVault(deps, values.vault);
    const dbPath = deps.dbPath ?? vault.dbPath;
    const db = openCliDb(deps, dbPath);
    const stats = computeStats(db, dbPath, deps.embeddingModel, deps.embeddingVersion);
    const daemonRunning = await checkDaemonRunning(deps.socketPath);
    return { stdout: formatStats(stats, { json: values.json, daemonRunning }), stderr: '', exitCode: 0 };
}

export async function runVaults(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
    const vaults = listVaults(resolveConfig(deps));
    if (values.json) {
        return { stdout: formatJson(vaults), stderr: '', exitCode: 0 };
    }
    return { stdout: formatVaultsTable(vaults, { align: true }), stderr: '', exitCode: 0 };
}

registerCommand('reindex', runReindexCommand);
registerCommand('daemon', runDaemonCommand);
registerCommand('stats', runStats);
registerCommand('logs', runLogsCommand);
registerCommand('vectors', runVectorsCommand);
registerCommand('vaults', runVaults);

function buildRealDeps() {
    const config = loadConfig();
    const socketPath = defaultSocketPath();
    return {
        config,
        // The daemon is the only process that ever loads the embedding model (S005) — this asks it
        // over IPC rather than loading a second copy in this CLI process.
        embed: (text) => embedQueryOverSocket(socketPath, text),
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        embeddingVersion: DEFAULT_EMBEDDING_VERSION,
        auditLogger: getAuditLogger(defaultLogDir()),
        logDir: defaultLogDir(),
        socketPath,
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
