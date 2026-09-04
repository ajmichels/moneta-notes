import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logDir as platformLogDir } from './platform/index.js';

const LEVELS = [ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' ];

const loggerContext = new AsyncLocalStorage();
const NOOP_LOGGER = Object.fromEntries(LEVELS.map(level => [ level, () => Promise.resolve() ]));

export function runWithLogger(logger, fn) {
    return loggerContext.run(logger, fn);
}

export function getContextLogger() {
    return loggerContext.getStore() ?? NOOP_LOGGER;
}

export function defaultLogDir() {
    return platformLogDir();
}

export function getLogger(component, logDir) {
    mkdirSync(logDir, { recursive: true });

    const logFile = join(logDir, `${component}.log`);
    return Object.fromEntries(
        LEVELS.map(level => [ level, (msg, context) => writeLine(logFile, component, level, msg, context) ]),
    );
}

function writeLine(logFile, component, level, msg, context) {
    if (typeof msg !== 'string') {
        throw new TypeError('msg must be a string');
    }
    if (context !== undefined && (typeof context !== 'object' || context === null)) {
        throw new TypeError('context must be an object');
    }

    const line = formatLine(component, level, msg, context);
    return appendFile(logFile, `${line}\n`).catch(err => {
        // eslint-disable-next-line no-console
        console.error(`[logger] failed to write to ${logFile}: ${err.message}`);
    });
}

function formatLine(component, level, msg, context) {
    const timestamp = new Date().toISOString();
    const levelLabel = level.toUpperCase().padEnd(5, ' ');
    let line = `${timestamp} ${levelLabel} [${component}] ${msg}`;

    if (context) {
        for (const [ key, value ] of Object.entries(context)) {
            if (value === null || value === undefined) continue;
            line += ` ${key}=${formatValue(value)}`;
        }
    }

    return line;
}

function formatValue(value) {
    if (value instanceof BareValue) {
        return value.text;
    }
    if (typeof value === 'string') {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return String(value);
}

class BareValue {
    constructor(text) {
        this.text = text;
    }
}

export function getAuditLogger(logDir) {
    return getLogger('audit', logDir);
}

export function logAudit(auditLogger, entry) {
    const {
        tool, noteTitle = null, attachmentPath = null, source, reason = null, outcome, errorMessage = null,
    } = entry;

    if (source !== 'mcp' && source !== 'cli') {
        throw new Error(`logAudit: source must be "mcp" or "cli", got ${JSON.stringify(source)}`);
    }
    if (source === 'mcp' && !reason) {
        throw new Error('logAudit: reason is required when source is "mcp"');
    }
    if (source === 'cli' && reason !== null) {
        throw new Error('logAudit: reason must be null when source is "cli"');
    }
    if (outcome !== 'success' && outcome !== 'error') {
        throw new Error(`logAudit: outcome must be "success" or "error", got ${JSON.stringify(outcome)}`);
    }
    if (outcome === 'error' && !errorMessage) {
        throw new Error('logAudit: errorMessage is required when outcome is "error"');
    }
    if (outcome === 'success' && errorMessage !== null) {
        throw new Error('logAudit: errorMessage must be null when outcome is "success"');
    }

    // attachment_* tools identify their target by vault-relative path, not note title (S012) — the
    // audit line carries whichever identifier the calling tool actually has, never both.
    const identifierField = attachmentPath !== null ? 'attachment_path' : 'note_title';
    const identifierValue = attachmentPath !== null ? attachmentPath : noteTitle;

    return auditLogger.info(tool, {
        [identifierField]: identifierValue,
        source: new BareValue(source),
        reason,
        outcome: new BareValue(outcome),
        error_message: errorMessage,
    });
}
