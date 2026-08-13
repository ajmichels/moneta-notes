import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLogDir } from './logger.js';
import { loadConfig } from './config.js';

export function shouldRotate(filePath, policy) {
    if (!existsSync(filePath)) {
        return false;
    }

    const stats = statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;

    return stats.size >= policy.maxSizeBytes || ageMs >= policy.maxAgeMs;
}

export function rotateLogFile(filePath, keepCount) {
    const oldest = `${filePath}.${keepCount}`;
    if (existsSync(oldest)) {
        rmSync(oldest);
    }

    for (let n = keepCount - 1; n >= 1; n -= 1) {
        const src = `${filePath}.${n}`;
        if (existsSync(src)) {
            renameSync(src, `${filePath}.${n + 1}`);
        }
    }

    if (existsSync(filePath)) {
        renameSync(filePath, `${filePath}.1`);
    }

    writeFileSync(filePath, '');
}

export const DEFAULT_ROTATION_POLICY = {
    maxSizeBytes: 10 * 1024 * 1024,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    keepCount: 5,
};

export const LOG_FILE_NAMES = [ 'indexer.log', 'mcp-server.log', 'audit.log' ];

export function rotateLogDirectory(logDir, fileNames = LOG_FILE_NAMES, policy = DEFAULT_ROTATION_POLICY) {
    for (const fileName of fileNames) {
        const filePath = join(logDir, fileName);
        if (shouldRotate(filePath, policy)) {
            rotateLogFile(filePath, policy.keepCount);
        }
    }
}

function policyFromConfig(config) {
    return {
        maxSizeBytes: config.logging.rotation_max_size_mb * 1024 * 1024,
        maxAgeMs: config.logging.rotation_max_age_days * 24 * 60 * 60 * 1000,
        keepCount: config.logging.rotation_keep,
    };
}

export function main(logDir = defaultLogDir(), config = loadConfig()) {
    rotateLogDirectory(logDir, LOG_FILE_NAMES, policyFromConfig(config));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
