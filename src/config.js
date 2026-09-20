import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'smol-toml';
import { getContextLogger } from './logger.js';
import { appSupportDir } from './platform/index.js';

export function defaultVaultPath() {
    return join(homedir(), 'Documents', 'Notes');
}

export function defaultDbPathForVault(name) {
    return join(appSupportDir(), `index-${name}.db`);
}

export function defaultConfigPath() {
    return join(homedir(), '.config', 'mnotes', 'config.toml');
}

export const VAULT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function assertValidVaultName(name) {
    if (typeof name !== 'string' || !VAULT_NAME_PATTERN.test(name)) {
        throw new Error(`invalid vault name "${name}" — vault names must match ${VAULT_NAME_PATTERN}`);
    }
}

export function slugifyVaultName(pathString) {
    return basename(pathString)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function buildDefaultConfig() {
    return {
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
    };
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
    const merged = { ...base };
    for (const [ key, value ] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(base[key])) {
            merged[key] = deepMerge(base[key], value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function findUnrecognizedKeys(base, override, prefix = '') {
    const unrecognized = [];
    for (const [ key, value ] of Object.entries(override)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (!(key in base)) {
            unrecognized.push(path);
        } else if (isPlainObject(value) && isPlainObject(base[key])) {
            unrecognized.push(...findUnrecognizedKeys(base[key], value, path));
        }
    }
    return unrecognized;
}

export function loadConfig(configPath = defaultConfigPath()) {
    const defaults = buildDefaultConfig();

    if (!existsSync(configPath)) {
        getContextLogger().debug('no config.toml found, using built-in defaults');
        return defaults;
    }

    const raw = readFileSync(configPath, 'utf8');

    let overrides;
    try {
        overrides = parse(raw);
    } catch (err) {
        throw new Error(`loadConfig: malformed TOML in "${configPath}": ${err.message}`, { cause: err });
    }

    if ('vault_path' in overrides && 'vaults' in overrides) {
        throw new Error(
            `loadConfig: config.toml mixes the legacy vault_path key with [vaults.*] — remove one (in "${configPath}")`,
        );
    }

    if ('vault_path' in overrides) {
        const name = slugifyVaultName(overrides.vault_path);
        overrides.vaults = {
            [name]: {
                path: overrides.vault_path,
                ...(overrides.db_path !== undefined ? { db_path: overrides.db_path } : {}),
            },
        };
        delete overrides.vault_path;
        delete overrides.db_path;
    }

    if (overrides.vaults) {
        for (const name of Object.keys(overrides.vaults)) {
            assertValidVaultName(name);
        }
    }

    const { vaults: overrideVaults, default_vault: overrideDefaultVault, ...restOverrides } = overrides;

    for (const key of findUnrecognizedKeys(defaults, restOverrides)) {
        getContextLogger().warn('unrecognized config key', { key });
    }

    getContextLogger().debug('loaded config overrides', { overridden_keys: Object.keys(overrides) });

    const merged = deepMerge(defaults, restOverrides);
    if (overrideVaults) {
        merged.vaults = overrideVaults;
    }
    if (overrideDefaultVault !== undefined) {
        merged.default_vault = overrideDefaultVault;
    }

    if (merged.default_vault !== undefined && !(merged.default_vault in merged.vaults)) {
        throw new Error(
            `loadConfig: default_vault "${merged.default_vault}" is not a configured vault ` +
            `(configured: ${Object.keys(merged.vaults).sort().join(', ')})`,
        );
    }

    return merged;
}

export function resolveVault(config, name = null) {
    const vaultNames = Object.keys(config.vaults);

    let resolvedName = name;
    if (resolvedName !== null) {
        if (!(resolvedName in config.vaults)) {
            throw new Error(
                `resolveVault: unknown vault "${resolvedName}" (configured: ${vaultNames.sort().join(', ')})`,
            );
        }
    } else if (config.default_vault !== undefined) {
        resolvedName = config.default_vault;
    } else if (vaultNames.length === 1) {
        resolvedName = vaultNames[0];
    } else {
        throw new Error(
            `resolveVault: multiple vaults configured (${vaultNames.sort().join(', ')}) but no default_vault ` +
            'key — pass name explicitly or set default_vault',
        );
    }

    const entry = config.vaults[resolvedName];
    return {
        name: resolvedName,
        path: entry.path,
        dbPath: entry.db_path ?? defaultDbPathForVault(resolvedName),
        description: entry.description ?? null,
    };
}

export function listVaults(config) {
    const vaultNames = Object.keys(config.vaults);
    const defaultName = config.default_vault ?? (vaultNames.length === 1 ? vaultNames[0] : null);

    return [ ...vaultNames ].sort().map((name) => ({
        name,
        description: config.vaults[name].description ?? null,
        isDefault: name === defaultName,
    }));
}

export function resolveVaultsForQuery(config, name = null) {
    if (name !== null) {
        return { vaults: [ resolveVault(config, name) ] };
    }

    if (Object.keys(config.vaults).length === 1) {
        return { vaults: [ resolveVault(config, null) ] };
    }

    return { vaults: listVaults(config).map((v) => resolveVault(config, v.name)) };
}

// cli/main.js and mcp/tools.js command handlers receive a plain `deps` object (built once, up
// front, via loadConfig() in production; built ad hoc with only the fields a given test cares
// about everywhere else) — this fallback means a test double that omits `config` entirely still
// exercises real built-in defaults rather than throwing on `undefined.search`/`undefined.notes`.
export function resolveConfig(deps) {
    return deps.config ?? buildDefaultConfig();
}
