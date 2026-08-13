import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildDefaultConfig, defaultVaultPath, defaultDbPath, defaultConfigPath, loadConfig, resolveConfig,
} from './config.js';
import { getLogger, runWithLogger } from './logger.js';

const tempDirs = [];

function makeTempConfigPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-'));
    tempDirs.push(dir);
    return join(dir, 'config.toml');
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('defaultVaultPath / defaultDbPath', () => {
    it('computes vault_path under the current user\'s home directory', () => {
        expect(defaultVaultPath()).toBe(join(homedir(), 'Documents', 'Notes'));
    });

    it('computes db_path under ~/Library/Application Support/mnotes', () => {
        expect(defaultDbPath()).toBe(
            join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db'),
        );
    });
});

describe('buildDefaultConfig', () => {
    it('returns the full schema with computed paths and every documented default value', () => {
        const config = buildDefaultConfig();

        expect(config).toEqual({
            vault_path: defaultVaultPath(),
            db_path: defaultDbPath(),
            embedding_model: 'Qwen3-Embedding-0.6B',
            search: {
                limit_default: 20,
                limit_max: 100,
                overfetch_multiplier: 5,
                overfetch_cap: 500,
                rrf_k: 60,
            },
            notes: {
                size_drop_threshold: 0.50,
            },
            grep: {
                line_match_cap: 10,
            },
            index: {
                debounce_ms: 15000,
                model_idle_unload_minutes: 10,
                embedding_dtype: 'q8',
                retry_backoff_seconds: [ 30, 120, 600 ],
                retry_max_attempts: 4,
            },
            logging: {
                rotation_max_size_mb: 10,
                rotation_max_age_days: 7,
                rotation_keep: 5,
            },
        });
    });

    it('returns a fresh object each call — mutating one result never affects the next', () => {
        const first = buildDefaultConfig();
        first.search.limit_default = 999;
        first.index.retry_backoff_seconds.push(9999);

        const second = buildDefaultConfig();

        expect(second.search.limit_default).toBe(20);
        expect(second.index.retry_backoff_seconds).toEqual([ 30, 120, 600 ]);
    });
});

describe('resolveConfig', () => {
    it('returns deps.config unchanged when present', () => {
        const config = { search: { limit_default: 999 } };
        expect(resolveConfig({ config })).toBe(config);
    });

    it('falls back to the built-in defaults when deps has no config', () => {
        expect(resolveConfig({})).toEqual(buildDefaultConfig());
    });
});

describe('defaultConfigPath', () => {
    it('points at ~/.config/mnotes/config.toml', () => {
        expect(defaultConfigPath()).toBe(join(homedir(), '.config', 'mnotes', 'config.toml'));
    });
});

describe('loadConfig: no file on disk', () => {
    it('returns the built-in defaults untouched when the config file does not exist', () => {
        const configPath = makeTempConfigPath();

        expect(loadConfig(configPath)).toEqual(buildDefaultConfig());
    });

    it('logs a debug line via the context logger noting no config.toml was found', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const configPath = makeTempConfigPath();

        runWithLogger(logger, () => loadConfig(configPath));

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('DEBUG [mcp-server] no config.toml found, using built-in defaults');
        });
        rmSync(logDir, { recursive: true, force: true });
    });
});

describe('loadConfig: sparse top-level override', () => {
    it('merges one overridden top-level key over the defaults, leaving the rest untouched', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "/custom/vault/path"\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.vault_path).toBe('/custom/vault/path');
        expect(config.db_path).toBe(buildDefaultConfig().db_path);
        expect(config.embedding_model).toBe('Qwen3-Embedding-0.6B');
        expect(config.search.limit_default).toBe(20);
    });

    it('logs a debug line via the context logger naming the overridden top-level keys', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "/custom/vault/path"\n', 'utf8');

        runWithLogger(logger, () => loadConfig(configPath));

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('DEBUG [mcp-server] loaded config overrides');
            expect(line).toContain('overridden_keys=vault_path');
        });
        rmSync(logDir, { recursive: true, force: true });
    });
});

describe('loadConfig: nested section override', () => {
    it('merges one overridden key within a section, leaving sibling keys at their defaults', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '[search]\nlimit_default = 50\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.search.limit_default).toBe(50);
        expect(config.search.limit_max).toBe(100);
        expect(config.search.rrf_k).toBe(60);
    });

    it('merges overrides across multiple different sections independently', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ '[notes]', 'size_drop_threshold = 0.75', '', '[index]', 'debounce_ms = 5000' ].join('\n'),
            'utf8',
        );

        const config = loadConfig(configPath);

        expect(config.notes.size_drop_threshold).toBe(0.75);
        expect(config.index.debounce_ms).toBe(5000);
        expect(config.index.model_idle_unload_minutes).toBe(10);
    });

    it('replaces an array value wholesale rather than merging its elements', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '[index]\nretry_backoff_seconds = [10, 20]\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.index.retry_backoff_seconds).toEqual([ 10, 20 ]);
        expect(config.index.retry_max_attempts).toBe(4);
    });
});

describe('loadConfig: malformed TOML and empty file', () => {
    it('throws a descriptive error naming the file path for invalid TOML syntax', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "unterminated\n', 'utf8');

        expect(() => loadConfig(configPath)).toThrow(new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('returns the defaults for a zero-byte config file, same as no file at all', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '', 'utf8');

        expect(loadConfig(configPath)).toEqual(buildDefaultConfig());
    });
});

describe('loadConfig: unrecognized keys', () => {
    it('logs a warn line per unrecognized key without rejecting the load', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ 'database_path = "/oops"', '', '[search]', 'limt_default = 50' ].join('\n'),
            'utf8',
        );

        const config = runWithLogger(logger, () => loadConfig(configPath));

        expect(config.vault_path).toBe(buildDefaultConfig().vault_path);
        expect(config.search.limit_default).toBe(20);

        await vi.waitFor(() => {
            const lines = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim().split('\n');
            expect(lines.some(line =>
                line.includes('WARN  [mcp-server] unrecognized config key') && line.includes('key="database_path"'),
            )).toBe(true);
            expect(lines.some(line =>
                line.includes('WARN  [mcp-server] unrecognized config key') && line.includes('key="search.limt_default"'),
            )).toBe(true);
        });
        rmSync(logDir, { recursive: true, force: true });
    });

    it('does not warn when every key in the file matches the schema', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '[search]\nlimit_default = 50\n', 'utf8');

        runWithLogger(logger, () => loadConfig(configPath));

        await vi.waitFor(() => {
            const lines = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim().split('\n');
            expect(lines.some(line => line.includes('unrecognized config key'))).toBe(false);
        });
        rmSync(logDir, { recursive: true, force: true });
    });
});
