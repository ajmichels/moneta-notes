import { parseArgs } from 'node:util';
import { readFileSync, statSync, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { defaultLogDir } from '../logger.js';
import { formatLogsTable, formatLogRow, formatLogEntryJsonLine } from '../format.js';

const DURATION_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_RE = /^(\d+)(s|m|h|d)$/;

export function parseSince(value) {
    const match = value.match(DURATION_RE);
    if (match) {
        return new Date(Date.now() - Number(match[1]) * DURATION_UNITS_MS[match[2]]);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`mnotes logs: invalid --since value "${value}" (expected e.g. "1h", "30m", or an ISO-8601 timestamp)`);
    }
    return date;
}

function unquote(rawValue) {
    if (!rawValue.startsWith('"')) {
        return rawValue;
    }
    return rawValue.slice(1, -1).replace(/\\(.)/g, '$1');
}

// Inverse of logger.js's formatLine/formatValue (S008): `<ts> <LVL> [<component>] <tool> [k=v...]`.
// Only ever reads audit.log, whose trailing context is always this fixed field set — returns null
// (skipped by the caller) for anything that doesn't fit, rather than guessing at a partial parse.
export function parseAuditLine(line) {
    let rest = line;

    const tsMatch = rest.match(/^(\S+)\s+/);
    if (!tsMatch) return null;
    const timestamp = tsMatch[1];
    rest = rest.slice(tsMatch[0].length);

    const levelMatch = rest.match(/^(\S+)\s+/);
    if (!levelMatch) return null;
    const level = levelMatch[1];
    rest = rest.slice(levelMatch[0].length);

    const componentMatch = rest.match(/^\[([^\]]+)\]\s*/);
    if (!componentMatch) return null;
    const component = componentMatch[1];
    rest = rest.slice(componentMatch[0].length);

    const toolMatch = rest.match(/^(\S+)/);
    if (!toolMatch) return null;
    const tool = toolMatch[1];
    rest = rest.slice(toolMatch[0].length);

    const context = {};
    const pairRe = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
    let pairMatch = pairRe.exec(rest);
    while (pairMatch !== null) {
        context[pairMatch[1]] = unquote(pairMatch[2]);
        pairMatch = pairRe.exec(rest);
    }

    return {
        timestamp,
        level,
        component,
        tool,
        noteTitle: context.note_title ?? null,
        attachmentPath: context.attachment_path ?? null,
        source: context.source ?? null,
        reason: context.reason ?? null,
        outcome: context.outcome ?? null,
        errorMessage: context.error_message ?? null,
    };
}

function readRawLines(logPath) {
    let content;
    try {
        content = readFileSync(logPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export function readAuditEntries(logPath) {
    return readRawLines(logPath).map(parseAuditLine).filter((entry) => entry !== null);
}

export function filterEntries(entries, { source, tool, note, outcome, since } = {}) {
    return entries.filter((entry) => {
        if (source && entry.source !== source) return false;
        if (tool && entry.tool !== tool) return false;
        if (note && entry.noteTitle !== note && entry.attachmentPath !== note) return false;
        if (outcome && entry.outcome !== outcome) return false;
        if (since && new Date(entry.timestamp) < since) return false;
        return true;
    });
}

// Watches a log file for growth past `startPosition`, emitting each complete appended line as a
// raw string — like `tail -f`, not `tail -F`: a rotated-away file (S008's log-rotator) isn't picked
// back up mid-run. Resolves only when `signal` aborts; in production nothing ever aborts it, so the
// process just runs until Ctrl-C or a downstream pipe closes, same as `tail -f` itself. Generic
// over any of the three log files (S008) — audit-specific parsing/filtering is the caller's job.
//
// Watches the containing directory rather than the file itself, so following a file that doesn't
// exist yet (e.g. a fresh install with no MCP tool call or CLI mutation ever made) can still pick
// it up the moment it's first created, instead of failing outright on ENOENT.
export async function followLogFile(logPath, startPosition, onLine, signal) {
    const dir = dirname(logPath);
    const filename = basename(logPath);
    let position = startPosition;
    let buffer = '';
    let handle = null;

    function drain(chunk) {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            onLine(line);
            newlineIndex = buffer.indexOf('\n');
        }
    }

    async function ensureHandle() {
        if (handle) return true;
        try {
            handle = await open(logPath, 'r');
            return true;
        } catch (err) {
            if (err.code === 'ENOENT') return false;
            throw err;
        }
    }

    async function checkGrowth() {
        if (!(await ensureHandle())) return;
        const { size } = await handle.stat();
        if (size <= position) return;
        const length = size - position;
        const { buffer: chunk } = await handle.read(Buffer.alloc(length), 0, length, position);
        position = size;
        drain(chunk.toString('utf8'));
    }

    const watcher = watch(dir);
    try {
        await new Promise((resolve) => {
            watcher.on('change', (eventType, changedFilename) => {
                if (changedFilename && changedFilename !== filename) return;
                checkGrowth().catch(() => {});
            });
            signal?.addEventListener('abort', () => resolve(), { once: true });
        });
    } finally {
        watcher.close();
        if (handle) await handle.close();
    }
}

// Every `<name>` here maps mechanically to `<name>.log` under the log directory (S008/S009) — the
// first three are this project's own logger.js output; the last four are the raw stdout/stderr the
// service manager (launchd/systemd) redirects the daemon and log-rotator processes to, per
// `launchd/*.plist.template` / `systemd/*.service.template` — not logger.js lines at all, so they
// carry no guaranteed format (Node warnings, uncaught stack traces, whatever the process printed).
const LOG_FILES = [
    'audit', 'indexer', 'mcp-server',
    'daemon.stdout', 'daemon.stderr', 'logrotate.stdout', 'logrotate.stderr',
];

// Only audit.log has structured per-call fields (S008) — these flags presuppose that shape and are
// rejected outright against every other file, all of which are unstructured text.
const AUDIT_ONLY_FLAGS = [ 'source', 'tool', 'note', 'outcome', 'since', 'json' ];

const OPTIONS = {
    file: { type: 'string' },
    source: { type: 'string' },
    tool: { type: 'string' },
    note: { type: 'string' },
    outcome: { type: 'string' },
    since: { type: 'string' },
    limit: { type: 'string' },
    follow: { type: 'boolean' },
    json: { type: 'boolean' },
};

const DEFAULT_FOLLOW_BACKLOG = 20;

function startPositionOf(logPath) {
    return statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
}

async function runRawLogCommand(logPath, { limit, follow, write, signal }) {
    const lines = readRawLines(logPath);

    if (!follow) {
        const result = limit !== null ? lines.slice(-limit) : lines;
        return { stdout: result.length > 0 ? `${result.join('\n')}\n` : '', stderr: '', exitCode: 0 };
    }

    const emit = write ?? ((s) => process.stdout.write(s));
    for (const line of lines.slice(-(limit ?? DEFAULT_FOLLOW_BACKLOG))) emit(`${line}\n`);

    await followLogFile(logPath, startPositionOf(logPath), (line) => emit(`${line}\n`), signal);
    return { stdout: '', stderr: '', exitCode: 0 };
}

function parseAuditFilters(values) {
    if (values.source !== undefined && ![ 'mcp', 'cli' ].includes(values.source)) {
        throw new Error(`mnotes logs: --source must be "mcp" or "cli", got "${values.source}"`);
    }
    if (values.outcome !== undefined && ![ 'success', 'error' ].includes(values.outcome)) {
        throw new Error(`mnotes logs: --outcome must be "success" or "error", got "${values.outcome}"`);
    }
    return {
        source: values.source ?? null,
        tool: values.tool ?? null,
        note: values.note ?? null,
        outcome: values.outcome ?? null,
        since: values.since !== undefined ? parseSince(values.since) : null,
    };
}

async function runAuditLogCommand(logPath, values, { limit, follow, write: writeDep, signal }) {
    const json = values.json === true;
    const filters = parseAuditFilters(values);
    const filtered = filterEntries(readAuditEntries(logPath), filters);

    if (!follow) {
        const result = limit !== null ? filtered.slice(-limit) : filtered;
        const stdout = json
            ? result.map(formatLogEntryJsonLine).join('')
            : formatLogsTable(result, { align: true });
        return { stdout, stderr: '', exitCode: 0 };
    }

    const write = writeDep ?? ((s) => process.stdout.write(s));
    const renderOne = json ? formatLogEntryJsonLine : formatLogRow;
    for (const entry of filtered.slice(-(limit ?? DEFAULT_FOLLOW_BACKLOG))) write(renderOne(entry));

    await followLogFile(logPath, startPositionOf(logPath), (line) => {
        const entry = parseAuditLine(line);
        if (entry && filterEntries([ entry ], filters).length > 0) write(renderOne(entry));
    }, signal);

    return { stdout: '', stderr: '', exitCode: 0 };
}

function validateFile(values) {
    const file = values.file ?? 'audit';
    if (!LOG_FILES.includes(file)) {
        throw new Error(`mnotes logs: --file must be one of ${LOG_FILES.join(', ')}, got "${file}"`);
    }
    if (file !== 'audit') {
        const offending = AUDIT_ONLY_FLAGS.filter((flag) => values[flag] !== undefined);
        if (offending.length > 0) {
            throw new Error(
                `mnotes logs: --${offending.join(', --')} only apply to --file=audit (got --file=${file})`,
            );
        }
    }
    return file;
}

export async function runLogsCommand(args, deps = {}) {
    const { values } = parseArgs({ args, options: OPTIONS });
    const file = validateFile(values);

    const limit = values.limit !== undefined ? Number(values.limit) : null;
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error(`mnotes logs: --limit must be a positive integer, got "${values.limit}"`);
    }
    const follow = values.follow === true;
    const logPath = join(deps.logDir ?? defaultLogDir(), `${file}.log`);
    const runOptions = { limit, follow, write: deps.write, signal: deps.signal };

    return file === 'audit'
        ? runAuditLogCommand(logPath, values, runOptions)
        : runRawLogCommand(logPath, runOptions);
}
