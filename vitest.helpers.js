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
// directory can still have a write land in it after the test function returns, racing a plain
// rmSync and throwing ENOTEMPTY. maxRetries/retryDelay let Node's own rm implementation absorb
// that race instead of every test file needing its own retry loop.
export function cleanupTempDir(dir) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
