import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { getLogger, runWithLogger } from '../logger.js';
import { enqueuePath, dequeueNextPath, processPath } from './daemon.js';

const tempDirs = [];

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function writeNote(vaultRoot, relativePath, content, mtimeSec) {
    const filePath = join(vaultRoot, relativePath);
    writeFileSync(filePath, content, 'utf8');
    if (mtimeSec !== undefined) {
        utimesSync(filePath, mtimeSec, mtimeSec);
    }
    return filePath;
}

function fakeChunkText(body) {
    return body.length === 0 ? [] : [ { chunkIndex: 0, charStart: 0, charEnd: body.length, tokenCount: 1 } ];
}

async function fakeEmbed() {
    return new Float32Array(1024).fill(0.1);
}

function baseDeps() {
    return {
        chunkText: fakeChunkText,
        embed: fakeEmbed,
        embeddingModel: 'test-model',
        embeddingVersion: 'v1',
    };
}

describe('enqueuePath / dequeueNextPath', () => {
    it('dedupes a re-enqueued path, preserving its original enqueued_at', () => {
        const db = makeTestDb();

        enqueuePath(db, 'A.md', 1000);
        enqueuePath(db, 'A.md', 2000);

        const row = db.prepare('SELECT * FROM index_queue WHERE path = ?').get('A.md');
        expect(row.enqueued_at).toBe(1000);
    });

    it('dequeues the earliest-eligible path by next_attempt_at then enqueued_at', () => {
        const db = makeTestDb();
        enqueuePath(db, 'Second.md', 2000);
        enqueuePath(db, 'First.md', 1000);

        expect(dequeueNextPath(db, 3000)).toBe('First.md');
    });

    it('skips a path whose next_attempt_at is still in the future', () => {
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO index_queue (path, enqueued_at, next_attempt_at) VALUES (?, ?, ?)',
        ).run('Future.md', 1000, 999999);
        enqueuePath(db, 'Ready.md', 1000);

        expect(dequeueNextPath(db, 2000)).toBe('Ready.md');
    });

    it('returns null when nothing is eligible', () => {
        const db = makeTestDb();
        expect(dequeueNextPath(db, 1000)).toBeNull();
    });
});

describe('processPath: skip-unchanged', () => {
    it('returns unchanged without reading the file when mtime matches the stored value', async () => {
        const vaultRoot = makeTempVault();
        writeNote(vaultRoot, 'A.md', 'body text', 1000);
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'irrelevant-hash', 1, 1000, 1000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
    });
});

describe('processPath: content changed', () => {
    it('updates mtime only when the hash is unchanged despite a newer mtime (e.g. touch)', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'A.md', 'stable body', 1000);
        const raw = 'stable body';
        const { hashContent } = await import('../core/notes.js');
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', hashContent(raw), 1, 500, 500);
        utimesSync(join(vaultRoot, 'A.md'), 2000, 2000);

        const result = await processPath(vaultRoot, db, 'A.md', baseDeps());

        expect(result).toEqual({ status: 'unchanged' });
        const row = db.prepare('SELECT mtime FROM notes WHERE path = ?').get('A.md');
        expect(row.mtime).toBe(2000);
    });

    it('reindexes a brand-new note: notes row, chunks, chunk_vectors, notes_fts, tags', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'New Note.md', '---\ntags:\n  - project\n---\nhello world', 1000);

        const result = await processPath(vaultRoot, db, 'New Note.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });

        const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('New Note.md');
        expect(note.mtime).toBe(1000);

        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const vectorRow = db.prepare('SELECT rowid FROM chunk_vectors WHERE rowid = ?').get(chunkRows[0].id);
        expect(vectorRow).toBeDefined();

        const ftsHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello'").get();
        expect(ftsHit.rowid).toBe(note.id);

        const tagRow = db.prepare(`
            SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ?
        `).get(note.id);
        expect(tagRow.name).toBe('project');
    });

    it('replaces stale chunks/fts/tags rather than appending on a content change', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        writeNote(vaultRoot, 'Changing.md', 'original body', 1000);
        await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        writeNote(vaultRoot, 'Changing.md', 'replaced body entirely', 2000);
        const result = await processPath(vaultRoot, db, 'Changing.md', baseDeps());

        expect(result).toEqual({ status: 'reindexed' });
        const note = db.prepare('SELECT id FROM notes WHERE path = ?').get('Changing.md');
        const chunkRows = db.prepare('SELECT * FROM chunks WHERE note_id = ?').all(note.id);
        expect(chunkRows).toHaveLength(1);

        const staleHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'original'").get();
        expect(staleHit).toBeUndefined();
        const freshHit = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'replaced'").get();
        expect(freshHit.rowid).toBe(note.id);
    });

    it('logs an info line via the context logger with the note title and chunk count', async () => {
        const vaultRoot = makeTempVault();
        const db = makeTestDb();
        const logDir = mkdtempSync(join(tmpdir(), 'mnotes-daemon-test-log-'));
        const logger = getLogger('indexer', logDir);
        writeNote(vaultRoot, 'Logged.md', 'body text here', 1000);

        const result = await runWithLogger(logger, () => processPath(vaultRoot, db, 'Logged.md', baseDeps()));

        expect(result).toEqual({ status: 'reindexed' });
        await vi.waitFor(() => {
            const line = readFileSync(join(logDir, 'indexer.log'), 'utf8').trim();
            expect(line).toContain('INFO  [indexer] reindexed note');
            expect(line).toContain('note_title="Logged"');
            expect(line).toContain('chunk_count=1');
        });
        rmSync(logDir, { recursive: true, force: true });
    });
});
