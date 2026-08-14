import { vi } from 'vitest';
import { rmSync } from 'node:fs';

export function mockLogger() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    };
}

export function flushAsync() {
    return new Promise(r => setTimeout(r, 0));
}

// logAudit/getLogger's writes are deliberately fire-and-forget (S008) — a test's own fixture
// directory can still have a write land in it after the test function returns. flushAsync gives
// any in-flight write a tick to settle before we remove the directory, so it lands normally
// instead of hitting logger.js's ENOENT/EINVAL console.error fallback; maxRetries/retryDelay on
// rmSync itself remain as a backstop for whatever still races past that.
export async function cleanupTempDir(dir) {
    await flushAsync();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
