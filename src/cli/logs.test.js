import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuditLogger, logAudit } from '../logger.js';
import { parseAuditLine, parseSince, filterEntries, runLogsCommand } from './logs.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempLogDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-cli-logs-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('parseAuditLine', () => {
    it('parses a well-formed audit line into a structured entry', () => {
        const line = '2026-08-13T18:24:00.113Z INFO  [audit] note_write '
            + 'note_title="Weekly Notes/2026-W32" source=mcp reason="testing redaction" outcome=success';

        expect(parseAuditLine(line)).toEqual({
            timestamp: '2026-08-13T18:24:00.113Z',
            level: 'INFO',
            component: 'audit',
            tool: 'note_write',
            noteTitle: 'Weekly Notes/2026-W32',
            attachmentPath: null,
            source: 'mcp',
            reason: 'testing redaction',
            outcome: 'success',
            errorMessage: null,
        });
    });

    it('parses attachment_path in place of note_title', () => {
        const line = '2026-08-13T18:24:11.402Z INFO  [audit] attachment_write '
            + 'attachment_path="Attachments/receipt.pdf" source=mcp reason="saving receipt" outcome=success';

        const entry = parseAuditLine(line);
        expect(entry.noteTitle).toBeNull();
        expect(entry.attachmentPath).toBe('Attachments/receipt.pdf');
    });

    it('unescapes backslash-escaped quotes inside a quoted value', () => {
        const line = '2026-08-13T18:24:00.113Z INFO  [audit] write note_title="A \\"Quoted\\" Note.md" '
            + 'source=cli outcome=success';

        expect(parseAuditLine(line).noteTitle).toBe('A "Quoted" Note.md');
    });

    it('captures error_message on a failed mutation', () => {
        const line = '2026-08-13T18:24:05.221Z INFO  [audit] write note_title="Test.md" '
            + 'source=cli outcome=error error_message="hash mismatch"';

        const entry = parseAuditLine(line);
        expect(entry.outcome).toBe('error');
        expect(entry.errorMessage).toBe('hash mismatch');
    });

    it('returns null for a blank line', () => {
        expect(parseAuditLine('')).toBeNull();
    });

    it('returns null for a line missing the bracketed component', () => {
        expect(parseAuditLine('2026-08-13T18:24:00.113Z INFO note_write outcome=success')).toBeNull();
    });
});

describe('parseSince', () => {
    it('parses relative shorthand durations into a Date', () => {
        const before = Date.now();
        const result = parseSince('1h');
        const after = Date.now();

        expect(result.getTime()).toBeGreaterThanOrEqual(before - 3600_000);
        expect(result.getTime()).toBeLessThanOrEqual(after - 3600_000 + 1);
    });

    it('parses an ISO-8601 timestamp directly', () => {
        expect(parseSince('2026-08-13T00:00:00.000Z').toISOString()).toBe('2026-08-13T00:00:00.000Z');
    });

    it('throws a descriptive error for an unparseable value', () => {
        expect(() => parseSince('not-a-date')).toThrow(/--since/);
    });
});

describe('filterEntries', () => {
    const entries = [
        {
            timestamp: '2026-08-13T00:00:00.000Z', tool: 'note_write', noteTitle: 'A.md',
            attachmentPath: null, source: 'mcp', outcome: 'success', reason: 'r', errorMessage: null,
        },
        {
            timestamp: '2026-08-14T00:00:00.000Z', tool: 'write', noteTitle: 'B.md',
            attachmentPath: null, source: 'cli', outcome: 'error', reason: null, errorMessage: 'boom',
        },
    ];

    it('filters by source', () => {
        expect(filterEntries(entries, { source: 'mcp' })).toEqual([ entries[0] ]);
    });

    it('filters by tool', () => {
        expect(filterEntries(entries, { tool: 'write' })).toEqual([ entries[1] ]);
    });

    it('filters by note, matching either note_title or attachment_path', () => {
        expect(filterEntries(entries, { note: 'B.md' })).toEqual([ entries[1] ]);
    });

    it('filters by outcome', () => {
        expect(filterEntries(entries, { outcome: 'error' })).toEqual([ entries[1] ]);
    });

    it('filters by since', () => {
        expect(filterEntries(entries, { since: new Date('2026-08-13T12:00:00.000Z') })).toEqual([ entries[1] ]);
    });

    it('returns everything when no filters are given', () => {
        expect(filterEntries(entries, {})).toEqual(entries);
    });
});

describe('runLogsCommand (non-follow)', () => {
    it('prints every audit entry oldest-first with no filters', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);
        await logAudit(auditLogger, { tool: 'note_write', noteTitle: 'A.md', source: 'mcp', reason: 'r', outcome: 'success' });
        await logAudit(auditLogger, { tool: 'write', noteTitle: 'B.md', source: 'cli', outcome: 'success' });

        const result = await runLogsCommand([], { logDir });

        expect(result.exitCode).toBe(0);
        const lines = result.stdout.trim().split('\n');
        expect(lines[0]).toMatch(/^timestamp/);
        expect(lines[2]).toContain('note_write');
        expect(lines[3]).toContain('write');
    });

    it('applies --source/--tool/--note/--outcome filters', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);
        await logAudit(auditLogger, { tool: 'note_write', noteTitle: 'A.md', source: 'mcp', reason: 'r', outcome: 'success' });
        await logAudit(auditLogger, { tool: 'write', noteTitle: 'B.md', source: 'cli', outcome: 'error', errorMessage: 'boom' });

        const result = await runLogsCommand([ '--source=cli' ], { logDir });

        expect(result.stdout).toContain('B.md');
        expect(result.stdout).not.toContain('A.md');
    });

    it('rejects an unrecognized --source value', async () => {
        const logDir = makeTempLogDir();
        await expect(runLogsCommand([ '--source=web' ], { logDir })).rejects.toThrow(/--source/);
    });

    it('rejects an unrecognized --outcome value', async () => {
        const logDir = makeTempLogDir();
        await expect(runLogsCommand([ '--outcome=partial' ], { logDir })).rejects.toThrow(/--outcome/);
    });

    it('--limit returns only the last N matching entries', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);
        for (let i = 0; i < 5; i += 1) {
            await logAudit(auditLogger, { tool: 'write', noteTitle: `N${i}.md`, source: 'cli', outcome: 'success' });
        }

        const result = await runLogsCommand([ '--limit=2' ], { logDir });

        expect(result.stdout).toContain('N3.md');
        expect(result.stdout).toContain('N4.md');
        expect(result.stdout).not.toContain('N2.md');
    });

    it('rejects a non-positive-integer --limit', async () => {
        const logDir = makeTempLogDir();
        await expect(runLogsCommand([ '--limit=0' ], { logDir })).rejects.toThrow(/--limit/);
        await expect(runLogsCommand([ '--limit=abc' ], { logDir })).rejects.toThrow(/--limit/);
    });

    it('--json emits one compact JSON object per line', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);
        await logAudit(auditLogger, { tool: 'note_write', noteTitle: 'A.md', source: 'mcp', reason: 'r', outcome: 'success' });

        const result = await runLogsCommand([ '--json' ], { logDir });

        const parsed = JSON.parse(result.stdout.trim());
        expect(parsed).toMatchObject({ tool: 'note_write', note_title: 'A.md', source: 'mcp', outcome: 'success' });
    });

    it('returns an empty result when audit.log does not exist yet', async () => {
        const logDir = makeTempLogDir();
        const result = await runLogsCommand([], { logDir });
        expect(result.exitCode).toBe(0);
    });
});

describe('runLogsCommand --file', () => {
    it('rejects an unrecognized --file value', async () => {
        const logDir = makeTempLogDir();
        await expect(runLogsCommand([ '--file=bogus' ], { logDir })).rejects.toThrow(/--file/);
    });

    it('errors when an audit-only flag is combined with a non-audit --file', async () => {
        const logDir = makeTempLogDir();
        await expect(runLogsCommand([ '--file=indexer', '--tool=note_write' ], { logDir }))
            .rejects.toThrow(/--tool.*only apply to --file=audit/);
        await expect(runLogsCommand([ '--file=mcp-server', '--outcome=error' ], { logDir }))
            .rejects.toThrow(/--outcome/);
        await expect(runLogsCommand([ '--file=indexer', '--json' ], { logDir }))
            .rejects.toThrow(/--json/);
    });

    it('names every offending flag when several are combined with a non-audit --file', async () => {
        await expect(runLogsCommand([ '--file=indexer', '--source=mcp', '--outcome=error' ], {}))
            .rejects.toThrow(/--source, --outcome/);
    });

    it('prints indexer.log as raw lines, unaligned, with no parsing', async () => {
        const logDir = makeTempLogDir();
        writeFileSync(
            join(logDir, 'indexer.log'),
            '2026-08-13T18:22:10.512Z INFO  [indexer] daemon started\n'
            + '2026-08-13T18:23:01.004Z WARN  [indexer] hash mismatch note_title="A.md"\n',
        );

        const result = await runLogsCommand([ '--file=indexer' ], { logDir });

        expect(result.stdout).toBe(
            '2026-08-13T18:22:10.512Z INFO  [indexer] daemon started\n'
            + '2026-08-13T18:23:01.004Z WARN  [indexer] hash mismatch note_title="A.md"\n',
        );
    });

    it('prints mcp-server.log as raw lines', async () => {
        const logDir = makeTempLogDir();
        writeFileSync(join(logDir, 'mcp-server.log'), '2026-08-13T18:22:10.512Z INFO  [mcp-server] server started\n');

        const result = await runLogsCommand([ '--file=mcp-server' ], { logDir });

        expect(result.stdout).toBe('2026-08-13T18:22:10.512Z INFO  [mcp-server] server started\n');
    });

    it('reads the daemon/logrotate stdout+stderr passthrough files, mapping name to <name>.log', async () => {
        const logDir = makeTempLogDir();
        writeFileSync(join(logDir, 'daemon.stdout.log'), 'daemon stdout line\n');
        writeFileSync(join(logDir, 'daemon.stderr.log'), 'daemon stderr line\n');
        writeFileSync(join(logDir, 'logrotate.stdout.log'), 'logrotate stdout line\n');
        writeFileSync(join(logDir, 'logrotate.stderr.log'), 'logrotate stderr line\n');

        expect((await runLogsCommand([ '--file=daemon.stdout' ], { logDir })).stdout).toBe('daemon stdout line\n');
        expect((await runLogsCommand([ '--file=daemon.stderr' ], { logDir })).stdout).toBe('daemon stderr line\n');
        expect((await runLogsCommand([ '--file=logrotate.stdout' ], { logDir })).stdout)
            .toBe('logrotate stdout line\n');
        expect((await runLogsCommand([ '--file=logrotate.stderr' ], { logDir })).stdout)
            .toBe('logrotate stderr line\n');
    });

    it('applies --limit as the last N raw lines for a non-audit file', async () => {
        const logDir = makeTempLogDir();
        writeFileSync(join(logDir, 'indexer.log'), [ 'line1', 'line2', 'line3' ].join('\n') + '\n');

        const result = await runLogsCommand([ '--file=indexer', '--limit=2' ], { logDir });

        expect(result.stdout).toBe('line2\nline3\n');
    });

    it('returns an empty result when the requested log file does not exist yet', async () => {
        const logDir = makeTempLogDir();
        const result = await runLogsCommand([ '--file=indexer' ], { logDir });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
    });

    it('--follow on a non-audit file streams raw appended lines', async () => {
        const logDir = makeTempLogDir();
        writeFileSync(join(logDir, 'indexer.log'), 'old line\n');

        const controller = new AbortController();
        const written = [];
        const resultPromise = runLogsCommand([ '--file=indexer', '--follow' ], {
            logDir,
            write: (s) => written.push(s),
            signal: controller.signal,
        });

        await new Promise((r) => setTimeout(r, 50));
        appendFileSync(join(logDir, 'indexer.log'), 'new line\n');
        await new Promise((r) => setTimeout(r, 100));
        controller.abort();

        const result = await resultPromise;
        expect(result.exitCode).toBe(0);
        const output = written.join('');
        expect(output).toContain('old line');
        expect(output).toContain('new line');
    });
});

describe('runLogsCommand --follow', () => {
    it('prints a default backlog of the last 20 matching entries, then streams new ones until aborted', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);
        for (let i = 0; i < 3; i += 1) {
            await logAudit(auditLogger, { tool: 'write', noteTitle: `Old${i}.md`, source: 'cli', outcome: 'success' });
        }

        const controller = new AbortController();
        const written = [];
        const resultPromise = runLogsCommand([ '--follow', '--json' ], {
            logDir,
            write: (s) => written.push(s),
            signal: controller.signal,
        });

        await new Promise((r) => setTimeout(r, 50));
        appendFileSync(
            join(logDir, 'audit.log'),
            '2026-08-13T18:24:00.113Z INFO  [audit] note_write note_title="New.md" source=mcp reason="r" outcome=success\n',
        );
        await new Promise((r) => setTimeout(r, 100));
        controller.abort();

        const result = await resultPromise;
        expect(result.exitCode).toBe(0);
        const output = written.join('');
        expect(output).toContain('Old0.md');
        expect(output).toContain('Old2.md');
        expect(output).toContain('New.md');
    });

    it('honors --limit as the backlog size when following', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);
        for (let i = 0; i < 5; i += 1) {
            await logAudit(auditLogger, { tool: 'write', noteTitle: `N${i}.md`, source: 'cli', outcome: 'success' });
        }

        const controller = new AbortController();
        const written = [];
        const resultPromise = runLogsCommand([ '--follow', '--limit=2', '--json' ], {
            logDir,
            write: (s) => written.push(s),
            signal: controller.signal,
        });

        await new Promise((r) => setTimeout(r, 50));
        controller.abort();
        await resultPromise;

        const output = written.join('');
        expect(output).toContain('N3.md');
        expect(output).toContain('N4.md');
        expect(output).not.toContain('N2.md');
    });

    it('applies filters to the live-streamed entries, not just the backlog', async () => {
        const logDir = makeTempLogDir();
        writeFileSync(join(logDir, 'audit.log'), '');

        const controller = new AbortController();
        const written = [];
        const resultPromise = runLogsCommand([ '--follow', '--source=mcp', '--json' ], {
            logDir,
            write: (s) => written.push(s),
            signal: controller.signal,
        });

        await new Promise((r) => setTimeout(r, 50));
        appendFileSync(
            join(logDir, 'audit.log'),
            '2026-08-13T18:24:00.113Z INFO  [audit] write note_title="CliOne.md" source=cli outcome=success\n'
            + '2026-08-13T18:24:01.113Z INFO  [audit] note_write note_title="McpOne.md" source=mcp reason="r" outcome=success\n',
        );
        await new Promise((r) => setTimeout(r, 100));
        controller.abort();
        await resultPromise;

        const output = written.join('');
        expect(output).toContain('McpOne.md');
        expect(output).not.toContain('CliOne.md');
    });
});
