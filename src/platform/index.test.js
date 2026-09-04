import { describe, it, expect } from 'vitest';
import { resolveImpl, appSupportDir, logDir, daemonServiceName } from './index.js';
import * as darwin from './darwin.js';
import * as linux from './linux.js';

describe('resolveImpl', () => {
    it('resolves darwin', () => {
        expect(resolveImpl('darwin')).toBe(darwin);
    });

    it('resolves linux', () => {
        expect(resolveImpl('linux')).toBe(linux);
    });

    it('throws for an unsupported platform', () => {
        expect(() => resolveImpl('freebsd')).toThrow(/Unsupported platform: freebsd/);
    });

    it('defaults to process.platform', () => {
        expect(resolveImpl()).toBe(resolveImpl(process.platform));
    });
});

describe('top-level re-exports', () => {
    it('match the implementation for the current process.platform', () => {
        const impl = resolveImpl(process.platform);
        expect(appSupportDir()).toBe(impl.appSupportDir());
        expect(logDir()).toBe(impl.logDir());
        expect(daemonServiceName()).toBe(impl.daemonServiceName());
    });
});
