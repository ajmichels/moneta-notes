import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

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
