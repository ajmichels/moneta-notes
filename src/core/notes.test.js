import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
    hashContent, noteRead, noteWrite, noteEdit, noteAppend, noteRename,
} from './notes.js';
import { titleToPath } from './note-fs.js';
import { openDb } from './db.js';
import { getLogger, runWithLogger } from '../logger.js';
import { cleanupTempDir } from '../../vitest.helpers.js';

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

afterEach(async () => {
    while (tempDirs.length > 0) {
        await cleanupTempDir(tempDirs.pop());
    }
});

describe('hashContent', () => {
    it('returns a 40-char SHA-1 hex digest', () => {
        expect(hashContent('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('produces different hashes for different content', () => {
        expect(hashContent('a')).not.toBe(hashContent('b'));
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

    it('returns links_out parsed from the body, with no db passed', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Linker', 'see [[Target One]] and [[Target Two|alias]]');

        const result = noteRead(vaultRoot, 'Linker');
        expect(result.links_out).toEqual([ 'Target One', 'Target Two' ]);
        expect(result.backlinks).toEqual([]);
    });

    it('links_out reflects the full body even when start_line/end_line narrow the window', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Windowed', 'line1 [[Early Target]]\nline2\nline3 [[Late Target]]\n');

        const result = noteRead(vaultRoot, 'Windowed', { startLine: 2, endLine: 2 });
        expect(result.content).toBe('line2');
        expect(result.links_out).toEqual([ 'Early Target', 'Late Target' ]);
    });

    it('returns backlinks from the index when a db is passed', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Target', 'the target note');
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Target.md', 'xyz789', 1, 1000, 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Linker.md', 'abc123', 1, 1000, 1000);
        const linkerId = db.prepare('SELECT id FROM notes WHERE path = ?').get('Linker.md').id;
        db.prepare('INSERT INTO note_links (source_note_id, target_title) VALUES (?, ?)')
            .run(linkerId, 'Target');

        const result = noteRead(vaultRoot, 'Target', { db });
        expect(result.backlinks).toEqual([ 'Linker' ]);
        db.close();
    });

    it('returns an empty backlinks array (not omitted) when nothing links to the note', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Lonely', 'no one links here');
        const { db } = openDb(':memory:');

        const result = noteRead(vaultRoot, 'Lonely', { db });
        expect(result.backlinks).toEqual([]);
        db.close();
    });

    it('returns empty backlinks/links_out for an empty note, with no db passed', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Empty', '');

        const result = noteRead(vaultRoot, 'Empty');
        expect(result.total_lines).toBe(0);
        expect(result.backlinks).toEqual([]);
        expect(result.links_out).toEqual([]);
    });

    it('resolves a short/basename title to the nested note it uniquely matches', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'body text');
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('LoonStateHockey/JMS Hockey/Barbara Garn.md', 'hash', 1, 1000, 1000);

        const result = noteRead(vaultRoot, 'Barbara Garn', { db });

        expect(result.title).toBe('LoonStateHockey/JMS Hockey/Barbara Garn');
        expect(result.content).toBe('body text');
        db.close();
    });

    it('does not resolve a short title without a db (still errors)', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'body text');

        expect(() => noteRead(vaultRoot, 'Barbara Garn')).toThrow(/not found/i);
    });

    it('does not resolve an ambiguous basename shared by two notes', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'A/Notes', 'a notes');
        writeRawNote(vaultRoot, 'B/Notes', 'b notes');
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A/Notes.md', 'hash', 1, 1000, 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('B/Notes.md', 'hash', 1, 1000, 1000);

        expect(() => noteRead(vaultRoot, 'Notes', { db })).toThrow(/not found/i);
        db.close();
    });

    it('prefers an exact title match over resolving as if it were a basename', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Notes', 'root-level notes');
        writeRawNote(vaultRoot, 'A/Notes', 'nested notes');
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('Notes.md', 'hash', 1, 1000, 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A/Notes.md', 'hash', 1, 1000, 1000);

        const result = noteRead(vaultRoot, 'Notes', { db });

        expect(result.title).toBe('Notes');
        expect(result.content).toBe('root-level notes');
        db.close();
    });

    it('resolves links_out to absolute titles when db is provided', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Linker', 'see [[Barbara Garn]]');
        writeRawNote(vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'target body');
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('LoonStateHockey/JMS Hockey/Barbara Garn.md', 'hash', 1, 1000, 1000);

        const result = noteRead(vaultRoot, 'Linker', { db });

        expect(result.links_out).toEqual([ 'LoonStateHockey/JMS Hockey/Barbara Garn' ]);
        db.close();
    });

    it('leaves links_out as raw literal text when it does not resolve, even with db', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Linker', 'see [[Nowhere To Be Found]]');
        const { db } = openDb(':memory:');

        const result = noteRead(vaultRoot, 'Linker', { db });

        expect(result.links_out).toEqual([ 'Nowhere To Be Found' ]);
        db.close();
    });

    it('leaves links_out unresolved (raw literal text) without a db', () => {
        const vaultRoot = makeTempVault();
        writeRawNote(vaultRoot, 'Linker', 'see [[Barbara Garn]]');

        const result = noteRead(vaultRoot, 'Linker');

        expect(result.links_out).toEqual([ 'Barbara Garn' ]);
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

    it('serializes array metadata in expanded block form, never collapsed flow form', () => {
        const vaultRoot = makeTempVault();

        noteWrite(vaultRoot, 'Expanded Arrays', {
            metadata: { tags: [ 'weekly', 'project' ] },
            content: 'body',
        });

        const raw = readFileSync(titleToPath(vaultRoot, 'Expanded Arrays'), 'utf8');
        expect(raw).toContain('tags:\n  - weekly\n  - project\n');
        expect(raw).not.toMatch(/tags:\s*\[/);
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
        await cleanupTempDir(logDir);
    });

    it('does not log when no metadata is given (nothing caller-supplied to overwrite)', async () => {
        const vaultRoot = makeTempVault();
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-log-'));
        const logger = getLogger('mcp-server', logDir);

        runWithLogger(logger, () => noteWrite(vaultRoot, 'No Metadata', { content: 'body' }));

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(existsSync(join(logDir, 'mcp-server.log'))).toBe(false);
        await cleanupTempDir(logDir);
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

    it('honors a caller-supplied sizeDropThreshold (config.toml-backed, S009)', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Custom Threshold', {
            content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10',
        });

        // Default threshold (0.5) allows a drop to 5 lines; a stricter 0.9 threshold rejects it.
        expect(() => noteWrite(vaultRoot, 'Custom Threshold', {
            hash: created.hash, content: 'l1\nl2\nl3\nl4\nl5', sizeDropThreshold: 0.9,
        })).toThrow(/size-drop|below/i);

        // A looser threshold (0.1) allows a drop that the default would have rejected.
        const result = noteWrite(vaultRoot, 'Custom Threshold', {
            hash: created.hash, content: 'l1', sizeDropThreshold: 0.1,
        });
        expect(result.line_count).toBe(1);
    });
});

describe('noteEdit', () => {
    it('replaces old_txt with new_txt when it matches exactly once', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Editable', { content: 'the quick fox' });

        const result = noteEdit(vaultRoot, 'Editable', {
            hash: created.hash,
            oldTxt: 'quick',
            newTxt: 'slow',
        });

        expect(noteRead(vaultRoot, 'Editable').content).toBe('the slow fox');
        expect(result.hash).toBe(noteRead(vaultRoot, 'Editable').content_hash);
    });

    it('merges metadata using the same semantics as note_write', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Edit Meta', {
            metadata: { status: 'draft', tags: [ 'a' ] },
            content: 'body text',
        });

        noteEdit(vaultRoot, 'Edit Meta', {
            hash: created.hash,
            oldTxt: 'body',
            newTxt: 'edited',
            metadata: { status: null },
        });

        expect(noteRead(vaultRoot, 'Edit Meta').metadata).toEqual({ id: 'Edit Meta', tags: [ 'a' ] });
    });

    it('throws when old_txt is not found', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'No Match', { content: 'hello world' });

        expect(() =>
            noteEdit(vaultRoot, 'No Match', { hash: created.hash, oldTxt: 'goodbye', newTxt: 'x' }),
        ).toThrow(/not found/i);
    });

    it('throws when old_txt matches more than once', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Ambiguous', { content: 'foo bar foo' });

        expect(() =>
            noteEdit(vaultRoot, 'Ambiguous', { hash: created.hash, oldTxt: 'foo', newTxt: 'baz' }),
        ).toThrow(/ambiguous|matches \d+ times/i);
    });

    it('throws when hash is missing', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'No Hash', { content: 'body' });

        expect(() => noteEdit(vaultRoot, 'No Hash', { oldTxt: 'body', newTxt: 'x' })).toThrow(
            /hash is required/i,
        );
    });

    it('throws a staleness error on hash mismatch', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'Stale Edit', { content: 'body' });

        expect(() =>
            noteEdit(vaultRoot, 'Stale Edit', { hash: 'wrong', oldTxt: 'body', newTxt: 'x' }),
        ).toThrow(/hash mismatch|changed since/i);
    });

    it('enforces the size-drop guard with no force override available', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Collapse', {
            content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10',
        });

        expect(() =>
            noteEdit(vaultRoot, 'Collapse', {
                hash: created.hash,
                oldTxt: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10',
                newTxt: 'l1',
            }),
        ).toThrow(/size-drop|below/i);
    });

    it('honors a caller-supplied sizeDropThreshold (config.toml-backed, S009)', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Edit Custom Threshold', {
            content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10',
        });

        // Default threshold (0.5) would allow dropping to 5 lines; 0.9 rejects it.
        expect(() =>
            noteEdit(vaultRoot, 'Edit Custom Threshold', {
                hash: created.hash,
                oldTxt: 'l6\nl7\nl8\nl9\nl10',
                newTxt: '',
                sizeDropThreshold: 0.9,
            }),
        ).toThrow(/size-drop|below/i);
    });
});

describe('noteAppend', () => {
    it('appends content to the end of the body, joined by a newline', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Appendable', { content: 'first line' });

        const result = noteAppend(vaultRoot, 'Appendable', created.hash, 'second line');

        expect(noteRead(vaultRoot, 'Appendable').content).toBe('first line\nsecond line');
        expect(result.line_count).toBe(2);
        expect(result.hash).toBe(noteRead(vaultRoot, 'Appendable').content_hash);
    });

    it('appends to an empty body without leaving a leading blank line', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Empty Body', { content: '' });

        noteAppend(vaultRoot, 'Empty Body', created.hash, 'new content');

        expect(noteRead(vaultRoot, 'Empty Body').content).toBe('new content');
    });

    it('throws when hash is missing', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'No Hash Append', { content: 'x' });

        expect(() => noteAppend(vaultRoot, 'No Hash Append', null, 'y')).toThrow(/hash is required/i);
    });

    it('throws a staleness error on hash mismatch', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'Stale Append', { content: 'x' });

        expect(() => noteAppend(vaultRoot, 'Stale Append', 'wrong-hash', 'y')).toThrow(
            /hash mismatch|changed since/i,
        );
    });
});

describe('noteRename', () => {
    it('moves the note and rewrites id to match the new title', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Name', { content: 'body unchanged' });

        const result = noteRename(vaultRoot, 'Old Name', 'New Name', created.hash);

        expect(result.title).toBe('New Name');
        expect(existsSync(titleToPath(vaultRoot, 'Old Name'))).toBe(false);

        const onDisk = noteRead(vaultRoot, 'New Name');
        expect(onDisk.metadata.id).toBe('New Name');
        expect(onDisk.content).toBe('body unchanged');
    });

    it('changes content_hash as a side effect even though the body is untouched', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Hash Change A', { content: 'same body' });

        const result = noteRename(vaultRoot, 'Hash Change A', 'Hash Change B', created.hash);

        expect(result.hash).not.toBe(created.hash);
    });

    it('supports moving into a new subfolder', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Flat Note', { content: 'body' });

        noteRename(vaultRoot, 'Flat Note', 'Weekly Notes/2026-W33', created.hash);

        expect(noteRead(vaultRoot, 'Weekly Notes/2026-W33').metadata.id).toBe('2026-W33');
    });

    it('fails hard when new_title already exists, with no force override', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Source', { content: 'source body' });
        noteWrite(vaultRoot, 'Target', { content: 'target body' });

        expect(() => noteRename(vaultRoot, 'Source', 'Target', created.hash)).toThrow(
            /already exists/i,
        );
        expect(noteRead(vaultRoot, 'Source').content).toBe('source body');
        expect(noteRead(vaultRoot, 'Target').content).toBe('target body');
    });

    it('throws a staleness error on hash mismatch and does not move the file', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'Stale Rename', { content: 'body' });

        expect(() => noteRename(vaultRoot, 'Stale Rename', 'Renamed', 'wrong-hash')).toThrow(
            /hash mismatch|changed since/i,
        );
        expect(existsSync(titleToPath(vaultRoot, 'Stale Rename'))).toBe(true);
        expect(existsSync(titleToPath(vaultRoot, 'Renamed'))).toBe(false);
    });

    it('throws when hash is missing', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'No Hash Rename', { content: 'body' });

        expect(() => noteRename(vaultRoot, 'No Hash Rename', 'Renamed', null)).toThrow(
            /hash is required/i,
        );
    });

    it('throws Note not found when old_title does not exist', () => {
        const vaultRoot = makeTempVault();
        expect(() => noteRename(vaultRoot, 'Ghost', 'Renamed', 'abc123')).toThrow(/not found/i);
    });
});

describe('noteRename: link cascade', () => {
    it('rewrites a plain wikilink in another note', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: 'see [[Old Target]] for more' });

        noteRename(vaultRoot, 'Old Target', 'New Target', target.hash);

        expect(noteRead(vaultRoot, 'Linker').content).toBe('see [[New Target]] for more');
    });

    it('preserves an alias and a heading anchor while rewriting the target', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Old Target#Section|shown text]]' });

        noteRename(vaultRoot, 'Old Target', 'New Target', target.hash);

        expect(noteRead(vaultRoot, 'Linker').content).toBe('[[New Target#Section|shown text]]');
    });

    it('rewrites multiple linking notes in one rename', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker A', { content: '[[Old Target]]' });
        noteWrite(vaultRoot, 'Linker B', { content: '[[Old Target]]' });

        noteRename(vaultRoot, 'Old Target', 'New Target', target.hash);

        expect(noteRead(vaultRoot, 'Linker A').content).toBe('[[New Target]]');
        expect(noteRead(vaultRoot, 'Linker B').content).toBe('[[New Target]]');
    });

    it('does not touch a note linking to a different title that shares a prefix', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Old Extended]]' });

        noteRename(vaultRoot, 'Old', 'New', target.hash);

        expect(noteRead(vaultRoot, 'Linker').content).toBe('[[Old Extended]]');
    });

    it('leaves a link inside a code span untouched', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: 'the syntax is `[[Old Target]]` written like that' });

        noteRename(vaultRoot, 'Old Target', 'New Target', target.hash);

        expect(noteRead(vaultRoot, 'Linker').content).toBe('the syntax is `[[Old Target]]` written like that');
    });

    it('rewrites a self-referential link and reflects it in the returned hash/line_count', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Target', { content: 'see also [[Old Target]] itself' });

        const result = noteRename(vaultRoot, 'Old Target', 'New Target', created.hash);

        const onDisk = noteRead(vaultRoot, 'New Target');
        expect(onDisk.content).toBe('see also [[New Target]] itself');
        expect(result.hash).toBe(onDisk.content_hash);
        expect(result.line_count).toBe(onDisk.total_lines);
    });

    it('works without a db handle (file-level rewrite only)', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Old Target]]' });

        expect(() => noteRename(vaultRoot, 'Old Target', 'New Target', target.hash, null)).not.toThrow();
        expect(noteRead(vaultRoot, 'Linker').content).toBe('[[New Target]]');
    });

    it('enqueues each rewritten candidate for reindex when a db is provided', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Old Target]]' });
        const { db } = openDb(':memory:');

        noteRename(vaultRoot, 'Old Target', 'New Target', target.hash, db);

        const queued = db.prepare('SELECT path FROM index_queue WHERE path = ?').get('Linker.md');
        expect(queued).toBeDefined();
        db.close();
    });

    it('does not enqueue a candidate that had nothing to rewrite', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Old Extended]]' });
        const { db } = openDb(':memory:');

        noteRename(vaultRoot, 'Old', 'New', target.hash, db);

        const queued = db.prepare('SELECT path FROM index_queue WHERE path = ?').get('Linker.md');
        expect(queued).toBeUndefined();
        db.close();
    });

    it('skips an unwritable candidate and logs a warning, without failing the rename', async () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Old Target]]' });
        chmodSync(titleToPath(vaultRoot, 'Linker'), 0o444);

        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-log-'));
        const logger = getLogger('mcp-server', logDir);

        try {
            const result = await runWithLogger(
                logger, () => noteRename(vaultRoot, 'Old Target', 'New Target', target.hash),
            );
            expect(result.title).toBe('New Target');
            await vi.waitFor(() => {
                const line = readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim();
                expect(line).toContain('WARN  [mcp-server] link cascade: failed to update candidate');
                expect(line).toContain('candidate_title="Linker"');
            });
        } finally {
            chmodSync(titleToPath(vaultRoot, 'Linker'), 0o644);
            await cleanupTempDir(logDir);
        }
    });

    it('does not touch a candidate found by an unrelated pre-existing partial match with no real link', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'Old Target', { content: 'target body' });
        noteWrite(vaultRoot, 'Mentioner', { content: 'just talking about [[Old Target Two]] here' });

        noteRename(vaultRoot, 'Old Target', 'New Target', target.hash);

        expect(noteRead(vaultRoot, 'Mentioner').content).toBe('just talking about [[Old Target Two]] here');
    });

    it('rewrites a short/basename-form reference to a nested note when db is provided', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(
            vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', { content: 'target body' },
        );
        noteWrite(vaultRoot, 'Linker', { content: 'see [[Barbara Garn]]' });
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('LoonStateHockey/JMS Hockey/Barbara Garn.md', target.hash, 1, 1000, 1000);

        noteRename(
            vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'LoonStateHockey/JMS Hockey/Barb G',
            target.hash, db,
        );

        expect(noteRead(vaultRoot, 'Linker').content).toBe('see [[LoonStateHockey/JMS Hockey/Barb G]]');
        db.close();
    });

    it('does not rewrite a short/basename-form reference without a db', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(
            vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', { content: 'target body' },
        );
        noteWrite(vaultRoot, 'Linker', { content: 'see [[Barbara Garn]]' });

        noteRename(
            vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'LoonStateHockey/JMS Hockey/Barb G',
            target.hash, null,
        );

        expect(noteRead(vaultRoot, 'Linker').content).toBe('see [[Barbara Garn]]');
    });

    it('does not rewrite a basename-form reference that is ambiguous with another note', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(vaultRoot, 'A/Notes', { content: 'a notes body' });
        noteWrite(vaultRoot, 'B/Notes', { content: 'b notes body' });
        noteWrite(vaultRoot, 'Linker', { content: '[[Notes]]' });
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A/Notes.md', target.hash, 1, 1000, 1000);
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('B/Notes.md', 'other-hash', 1, 1000, 1000);

        noteRename(vaultRoot, 'A/Notes', 'A/New Notes', target.hash, db);

        expect(noteRead(vaultRoot, 'Linker').content).toBe('[[Notes]]');
        db.close();
    });

    it('still rewrites an exact full-title reference to a nested note when db is provided', () => {
        const vaultRoot = makeTempVault();
        const target = noteWrite(
            vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', { content: 'target body' },
        );
        noteWrite(vaultRoot, 'Linker', { content: '[[LoonStateHockey/JMS Hockey/Barbara Garn]]' });
        const { db } = openDb(':memory:');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('LoonStateHockey/JMS Hockey/Barbara Garn.md', target.hash, 1, 1000, 1000);

        noteRename(
            vaultRoot, 'LoonStateHockey/JMS Hockey/Barbara Garn', 'LoonStateHockey/JMS Hockey/Barb G',
            target.hash, db,
        );

        expect(noteRead(vaultRoot, 'Linker').content).toBe('[[LoonStateHockey/JMS Hockey/Barb G]]');
        db.close();
    });
});

describe('noteRename with db write-through', () => {
    function insertIndexedNote(db, path, { title = path.replace(/\.md$/, ''), body = 'indexed body' } = {}) {
        db.prepare(`
            INSERT INTO notes (path, content_hash, line_count, mtime, updated_at)
            VALUES (?, 'stale-hash', 1, 1000, 1000)
        `).run(path);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
        db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(noteId, title, body);
        db.prepare(`
            INSERT INTO chunks
                (note_id, chunk_index, char_start, char_end, line_start, line_end, token_count,
                 embedding_model, embedding_version)
            VALUES (?, 0, 0, 10, 1, 1, 5, 'test-model', 'v1')
        `).run(noteId);
        const chunkId = db.prepare('SELECT id FROM chunks WHERE note_id = ?').get(noteId).id;
        const vector = new Float32Array(1024).fill(0.5);
        db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)')
            .run(chunkId, Buffer.from(vector.buffer));
        return noteId;
    }

    it('updates the existing notes row in place, preserving its id', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Name', { content: 'body unchanged' });
        const { db } = openDb(':memory:');
        const noteId = insertIndexedNote(db, 'Old Name.md');

        const result = noteRename(vaultRoot, 'Old Name', 'New Name', created.hash, db);

        const row = db.prepare('SELECT id, path, content_hash, line_count FROM notes WHERE id = ?').get(noteId);
        expect(row.id).toBe(noteId);
        expect(row.path).toBe('New Name.md');
        expect(row.content_hash).toBe(result.hash);
        expect(db.prepare('SELECT path FROM notes WHERE path = ?').get('Old Name.md')).toBeUndefined();
    });

    // notes_fts is a contentless FTS5 table (content='') — it never returns stored column text on
    // a plain SELECT, only via MATCH against its inverted index (mirrors how search.js queries it).
    it('refreshes the notes_fts title/body under the same rowid', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Name', { content: 'freshbody' });
        const { db } = openDb(':memory:');
        const noteId = insertIndexedNote(db, 'Old Name.md', { title: 'Old Name', body: 'stalebody' });

        noteRename(vaultRoot, 'Old Name', 'New Name', created.hash, db);

        const matchesRowid = (query) => db.prepare(
            'SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?',
        ).all(query).some((row) => row.rowid === noteId);

        expect(matchesRowid('New')).toBe(true);
        expect(matchesRowid('Old')).toBe(false);
        expect(matchesRowid('freshbody')).toBe(true);
        expect(matchesRowid('stalebody')).toBe(false);
    });

    it('leaves chunks/chunk_vectors untouched (no re-embed on rename)', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Name', { content: 'body' });
        const { db } = openDb(':memory:');
        const noteId = insertIndexedNote(db, 'Old Name.md');
        const chunkBefore = db.prepare('SELECT id FROM chunks WHERE note_id = ?').get(noteId);
        const vectorBefore = db.prepare('SELECT embedding FROM chunk_vectors WHERE rowid = ?').get(chunkBefore.id);

        noteRename(vaultRoot, 'Old Name', 'New Name', created.hash, db);

        const chunkAfter = db.prepare('SELECT id FROM chunks WHERE note_id = ?').get(noteId);
        const vectorAfter = db.prepare('SELECT embedding FROM chunk_vectors WHERE rowid = ?').get(chunkAfter.id);
        expect(chunkAfter.id).toBe(chunkBefore.id);
        expect(Buffer.from(vectorAfter.embedding)).toEqual(Buffer.from(vectorBefore.embedding));
    });

    it('records the renamed file\'s actual on-disk mtime, not just "now"', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Name', { content: 'body' });
        const { db } = openDb(':memory:');
        const noteId = insertIndexedNote(db, 'Old Name.md');

        noteRename(vaultRoot, 'Old Name', 'New Name', created.hash, db);

        const row = db.prepare('SELECT mtime FROM notes WHERE id = ?').get(noteId);
        const diskMtime = Math.floor(statSync(titleToPath(vaultRoot, 'New Name')).mtimeMs / 1000);
        expect(row.mtime).toBe(diskMtime);
    });

    it('is a no-op on the index when the note was never indexed', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Never Indexed', { content: 'body' });
        const { db } = openDb(':memory:');

        expect(() => noteRename(vaultRoot, 'Never Indexed', 'Renamed', created.hash, db)).not.toThrow();
        expect(db.prepare('SELECT * FROM notes').all()).toEqual([]);
    });

    it('does not touch the db at all when no db is passed', () => {
        const vaultRoot = makeTempVault();
        const created = noteWrite(vaultRoot, 'Old Name', { content: 'body' });

        expect(() => noteRename(vaultRoot, 'Old Name', 'New Name', created.hash)).not.toThrow();
    });

    it('still throws on hash mismatch before touching the db, leaving the index row untouched', () => {
        const vaultRoot = makeTempVault();
        noteWrite(vaultRoot, 'Stale Rename', { content: 'body' });
        const { db } = openDb(':memory:');
        const noteId = insertIndexedNote(db, 'Stale Rename.md');

        expect(() => noteRename(vaultRoot, 'Stale Rename', 'Renamed', 'wrong-hash', db)).toThrow(
            /hash mismatch|changed since/i,
        );
        expect(db.prepare('SELECT path FROM notes WHERE id = ?').get(noteId).path).toBe('Stale Rename.md');
    });
});
