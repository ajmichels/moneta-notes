import { existsSync, statSync } from 'node:fs';

export function shouldRotate(filePath, policy) {
    if (!existsSync(filePath)) {
        return false;
    }

    const stats = statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;

    return stats.size >= policy.maxSizeBytes || ageMs >= policy.maxAgeMs;
}
