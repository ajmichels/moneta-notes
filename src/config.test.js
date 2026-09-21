import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildDefaultConfig, defaultVaultPath, defaultDbPathForVault, defaultConfigPath, loadConfig, resolveConfig,
    slugifyVaultName, assertValidVaultName, resolveVault, listVaults, resolveVaultsForQuery,
} from './config.js';
import { getLogger, runWithLogger } from './logger.js';
import { appSupportDir } from './platform/index.js';
import { cleanupTempDir } from '../vitest.helpers.js';

const tempDirs = [];

function makeTempConfigPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-'));
    tempDirs.push(dir);
    return join(dir, 'config.toml');
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('defaultVaultPath / defaultDbPathForVault', () => {
    it('computes vault_path under the current user\'s home directory', () => {
        expect(defaultVaultPath()).toBe(join(homedir(), 'Documents', 'Notes'));
    });

    it('computes a per-vault db_path under the platform module\'s app-support directory (S009)', () => {
        expect(defaultDbPathForVault('notes')).toBe(join(appSupportDir(), 'index-notes.db'));
        expect(defaultDbPathForVault('dnd')).toBe(join(appSupportDir(), 'index-dnd.db'));
    });
});

describe('slugifyVaultName', () => {
    it('lowercases a simple basename', () => {
        expect(slugifyVaultName(join(homedir(), 'Documents', 'Notes'))).toBe('notes');
    });

    it('collapses non-alphanumeric runs to a single dash and trims leading/trailing dashes', () => {
        expect(slugifyVaultName(join(homedir(), 'Documents', 'D&D'))).toBe('d-d');
        expect(slugifyVaultName('/a/b/-- weird name!! --')).toBe('weird-name');
    });
});

describe('assertValidVaultName', () => {
    it('accepts names matching ^[a-z0-9][a-z0-9_-]*$', () => {
        expect(() => assertValidVaultName('notes')).not.toThrow();
        expect(() => assertValidVaultName('d-d')).not.toThrow();
        expect(() => assertValidVaultName('vault_2')).not.toThrow();
        expect(() => assertValidVaultName('2vault')).not.toThrow();
    });

    it('throws naming the bad key for an invalid name', () => {
        expect(() => assertValidVaultName('My Vault')).toThrow(/My Vault/);
        expect(() => assertValidVaultName('abc def')).toThrow(/abc def/);
        expect(() => assertValidVaultName('-abc')).toThrow(/-abc/);
        expect(() => assertValidVaultName('')).toThrow();
    });
});

describe('buildDefaultConfig', () => {
    it('returns the full schema with a single default vault and no default_vault key', () => {
        const config = buildDefaultConfig();

        expect(config).toEqual({
            vaults: {
                notes: { path: defaultVaultPath() },
            },
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
            attachments: {
                max_read_bytes: 10000000,
            },
            vectors: {
                nearest_k_default: 10,
                calibrate_sample_size: 500,
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
        expect(config.default_vault).toBeUndefined();
    });

    it('returns a fresh object each call — mutating one result never affects the next', () => {
        const first = buildDefaultConfig();
        first.search.limit_default = 999;
        first.index.retry_backoff_seconds.push(9999);
        first.vaults.notes.path = '/mutated';

        const second = buildDefaultConfig();

        expect(second.search.limit_default).toBe(20);
        expect(second.index.retry_backoff_seconds).toEqual([ 30, 120, 600 ]);
        expect(second.vaults.notes.path).toBe(defaultVaultPath());
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
        await cleanupTempDir(logDir);
    });
});

describe('loadConfig: legacy flat vault_path/db_path', () => {
    it('synthesizes a single [vaults.<slug>] entry, and that vault becomes the resolved default', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "/custom/vault/path"\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.vault_path).toBeUndefined();
        expect(config.vaults).toEqual({ path: { path: '/custom/vault/path' } });

        const resolved = resolveVault(config);
        expect(resolved).toEqual({
            name: 'path',
            path: '/custom/vault/path',
            dbPath: defaultDbPathForVault('path'),
            description: null,
        });
    });

    it('carries an explicit legacy db_path through onto the synthesized vault entry', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            'vault_path = "/custom/vault/path"\ndb_path = "/custom/db.sqlite"\n',
            'utf8',
        );

        const config = loadConfig(configPath);
        const resolved = resolveVault(config);

        expect(resolved.dbPath).toBe('/custom/db.sqlite');
    });

    it('leaves every other section at its default', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "/custom/vault/path"\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.embedding_model).toBe('Qwen3-Embedding-0.6B');
        expect(config.search.limit_default).toBe(20);
    });

    it('throws when vault_path and a [vaults.*] table are both present', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ 'vault_path = "/custom/vault/path"', '', '[vaults.other]', 'path = "/other"' ].join('\n'),
            'utf8',
        );

        expect(() => loadConfig(configPath)).toThrow(/mixes the legacy vault_path key/);
    });
});

describe('loadConfig: [vaults.*] table', () => {
    it('single named vault, no default_vault — resolves with no error', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ '[vaults.dnd]', 'path = "/Users/aj/Documents/DnD"', 'description = "D&D notes"' ].join('\n'),
            'utf8',
        );

        const config = loadConfig(configPath);
        expect(config.vaults).toEqual({
            dnd: { path: '/Users/aj/Documents/DnD', description: 'D&D notes' },
        });

        const resolved = resolveVault(config);
        expect(resolved).toEqual({
            name: 'dnd',
            path: '/Users/aj/Documents/DnD',
            dbPath: defaultDbPathForVault('dnd'),
            description: 'D&D notes',
        });
    });

    it('two vaults with default_vault set — resolves to the default; an explicit name overrides it', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [
                'default_vault = "dnd"',
                '[vaults.notes]', 'path = "/Users/aj/Documents/Notes"', '',
                '[vaults.dnd]', 'path = "/Users/aj/Documents/DnD"',
            ].join('\n'),
            'utf8',
        );

        const config = loadConfig(configPath);

        expect(resolveVault(config).name).toBe('dnd');
        expect(resolveVault(config, 'notes').name).toBe('notes');
    });

    it('two vaults, no default_vault — loadConfig does not throw; resolveVault throws only when called', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [
                '[vaults.notes]', 'path = "/Users/aj/Documents/Notes"', '',
                '[vaults.dnd]', 'path = "/Users/aj/Documents/DnD"',
            ].join('\n'),
            'utf8',
        );

        const config = loadConfig(configPath);
        expect(() => resolveVault(config)).toThrow(/multiple vaults configured/);
        expect(() => resolveVault(config)).toThrow(/dnd/);
        expect(() => resolveVault(config)).toThrow(/notes/);
    });

    it('explicit unknown vault name throws naming the configured vaults', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ '[vaults.notes]', 'path = "/Users/aj/Documents/Notes"' ].join('\n'),
            'utf8',
        );

        const config = loadConfig(configPath);
        expect(() => resolveVault(config, 'bogus')).toThrow(/unknown vault "bogus"/);
        expect(() => resolveVault(config, 'bogus')).toThrow(/notes/);
    });

    it('invalid vault name in [vaults.*] throws from loadConfig', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ '[vaults."My Vault"]', 'path = "/x"' ].join('\n'),
            'utf8',
        );

        expect(() => loadConfig(configPath)).toThrow(/My Vault/);
    });

    it('a stale/typo\'d default_vault not matching any configured vault throws at load time', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ 'default_vault = "typo"', '[vaults.notes]', 'path = "/Users/aj/Documents/Notes"' ].join('\n'),
            'utf8',
        );

        expect(() => loadConfig(configPath)).toThrow(/default_vault "typo"/);
    });
});

describe('resolveVaultsForQuery', () => {
    it('name given — returns that single resolved vault, same hard error on unknown name', () => {
        const config = {
            vaults: { notes: { path: '/n' }, dnd: { path: '/d' } },
        };
        expect(resolveVaultsForQuery(config, 'dnd').vaults).toEqual([ resolveVault(config, 'dnd') ]);
        expect(() => resolveVaultsForQuery(config, 'bogus')).toThrow(/unknown vault "bogus"/);
    });

    it('name omitted, exactly one vault configured — identical to resolveVault(config, null)', () => {
        const config = { vaults: { notes: { path: '/n' } } };
        expect(resolveVaultsForQuery(config).vaults).toEqual([ resolveVault(config, null) ]);
    });

    it('name omitted, 2+ vaults, no default_vault — does not throw, returns both in name-sorted order', () => {
        const config = { vaults: { zeta: { path: '/z' }, alpha: { path: '/a' } } };

        const result = resolveVaultsForQuery(config);

        expect(result.vaults.map((v) => v.name)).toEqual([ 'alpha', 'zeta' ]);
    });

    it('name omitted, 2+ vaults, default_vault set — still returns both, not just the default', () => {
        const config = {
            default_vault: 'dnd',
            vaults: { notes: { path: '/n' }, dnd: { path: '/d' } },
        };

        const result = resolveVaultsForQuery(config);

        expect(result.vaults.map((v) => v.name).sort()).toEqual([ 'dnd', 'notes' ]);
    });

    it('name omitted, 2+ vaults — a vault with exclude_from_defaults=true is dropped from fan-out', () => {
        const config = {
            vaults: { notes: { path: '/n' }, dnd: { path: '/d', exclude_from_defaults: true } },
        };

        const result = resolveVaultsForQuery(config);

        expect(result.vaults.map((v) => v.name)).toEqual([ 'notes' ]);
    });

    it('name given explicitly — still resolves an exclude_from_defaults=true vault normally', () => {
        const config = {
            vaults: { notes: { path: '/n' }, dnd: { path: '/d', exclude_from_defaults: true } },
        };

        expect(resolveVaultsForQuery(config, 'dnd').vaults).toEqual([ resolveVault(config, 'dnd') ]);
    });

    it('name omitted, exactly one vault configured — exclude_from_defaults is ignored (still that one)', () => {
        const config = { vaults: { notes: { path: '/n', exclude_from_defaults: true } } };

        expect(resolveVaultsForQuery(config).vaults).toEqual([ resolveVault(config, null) ]);
    });

    it('name omitted, every configured vault excluded — returns an empty fan-out, not an error', () => {
        const config = {
            vaults: {
                notes: { path: '/n', exclude_from_defaults: true },
                dnd: { path: '/d', exclude_from_defaults: true },
            },
        };

        expect(resolveVaultsForQuery(config).vaults).toEqual([]);
    });
});

describe('listVaults', () => {
    it('omits path, includes description and isDefault, sorted by name', () => {
        const config = {
            default_vault: 'dnd',
            vaults: {
                dnd: { path: '/d', description: 'D&D notes' },
                notes: { path: '/n' },
            },
        };

        expect(listVaults(config)).toEqual([
            { name: 'dnd', description: 'D&D notes', isDefault: true, excludedFromDefaults: false },
            { name: 'notes', description: null, isDefault: false, excludedFromDefaults: false },
        ]);
    });

    it('marks the sole vault as default when no default_vault key is set', () => {
        const config = { vaults: { notes: { path: '/n' } } };

        expect(listVaults(config)).toEqual([
            { name: 'notes', description: null, isDefault: true, excludedFromDefaults: false },
        ]);
    });

    it('marks no vault as default when 2+ configured with no default_vault key', () => {
        const config = { vaults: { notes: { path: '/n' }, dnd: { path: '/d' } } };

        expect(listVaults(config).every((v) => v.isDefault === false)).toBe(true);
    });

    it('reports excludedFromDefaults true only for a vault with exclude_from_defaults=true', () => {
        const config = {
            vaults: {
                notes: { path: '/n' },
                dnd: { path: '/d', exclude_from_defaults: true },
            },
        };

        expect(listVaults(config)).toEqual([
            { name: 'dnd', description: null, isDefault: false, excludedFromDefaults: true },
            { name: 'notes', description: null, isDefault: false, excludedFromDefaults: false },
        ]);
    });
});

describe('loadConfig: sparse top-level override', () => {
    it('merges one overridden top-level key over the defaults, leaving the rest untouched', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'embedding_model = "Custom-Model"\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.embedding_model).toBe('Custom-Model');
        expect(config.vaults).toEqual(buildDefaultConfig().vaults);
        expect(config.search.limit_default).toBe(20);
    });

    it('logs a debug line via the context logger naming the overridden top-level keys', async () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'embedding_model = "Custom-Model"\n', 'utf8');

        runWithLogger(logger, () => loadConfig(configPath));

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('DEBUG [mcp-server] loaded config overrides');
            expect(line).toContain('overridden_keys=embedding_model');
        });
        await cleanupTempDir(logDir);
    });
});

describe('loadConfig: [attachments] section override', () => {
    it('merges max_read_bytes, leaving every other section at its default', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '[attachments]\nmax_read_bytes = 500\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.attachments.max_read_bytes).toBe(500);
        expect(config.notes.size_drop_threshold).toBe(0.50);
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

        expect(config.vaults).toEqual(buildDefaultConfig().vaults);
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
        await cleanupTempDir(logDir);
    });

    it('does not warn when every key in the file matches the schema, including [vaults.*]/default_vault', () => {
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-log-'));
        const logger = getLogger('mcp-server', logDir);
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [
                'default_vault = "dnd"', '[search]', 'limit_default = 50', '',
                '[vaults.dnd]', 'path = "/x"',
            ].join('\n'),
            'utf8',
        );

        runWithLogger(logger, () => loadConfig(configPath));

        return vi.waitFor(() => {
            const lines = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim().split('\n');
            expect(lines.some(line => line.includes('unrecognized config key'))).toBe(false);
        }).finally(() => cleanupTempDir(logDir));
    });
});
