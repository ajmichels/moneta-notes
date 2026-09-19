import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDotPath, buildSymlinkRegistry, rewriteEventPath } from './vault-walk.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-vault-walk-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('isDotPath', () => {
    it('flags a dotfile at the vault root', () => {
        expect(isDotPath('.DS_Store')).toBe(true);
    });

    it('flags a path nested under a dot-directory', () => {
        expect(isDotPath('.obsidian/workspace.json')).toBe(true);
    });

    it('flags a deeply nested dot-directory regardless of position', () => {
        expect(isDotPath('Weekly Notes/.trash/2026-W32.md')).toBe(true);
    });

    it('does not flag an ordinary vault-relative path', () => {
        expect(isDotPath('Weekly Notes/2026-W32.md')).toBe(false);
    });
});

describe('buildSymlinkRegistry', () => {
    it('maps each symlinked directory\'s alias path to its resolved realpath', () => {
        const vaultRoot = makeTempVault();
        const externalDir = makeTempVault();
        symlinkSync(externalDir, join(vaultRoot, 'Memory'));

        const registry = buildSymlinkRegistry(vaultRoot);

        expect(registry.size).toBe(1);
        expect(registry.get('Memory')).toBe(realpathSync(externalDir));
    });

    it('returns an empty registry for a vault with no symlinks', () => {
        const vaultRoot = makeTempVault();

        expect(buildSymlinkRegistry(vaultRoot).size).toBe(0);
    });

    it('includes nested symlinked directories at any depth', () => {
        const vaultRoot = makeTempVault();
        const outerExternal = makeTempVault();
        const innerExternal = makeTempVault();
        symlinkSync(innerExternal, join(outerExternal, 'Inner'));
        symlinkSync(outerExternal, join(vaultRoot, 'Outer'));

        const registry = buildSymlinkRegistry(vaultRoot);

        expect(registry.get('Outer')).toBe(realpathSync(outerExternal));
        expect(registry.get('Outer/Inner')).toBe(realpathSync(innerExternal));
    });
});

describe('rewriteEventPath', () => {
    it('rewrites an absolute path under a registered realpath to its vault-relative alias', () => {
        const registry = new Map([ [ 'Memory', '/external/target' ] ]);

        expect(rewriteEventPath('/external/target/sub/Note.md', registry)).toBe('Memory/sub/Note.md');
    });

    it('rewrites the watched realpath itself (no suffix) to the bare alias', () => {
        const registry = new Map([ [ 'Memory', '/external/target' ] ]);

        expect(rewriteEventPath('/external/target', registry)).toBe('Memory');
    });

    it('picks the longest-matching realpath when one is nested inside another', () => {
        const registry = new Map([
            [ 'Outer', '/external/outer' ],
            [ 'Outer/Inner', '/external/outer/inner-target' ],
        ]);

        expect(rewriteEventPath('/external/outer/inner-target/Deep.md', registry)).toBe('Outer/Inner/Deep.md');
        expect(rewriteEventPath('/external/outer/Other.md', registry)).toBe('Outer/Other.md');
    });

    it('returns null when nothing in the registry matches', () => {
        const registry = new Map([ [ 'Memory', '/external/target' ] ]);

        expect(rewriteEventPath('/somewhere/else/Note.md', registry)).toBeNull();
    });
});
