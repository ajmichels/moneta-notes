import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger, defaultLogDir, getAuditLogger, logAudit, runWithLogger, getContextLogger } from './logger.js';
import { logDir as platformLogDir } from './platform/index.js';
import { cleanupTempDir } from '../vitest.helpers.js';

const tempDirs = [];

function makeTempLogDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-logger-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('getLogger', () => {
    it('writes a line tagged with the component, level, and message', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        await logger.info('daemon started');

        const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
        expect(line).toMatch(/^\S+ INFO {2}\[indexer\] daemon started$/);
    });

    it('routes different components to separate files in the same directory', async () => {
        const logDir = makeTempLogDir();
        const indexerLogger = getLogger('indexer', logDir);
        const mcpLogger = getLogger('mcp-server', logDir);

        await indexerLogger.info('from indexer');
        await mcpLogger.info('from mcp');

        const indexerLine = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
        const mcpLine = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
        expect(indexerLine).toContain('from indexer');
        expect(mcpLine).toContain('from mcp');
    });

    it('pads level labels to a consistent width', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        await logger.warn('short level');
        await logger.error('longer level');

        const [ warnLine, errorLine ] = readFileSync(join(logDir, 'indexer.log'), 'utf8')
            .trim()
            .split('\n');
        expect(warnLine).toMatch(/WARN {2}\[indexer\]/);
        expect(errorLine).toMatch(/ERROR \[indexer\]/);
    });

    it('renders trailing context as quoted-string or bare key=value pairs, in key order', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        await logger.warn('hash mismatch', { note_title: 'Weekly Notes/2026-W32', retries: 3 });

        const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
        expect(line).toBe(
            `${line.slice(0, 24)} WARN  [indexer] hash mismatch note_title="Weekly Notes/2026-W32" retries=3`,
        );
    });

    it('omits null/undefined context values entirely, with no placeholder', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        await logger.info('partial context', { note_title: 'Test.md', reason: null, extra: undefined });

        const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
        expect(line).toContain('note_title="Test.md"');
        expect(line).not.toContain('reason');
        expect(line).not.toContain('extra');
    });

    it('throws a TypeError for a non-string message', () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        expect(() => logger.info(42)).toThrow(TypeError);
    });

    it('throws a TypeError for a non-object context', () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        expect(() => logger.info('msg', 'not an object')).toThrow(TypeError);
    });
});

describe('getLogger: directory creation and defaultLogDir', () => {
    it('creates the log directory recursively if it does not exist yet', async () => {
        const base = makeTempLogDir();
        const nested = join(base, 'nested', 'logs');
        const logger = getLogger('indexer', nested);
        await logger.info('created nested dir');

        const line = readFileSync(join(nested, 'indexer.log'), 'utf8').trim();
        expect(line).toContain('created nested dir');
    });

    it('defaultLogDir delegates to the platform module (S009)', () => {
        expect(defaultLogDir()).toBe(platformLogDir());
    });
});

describe('logAudit', () => {
    it('writes only the allowlisted fields, dropping note body/diff even if passed', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        await logAudit(auditLogger, {
            tool: 'note_write',
            noteTitle: 'Weekly Notes/2026-W32',
            source: 'mcp',
            reason: 'testing redaction',
            outcome: 'success',
            body: 'SECRET NOTE CONTENT SHOULD NEVER APPEAR',
            diff: '-old\n+SECRET DIFF LINE',
        });

        const line = readFileSync(join(logDir, 'audit.log'), 'utf8').trim();
        expect(line).not.toContain('SECRET NOTE CONTENT');
        expect(line).not.toContain('SECRET DIFF LINE');
        expect(line).toContain('INFO  [audit] note_write');
        expect(line).toContain('note_title="Weekly Notes/2026-W32"');
        expect(line).toContain('source=mcp');
        expect(line).toContain('reason="testing redaction"');
        expect(line).toContain('outcome=success');
        expect(line).not.toContain('error_message');
    });

    it('writes at info level even when outcome is "error", including the error message', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        await logAudit(auditLogger, {
            tool: 'write',
            noteTitle: 'Test.md',
            source: 'cli',
            outcome: 'error',
            errorMessage: 'hash mismatch',
        });

        const line = readFileSync(join(logDir, 'audit.log'), 'utf8').trim();
        expect(line).toContain('INFO  [audit] write');
        expect(line).toContain('source=cli');
        expect(line).not.toContain('reason=');
        expect(line).toContain('error_message="hash mismatch"');
    });

    it('logs under attachment_path instead of note_title when attachmentPath is given', async () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        await logAudit(auditLogger, {
            tool: 'attachment_write',
            attachmentPath: 'Attachments/receipt.pdf',
            source: 'mcp',
            reason: 'saving expense receipt',
            outcome: 'success',
        });

        const line = readFileSync(join(logDir, 'audit.log'), 'utf8').trim();
        expect(line).toContain('INFO  [audit] attachment_write');
        expect(line).toContain('attachment_path="Attachments/receipt.pdf"');
        expect(line).not.toContain('note_title=');
    });

    it('throws when source is "mcp" and reason is missing', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'note_write',
                noteTitle: 'Test.md',
                source: 'mcp',
                outcome: 'success',
            }),
        ).toThrow(/reason/);
    });

    it('throws when source is "cli" and reason is non-null', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                reason: 'should not be here',
                outcome: 'success',
            }),
        ).toThrow(/reason/);
    });

    it('throws when outcome is "error" and errorMessage is missing', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                outcome: 'error',
            }),
        ).toThrow(/errorMessage/);
    });

    it('throws when outcome is "success" and errorMessage is non-null', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                outcome: 'success',
                errorMessage: 'should not be here',
            }),
        ).toThrow(/errorMessage/);
    });

    it('throws on an unrecognized source or outcome value', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'web',
                outcome: 'success',
            }),
        ).toThrow(/source/);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                outcome: 'partial',
            }),
        ).toThrow(/outcome/);
    });
});

describe('runWithLogger / getContextLogger', () => {
    it('returns a no-op logger outside of any runWithLogger context', async () => {
        const logger = getContextLogger();
        await expect(logger.info('no context')).resolves.toBeUndefined();
        await expect(logger.warn('no context', { key: 'value' })).resolves.toBeUndefined();
    });

    it('returns the active logger inside runWithLogger', () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);

        runWithLogger(logger, () => {
            expect(getContextLogger()).toBe(logger);
        });
    });

    it('keeps the context available across an await boundary', async () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);

        await runWithLogger(logger, async () => {
            await Promise.resolve();
            expect(getContextLogger()).toBe(logger);
        });
    });

    it('isolates concurrent runWithLogger calls from each other', async () => {
        const logDirA = makeTempLogDir();
        const logDirB = makeTempLogDir();
        const loggerA = getLogger('indexer', logDirA);
        const loggerB = getLogger('mcp-server', logDirB);

        await Promise.all([
            runWithLogger(loggerA, async () => {
                await Promise.resolve();
                expect(getContextLogger()).toBe(loggerA);
            }),
            runWithLogger(loggerB, async () => {
                await Promise.resolve();
                expect(getContextLogger()).toBe(loggerB);
            }),
        ]);
    });

    it('reverts to the no-op logger once runWithLogger returns', () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);

        runWithLogger(logger, () => {});
        expect(getContextLogger()).not.toBe(logger);
    });
});
