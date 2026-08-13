import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dispatch, resolveVaultRoot, resolveDbPath, registerCommand } from './main.js';

describe('dispatch: unknown command', () => {
    it('returns exitCode 1 and a descriptive stderr message', async () => {
        const result = await dispatch([ 'bogus' ], {});
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unknown command "bogus"/);
        expect(result.stdout).toBe('');
    });
});

describe('dispatch: centralized error handling', () => {
    it('catches a thrown error from a handler and formats it to stderr with exitCode 1', async () => {
        registerCommand('__test_throw__', async () => {
            throw new Error('boom');
        });

        const result = await dispatch([ '__test_throw__' ], {});

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('mnotes: boom\n');
    });
});

describe('resolveVaultRoot', () => {
    it('throws a descriptive error when MNOTES_VAULT_ROOT is not set', () => {
        expect(() => resolveVaultRoot({})).toThrow(/MNOTES_VAULT_ROOT/);
    });

    it('returns the env value when set', () => {
        expect(resolveVaultRoot({ MNOTES_VAULT_ROOT: '/tmp/vault' })).toBe('/tmp/vault');
    });
});

describe('resolveDbPath', () => {
    it('falls back to the documented Application Support default when unset', () => {
        expect(resolveDbPath({})).toBe(
            join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db'),
        );
    });

    it('returns MNOTES_DB_PATH when set', () => {
        expect(resolveDbPath({ MNOTES_DB_PATH: '/tmp/index.db' })).toBe('/tmp/index.db');
    });
});
