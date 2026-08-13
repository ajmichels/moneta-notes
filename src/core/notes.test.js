import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { titleToPath, pathToTitle, hashContent, countLines, noteRead, noteWrite } from './notes.js';
import { getLogger, runWithLogger } from '../logger.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-'));
    tempDirs.push(dir);
    return dir;
}

function writeRawNote(vaultRoot, title, raw) {
    const filePath = titleToPath(vaultRoot, title);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');
    return filePath;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('titleToPath / pathToTitle', () => {
    it('resolves a flat title to a vault-relative .md path', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, 'Some Note')).toBe(join(vaultRoot, 'Some Note.md'));
    });

    it('resolves a folder-prefixed title (e.g. Weekly Notes/2026-W32)', () => {
        const vaultRoot = makeTempVault();
        expect(titleToPath(vaultRoot, 'Weekly Notes/2026-W32')).toBe(
            join(vaultRoot, 'Weekly Notes', '2026-W32.md'),
        );
    });

    it('round-trips a path back to the original title', () => {
        const vaultRoot = makeTempVault();
        const title = 'Weekly Notes/2026-W32';
        expect(pathToTitle(vaultRoot, titleToPath(vaultRoot, title))).toBe(title);
    });
});

describe('hashContent', () => {
    it('returns a 40-char SHA-1 hex digest', () => {
        expect(hashContent('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('produces different hashes for different content', () => {
        expect(hashContent('a')).not.toBe(hashContent('b'));
    });
});

describe('countLines', () => {
    it('counts 0 lines for empty content', () => {
        expect(countLines('')).toBe(0);
    });

    it('counts lines with no trailing newline', () => {
        expect(countLines('a\nb\nc')).toBe(3);
    });

    it('does not count a trailing newline as an extra line', () => {
        expect(countLines('a\nb\nc\n')).toBe(3);
    });
});

describe('noteRead', () => {
    it('reads a note with no frontmatter as metadata: {}', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Plain Note', 'just some text\nsecond line');

        const result = noteRead(vaultRoot, 'Plain Note');
        expect(result.metadata).toEqual({});
        expect(result.content).toBe('just some text\nsecond line');
        expect(result.total_lines).toBe(2);
        expect(result.start_line).toBe(1);
        expect(result.end_line).toBe(2);
    });

    it('parses YAML frontmatter into a structured metadata object', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(
            vaultRoot,
            'Tagged Note',
            '---\nid: Tagged Note\ntags:\n  - project\n---\nbody text\n',
        );

        const result = noteRead(vaultRoot, 'Tagged Note');
        expect(result.metadata).toEqual({ id: 'Tagged Note', tags: [ 'project' ] });
        expect(result.content).toBe('body text');
    });

    it('returns content_hash over the full raw file, frontmatter included', () => {
        const vaultRoot = makeTempVault();
        const raw = '---\nid: Hashed\n---\nbody\n';
        writeRawNote(vaultRoot, 'Hashed', raw);

        const result = noteRead(vaultRoot, 'Hashed');
        expect(result.content_hash).toBe(hashContent(raw));
    });

    it('windows content by start_line/end_line over the body only', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Multi Line', '---\nid: x\n---\nline1\nline2\nline3\nline4\n');

        const result = noteRead(vaultRoot, 'Multi Line', { startLine: 2, endLine: 3 });
        expect(result.content).toBe('line2\nline3');
        expect(result.start_line).toBe(2);
        expect(result.end_line).toBe(3);
        expect(result.total_lines).toBe(4);
    });

    it('throws on an out-of-range line window', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Short', 'only one line');

        expect(() => noteRead(vaultRoot, 'Short', { startLine: 1, endLine: 5 })).toThrow();
    });

    it('throws a clear error for a missing note', () => {
        const vaultRoot = makeTempVault();
        expect(() => noteRead(vaultRoot, 'Does Not Exist')).toThrow(/not found/i);
    });

    it('throws a hard parse error on malformed frontmatter YAML', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Broken', '---\nfoo: [unterminated\n---\nbody');

        expect(() => noteRead(vaultRoot, 'Broken')).toThrow();
    });
});

describe('noteWrite (create)', () => {
    it('creates a new note with only the computed id when no metadata is given', () => {
        const vaultRoot = makeTempVault();

        const result = noteWrite(vaultRoot, 'New Note', { content: 'hello world' });

        expect(result.title).toBe('New Note');
        expect(result.line_count).toBe(1);

        const onDisk = noteRead(vaultRoot, 'New Note');
        expect(onDisk.metadata).toEqual({ id: 'New Note' });
        expect(onDisk.content).toBe('hello world');
        expect(result.hash).toBe(onDisk.content_hash);
    });

    it('merges caller metadata and overwrites any caller-supplied id with the computed one', () => {
        const vaultRoot = makeTempVault();

        noteWrite(vaultRoot, 'Weekly Notes/2026-W32', {
            metadata: { id: 'bogus-caller-value', tags: [ 'weekly' ] },
            content: 'week body',
        });

        const onDisk = noteRead(vaultRoot, 'Weekly Notes/2026-W32');
        expect(onDisk.metadata).toEqual({ id: '2026-W32', tags: [ 'weekly' ] });
    });

    it('logs a debug line via the context logger when a caller-supplied id is overwritten', async () => {
        const vaultRoot = makeTempVault();
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-log-'));
        const logger = getLogger('mcp-server', logDir);

        runWithLogger(logger, () =>
            noteWrite(vaultRoot, 'Logged Id', { metadata: { id: 'bogus' }, content: 'body' }));

        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
            expect(line).toContain('DEBUG [mcp-server] overwrote caller-supplied id');
            expect(line).toContain('note_title="Logged Id"');
            expect(line).toContain('supplied_id="bogus"');
            expect(line).toContain('computed_id="Logged Id"');
        });
        rmSync(logDir, { recursive: true, force: true });
    });

    it('does not log when no metadata is given (nothing caller-supplied to overwrite)', async () => {
        const vaultRoot = makeTempVault();
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-log-'));
        const logger = getLogger('mcp-server', logDir);

        runWithLogger(logger, () => noteWrite(vaultRoot, 'No Metadata', { content: 'body' }));

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(existsSync(join(logDir, 'mcp-server.log'))).toBe(false);
        rmSync(logDir, { recursive: true, force: true });
    });

    it('creates parent folders for a folder-prefixed title', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'Daily Notes/2026-08-05', { content: 'daily body' });

        expect(noteRead(vaultRoot, 'Daily Notes/2026-08-05').content).toBe('daily body');
    });

    it('errors when hash is null and the title already exists', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Existing', 'already here');

        expect(() => noteWrite(vaultRoot, 'Existing', { content: 'overwrite attempt' })).toThrow(
            /already exists/i,
        );
        expect(noteRead(vaultRoot, 'Existing').content).toBe('already here');
    });
});

describe('noteWrite (update)', () => {
    it('replaces content in full when hash matches, id/other metadata untouched', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Update Me', {
            metadata: { tags: [ 'a' ] },
            content: 'original body',
        });

        const result = noteWrite(vaultRoot, 'Update Me', {
            hash: created.hash,
            content: 'replaced body',
        });

        const onDisk = noteRead(vaultRoot, 'Update Me');
        expect(onDisk.content).toBe('replaced body');
        expect(onDisk.metadata).toEqual({ id: 'Update Me', tags: [ 'a' ] });
        expect(result.hash).toBe(onDisk.content_hash);
        expect(result.line_count).toBe(1);
    });

    it('shallow-merges metadata: overwrites named keys, leaves others untouched', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Merge Me', {
            metadata: { tags: [ 'a' ], status: 'draft' },
            content: 'body',
        });

        noteWrite(vaultRoot, 'Merge Me', {
            hash: created.hash,
            metadata: { status: 'final' },
            content: 'body',
        });

        expect(noteRead(vaultRoot, 'Merge Me').metadata).toEqual({
            id: 'Merge Me',
            tags: [ 'a' ],
            status: 'final',
        });
    });

    it('deletes a metadata key when the patch sets it to null', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Delete Key', {
            metadata: { tags: [ 'a' ], status: 'draft' },
            content: 'body',
        });

        noteWrite(vaultRoot, 'Delete Key', {
            hash: created.hash,
            metadata: { status: null },
            content: 'body',
        });

        expect(noteRead(vaultRoot, 'Delete Key').metadata).toEqual({ id: 'Delete Key', tags: [ 'a' ] });
    });

    it('ignores a caller-supplied id even on update', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Id Guard', { content: 'body' });

        noteWrite(vaultRoot, 'Id Guard', {
            hash: created.hash,
            metadata: { id: 'not-the-real-id' },
            content: 'body',
        });

        expect(noteRead(vaultRoot, 'Id Guard').metadata.id).toBe('Id Guard');
    });

    it('throws a staleness error on hash mismatch and leaves the file untouched', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'Stale', { content: 'original' });

        expect(() => noteWrite(vaultRoot, 'Stale', { hash: 'not-the-real-hash', content: 'new' }))
            .toThrow(/hash mismatch|changed since/i);
        expect(noteRead(vaultRoot, 'Stale').content).toBe('original');
    });

    it('throws when a non-null hash is given but the note does not exist', () => {
        const vaultRoot = makeTempVault();
        expect(() => noteWrite(vaultRoot, 'Ghost', { hash: 'abc123', content: 'x' })).toThrow(
            /does not exist/i,
        );
    });
});

describe('noteWrite size-drop guard', () => {
    it('rejects an update that drops body line count below the threshold', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Shrinking', {
            content: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10',
        });

        expect(() => noteWrite(vaultRoot, 'Shrinking', { hash: created.hash, content: 'line1\nline2' }))
            .toThrow(/size-drop|below/i);
        expect(noteRead(vaultRoot, 'Shrinking').total_lines).toBe(10);
    });

    it('allows the drop when force: true is passed', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Forced Shrink', {
            content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10',
        });

        const result = noteWrite(vaultRoot, 'Forced Shrink', {
            hash: created.hash,
            content: 'l1',
            force: true,
        });

        expect(result.line_count).toBe(1);
    });

    it('does not trip at exactly the threshold boundary', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Boundary', {
            content: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj',
        });

        const result = noteWrite(vaultRoot, 'Boundary', {
            hash: created.hash,
            content: 'a\nb\nc\nd\ne',
        });

        expect(result.line_count).toBe(5);
    });
});
