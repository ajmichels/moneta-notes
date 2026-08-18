import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { getContextLogger } from './logger.js';

export function defaultVaultPath() {
    return join(homedir(), 'Documents', 'Notes');
}

export function defaultDbPath() {
    return join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db');
}

export function defaultConfigPath() {
    return join(homedir(), '.config', 'mnotes', 'config.toml');
}

export function buildDefaultConfig() {
    return {
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
        attachments: {
            max_read_bytes: 10000000,
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

    for (const key of findUnrecognizedKeys(defaults, overrides)) {
        getContextLogger().warn('unrecognized config key', { key });
    }

    getContextLogger().debug('loaded config overrides', { overridden_keys: Object.keys(overrides) });

    return deepMerge(defaults, overrides);
}

// cli/main.js and mcp/tools.js command handlers receive a plain `deps` object (built once, up
// front, via loadConfig() in production; built ad hoc with only the fields a given test cares
// about everywhere else) — this fallback means a test double that omits `config` entirely still
// exercises real built-in defaults rather than throwing on `undefined.search`/`undefined.notes`.
export function resolveConfig(deps) {
    return deps.config ?? buildDefaultConfig();
}
