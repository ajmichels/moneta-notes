import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger, defaultLogDir } from './logger.js';

const tempDirs = [];

function makeTempLogDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-logger-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
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

    it('defaultLogDir points at ~/Library/Logs/com.ajmichels.mnotes', () => {
        expect(defaultLogDir()).toBe(join(homedir(), 'Library', 'Logs', 'com.ajmichels.mnotes'));
    });
});
