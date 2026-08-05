import { vi } from 'vitest';

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
