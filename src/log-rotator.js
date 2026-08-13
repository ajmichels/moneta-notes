import { existsSync, statSync } from 'node:fs';

export function shouldRotate(filePath, policy) {
    if (!existsSync(filePath)) {
        return false;
    }

    const stats = statSync(filePath);
    return stats.size >= policy.maxSizeBytes;
}
