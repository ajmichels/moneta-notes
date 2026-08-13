import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const LEVELS = [ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' ];

export function getLogger(component, logDir) {
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
    if (typeof value === 'string') {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return String(value);
}
