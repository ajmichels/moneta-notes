import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readAttachment, writeAttachment, resolveAttachmentPath } from './attachments.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-attachments-test-'));
    tempDirs.push(dir);
    return dir;
}

function writeAttachmentFile(vaultRoot, relativePath, buffer) {
    const filePath = join(vaultRoot, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buffer);
    return filePath;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('resolveAttachmentPath', () => {
    it('resolves an existing file to its absolute path', () => {
        const vaultRoot = makeTempVault();
        const filePath = writeAttachmentFile(vaultRoot, 'Attachments/receipt.pdf', Buffer.from('pdf-bytes'));

        expect(resolveAttachmentPath(vaultRoot, 'Attachments/receipt.pdf')).toBe(filePath);
    });

    it('throws for a missing path', () => {
        const vaultRoot = makeTempVault();
        expect(() => resolveAttachmentPath(vaultRoot, 'Attachments/missing.pdf')).toThrow(/not found/i);
    });

    it('throws for a path that resolves to a directory', () => {
        const vaultRoot = makeTempVault();
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });

        expect(() => resolveAttachmentPath(vaultRoot, 'Attachments')).toThrow(/not found/i);
    });

    it('rejects a path whose ../ segments escape the vault', () => {
        const vaultRoot = makeTempVault();
        expect(() => resolveAttachmentPath(vaultRoot, '../../../../tmp/pwned')).toThrow(/outside the vault/);
    });
});

describe('readAttachment', () => {
    it('reads an existing file\'s bytes as a Buffer by default', () => {
        const vaultRoot = makeTempVault();
        const content = Buffer.from('hello attachment');
        writeAttachmentFile(vaultRoot, 'Attachments/note.txt', content);

        const result = readAttachment(vaultRoot, 'Attachments/note.txt');
        expect(Buffer.isBuffer(result.content)).toBe(true);
        expect(result.content.equals(content)).toBe(true);
        expect(result.path).toBe('Attachments/note.txt');
        expect(result.size_bytes).toBe(content.length);
    });

    it('derives mime_type from a known extension', () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFile(vaultRoot, 'Attachments/photo.png', Buffer.from([ 1, 2, 3 ]));

        const result = readAttachment(vaultRoot, 'Attachments/photo.png');
        expect(result.mime_type).toBe('image/png');
    });

    it('falls back to application/octet-stream for an unknown extension', () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFile(vaultRoot, 'Attachments/mystery.xyz', Buffer.from([ 1 ]));

        const result = readAttachment(vaultRoot, 'Attachments/mystery.xyz');
        expect(result.mime_type).toBe('application/octet-stream');
    });

    it('omits content entirely when includeContent is false', () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFile(vaultRoot, 'Attachments/note.txt', Buffer.from('hello'));

        const result = readAttachment(vaultRoot, 'Attachments/note.txt', { includeContent: false });
        expect('content' in result).toBe(false);
        expect(result.size_bytes).toBe(5);
        expect(result.mime_type).toBe('text/plain');
    });

    it('throws for a missing path', () => {
        const vaultRoot = makeTempVault();
        expect(() => readAttachment(vaultRoot, 'Attachments/missing.pdf')).toThrow(/not found/i);
    });

    it('throws for a path that resolves to a directory', () => {
        const vaultRoot = makeTempVault();
        mkdirSync(join(vaultRoot, 'Attachments'), { recursive: true });

        expect(() => readAttachment(vaultRoot, 'Attachments')).toThrow(/not found/i);
    });

    it('throws naming the size and cap when includeContent is true and the file exceeds maxReadBytes', () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFile(vaultRoot, 'Attachments/big.bin', Buffer.alloc(100));

        expect(() => readAttachment(vaultRoot, 'Attachments/big.bin', { maxReadBytes: 10 }))
            .toThrow(/100 bytes.*10/);
    });

    it('does not throw over the cap when includeContent is false', () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFile(vaultRoot, 'Attachments/big.bin', Buffer.alloc(100));

        const result = readAttachment(vaultRoot, 'Attachments/big.bin', {
            includeContent: false, maxReadBytes: 10,
        });
        expect(result.size_bytes).toBe(100);
    });

    it('rejects a path whose ../ segments escape the vault', () => {
        const vaultRoot = makeTempVault();
        expect(() => readAttachment(vaultRoot, '../../../../tmp/pwned')).toThrow(/outside the vault/);
    });
});

describe('writeAttachment', () => {
    it('creates a new file, including parent directories that do not exist yet', () => {
        const vaultRoot = makeTempVault();
        const content = Buffer.from('new attachment bytes');

        const result = writeAttachment(vaultRoot, 'Projects/mnotes/logo.png', content);

        expect(result).toEqual({ path: 'Projects/mnotes/logo.png', size_bytes: content.length, mime_type: 'image/png' });
        expect(existsSync(join(vaultRoot, 'Projects/mnotes/logo.png'))).toBe(true);
    });

    it('overwrites an existing file unconditionally', () => {
        const vaultRoot = makeTempVault();
        writeAttachmentFile(vaultRoot, 'Attachments/receipt.pdf', Buffer.from('old'));

        const newContent = Buffer.from('brand new content');
        const result = writeAttachment(vaultRoot, 'Attachments/receipt.pdf', newContent);

        expect(result.size_bytes).toBe(newContent.length);
        const readBack = readAttachment(vaultRoot, 'Attachments/receipt.pdf');
        expect(readBack.content.equals(newContent)).toBe(true);
    });

    it('leaves no stray tmp file behind after a successful write', () => {
        const vaultRoot = makeTempVault();
        writeAttachment(vaultRoot, 'Attachments/receipt.pdf', Buffer.from('content'));

        const entries = readdirSync(join(vaultRoot, 'Attachments'));
        expect(entries).toEqual([ 'receipt.pdf' ]);
    });

    it('rejects a path whose ../ segments escape the vault', () => {
        const vaultRoot = makeTempVault();
        expect(() => writeAttachment(vaultRoot, '../../../../tmp/pwned', Buffer.from('x')))
            .toThrow(/outside the vault/);
    });
});
