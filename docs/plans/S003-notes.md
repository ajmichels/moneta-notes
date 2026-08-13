# S003 Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/core/notes.js` — note read/write/edit/append/rename against vault files on
disk, content hashing, structured frontmatter/metadata handling, the system-managed `id` field, and
the hash-required-on-mutation and size-drop safety guards — per `docs/specs/S003-notes.md`.

**Architecture:** `core/notes.js` is a pure filesystem module. It takes a `vaultRoot` (absolute
directory path) plus plain arguments, resolves note titles to `.md` file paths under that root, reads
and writes files directly, and returns plain data. **It does not import or open `core/db.js` and never
touches the SQLite index** — S003 says this explicitly for `note_rename` ("core/notes.js does not
touch the SQLite index directly... this shows up to the indexing daemon as an ordinary file delete +
create pair"), and the same holds for every other mutation here: the `notes` table is a downstream
cache reconciled asynchronously by the indexing daemon (S005) reacting to `fswatch` events, never
written synchronously by this file. Concretely this means:

- The hash-staleness check ("does the caller's `hash` match the note's *current* `content_hash`?")
  compares against a hash computed fresh from the file's current bytes on disk, not a DB column.
  This matches S003's "Concurrency model" section, which describes the guard as a plain
  read-current-hash → compare → write sequence with no DB or lock involved.
  test fixtures for this file are a real temp directory (`mkdtempSync`/`tmpdir`) standing in for the
  vault root — no SQLite fixture is needed here, unlike S001/S002/S004.

Every exported function takes `vaultRoot` as its first argument (injected by `cli/`/`mcp/` later from
`config.toml`'s vault path once S009 lands — not read from config here, since `core/` doesn't know
about config loading either). Multi-field mutating calls (`note_write`, `note_edit`) take their
optional/multi-value fields as a single options object to keep parameter counts under the project's
`max-params` lint budget and to mirror each MCP tool's input schema closely, so `cli/`/`mcp/` wrapping
is close to mechanical:

```js
titleToPath(vaultRoot, title)                                    -> string (absolute path)
pathToTitle(vaultRoot, filePath)                                  -> string (title)
hashContent(content)                                              -> string (40-char SHA-1 hex)
countLines(content)                                               -> number
noteRead(vaultRoot, title, { startLine, endLine } = {})
    -> { title, start_line, end_line, total_lines, content_hash, metadata, content }
noteWrite(vaultRoot, title, { hash = null, metadata = null, content, force = false } = {})
    -> { title, hash, line_count }
noteEdit(vaultRoot, title, { hash, oldTxt, newTxt, metadata = null } = {})
    -> { title, hash, line_count }
noteAppend(vaultRoot, title, hash, content)
    -> { title, hash, line_count }
noteRename(vaultRoot, oldTitle, newTitle, hash)
    -> { title, hash, line_count }
```

Object keys returned from these functions (`content_hash`, `start_line`, `line_count`, etc.) use
`snake_case` deliberately — they are the literal wire-format field names S003/S007 specify at the tool
boundary, not intermediate JS variables. Internal local variables stay `camelCase` per CLAUDE.md.

**Design decisions made here that the spec leaves implicit** (flagged for AJ's confirmation before/
during implementation, not blocking this plan):

1. **`content_hash` is always the SHA-1 of the full raw file bytes, frontmatter included** — this is
   explicit in S001 ("SHA-1 hex digest... of the raw file bytes, frontmatter included") and is what a
   caller's `hash` argument is checked against.
2. **`line_count` / `total_lines` refer to the note *body* only (post-frontmatter), not the raw file.**
   S003 doesn't say this explicitly, but `note_read` returns `metadata` (parsed frontmatter) and
   `content`/`total_lines` as separate fields, which only makes sense as a pairing if `content` and its
   line count exclude the frontmatter block that `metadata` already represents. This is also the
   natural quantity for the size-drop guard, which is about *content* loss, not frontmatter-line
   churn. **content_hash and line_count are therefore independent measurements over different spans of
   the file** (whole-file vs. body-only) — this is intentional, not an inconsistency.
3. **`note_edit` has no `force` override for the size-drop guard.** S003's prose ("Size-drop guard
   applies here too") doesn't explicitly say whether `force` is available on `note_edit`, but S007's
   finalized tool schema lists `note_edit`'s inputs as `note_title, hash, old_txt, new_txt, ?metadata,
   reason` — no `force`. S007 explicitly supersedes the README and is the more recent, more specific
   source, so this plan treats `note_edit`'s size-drop guard as **always enforced, never bypassable**
   (a caller who genuinely wants to shrink a note drastically uses `note_write` instead, which does
   have `force`).
4. **`note_write`/`note_edit`/`note_append`/`note_rename` also reject a non-null `hash` against a
   *nonexistent* note** (distinct error from the documented "no hash + existing title" case). S003
   doesn't spell this out, but it's the natural extension of "fail loudly" — a hash can't meaningfully
   match something that isn't there.

**Tech Stack:** Node built-ins (`node:fs`, `node:path`, `node:crypto`), `gray-matter` (npm, YAML
frontmatter parse/stringify — named as the example library in S003), Vitest with a real temp directory
standing in for the vault root (no mocking, per CLAUDE.md).

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `core/` takes plain arguments, returns plain data, throws on error — no CLI/MCP concerns
  (CLAUDE.md, S003).
- **Note title is the identifier everywhere outside this file.** Path resolution from title happens
  only inside `core/notes.js` (`titleToPath`/`pathToTitle`); no other function anywhere accepts a raw
  path.
- **Every mutating operation on an existing note requires a matching content hash.** No hash + existing
  title is an error, never a silent overwrite (CLAUDE.md, S003). `note_edit`/`note_append`/
  `note_rename` all require a non-null hash unconditionally (no create path exists for them).
- **Metadata is a structured object at every boundary** — frontmatter is parsed via `gray-matter` into
  a plain object and serialized back the same way; no hand-rolled YAML string splicing anywhere in this
  file (CLAUDE.md).
- **Fail loudly.** Every error is a plain `throw new Error('descriptive message')` — no custom `Error`
  subclasses, no error-code taxonomy, matching `db.js`'s existing style (`setMeta`'s validation) and
  S007's error-mapping rule that `mcp/tools.js` forwards the thrown message verbatim.
- **`core/notes.js` never imports `core/db.js` and never queries the SQLite index.** See Architecture
  above — this is a direct reading of S003's explicit statement for `note_rename`, generalized to every
  function in this file.
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md).
- Test file colocated: `src/core/notes.js` → `src/core/notes.test.js` (CLAUDE.md).
- Tests use a real temp directory (`mkdtempSync(join(tmpdir(), 'mnotes-notes-test-'))`) as the fake
  vault root, cleaned up in `afterEach` — never a mocked filesystem (CLAUDE.md).
- 4-space indentation, single quotes, trailing commas on multiline, `func-style: declaration` (matches
  `eslint.config.js`, matches S001's plan).
- `max-params` is a lint warning at 5 — multi-field mutating functions take a single options object
  (see Architecture) to stay well under that.
- Exact tool semantics (hash rules, metadata merge rules, size-drop guard, `id` computation) per
  `docs/specs/S003-notes.md`, cross-referenced against `docs/specs/S007-mcp-server.md` where S003's
  prose is ambiguous (see "Design decisions" above).
- **Logging** (S008, S003 "Logging"): mutation outcomes are fully covered by `logAudit` at the
  boundary layer (`S006`/`S007`) — this file does not duplicate that via `getContextLogger()`, it just
  throws descriptive errors as above. The one exception, introduced in Task 3's `withComputedId`
  helper and reused by every task through Task 8: a `debug` line when a caller-supplied `id` in
  *that call's own* `metadata` argument gets silently overwritten with the computed value — something
  `audit.log` wouldn't otherwise capture. `import { getContextLogger } from '../logger.js';` at the
  top of `notes.js`.

---

### Task 1: Title↔path resolution, content hashing, line counting

**Files:**
- Create: `src/core/notes.js`
- Create: `src/core/notes.test.js`

**Interfaces:**
- Produces: `titleToPath(vaultRoot, title) -> string`, `pathToTitle(vaultRoot, filePath) -> string`,
  `hashContent(content) -> string`, `countLines(content) -> number`. Every later task in this plan
  builds directly on these four pure helpers.

- [ ] **Step 1: Write the failing test**

Create `src/core/notes.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { titleToPath, pathToTitle, hashContent, countLines } from './notes.js';

const tempDirs = [];

function makeTempVault() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-notes-test-'));
    tempDirs.push(dir);
    return dir;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — `src/core/notes.js` doesn't exist yet (`Cannot find module './notes.js'` or similar).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/notes.js`:

```js
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

export function titleToPath(vaultRoot, title) {
    return join(vaultRoot, `${title}.md`);
}

export function pathToTitle(vaultRoot, filePath) {
    return relative(vaultRoot, filePath).replace(/\.md$/, '');
}

export function hashContent(content) {
    return createHash('sha1').update(content, 'utf8').digest('hex');
}

export function countLines(content) {
    if (content === '') {
        return 0;
    }
    const lines = content.split('\n');
    return content.endsWith('\n') ? lines.length - 1 : lines.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add title/path resolution and content hashing helpers"
```

---

### Task 2: `noteRead` — frontmatter parsing, line-range windowing

**Files:**
- Modify: `package.json` (add `gray-matter` dependency)
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Consumes: `titleToPath`, `hashContent`, `countLines` from Task 1.
- Produces: `noteRead(vaultRoot, title, { startLine, endLine } = {}) -> { title, start_line, end_line,
  total_lines, content_hash, metadata, content }`.

- [ ] **Step 1: Add the `gray-matter` dependency**

Run: `pnpm add gray-matter@^4.0.3`

- [ ] **Step 2: Write the failing test**

Add near the top of `src/core/notes.test.js` (new imports and a helper):

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { noteRead } from './notes.js';

function writeRawNote(vaultRoot, title, raw) {
    const filePath = titleToPath(vaultRoot, title);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');
    return filePath;
}
```

Add a new `describe` block:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — `noteRead is not a function` / `noteRead` not exported.

- [ ] **Step 4: Write minimal implementation**

Update `src/core/notes.js`:

```js
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

export function titleToPath(vaultRoot, title) {
    return join(vaultRoot, `${title}.md`);
}

export function pathToTitle(vaultRoot, filePath) {
    return relative(vaultRoot, filePath).replace(/\.md$/, '');
}

export function hashContent(content) {
    return createHash('sha1').update(content, 'utf8').digest('hex');
}

export function countLines(content) {
    if (content === '') {
        return 0;
    }
    const lines = content.split('\n');
    return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

export function noteRead(vaultRoot, title, { startLine, endLine } = {}) {
    const filePath = titleToPath(vaultRoot, title);

    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Note not found: "${title}"`);
        }
        throw err;
    }

    const { data: metadata, content: body } = matter(raw);
    const totalLines = countLines(body);
    const contentHash = hashContent(raw);

    if (totalLines === 0) {
        return {
            title,
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            content_hash: contentHash,
            metadata,
            content: '',
        };
    }

    const start = startLine ?? 1;
    const end = endLine ?? totalLines;

    if (start < 1 || end < start || end > totalLines) {
        throw new Error(
            `Invalid line range ${start}-${end} for "${title}" (note has ${totalLines} lines)`,
        );
    }

    const content = body.split('\n').slice(start - 1, end).join('\n');

    return {
        title,
        start_line: start,
        end_line: end,
        total_lines: totalLines,
        content_hash: contentHash,
        metadata,
        content,
    };
}
```

Note: `dirname` is imported now even though unused until Task 3 — remove it from this import if your
linter flags unused imports before Task 3 lands; either is fine since Task 3 immediately needs it too.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add note_read with frontmatter parsing and line-range windowing"
```

---

### Task 3: `noteWrite` — create path, `id` injection, no-hash-on-existing error

**Files:**
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Consumes: `titleToPath`, `hashContent`, `countLines` from Task 1.
- Produces: `noteWrite(vaultRoot, title, { hash = null, metadata = null, content } = {}) -> { title,
  hash, line_count }` — **create path only** (`hash === null`). The update path (`hash` provided)
  throws a placeholder "not yet implemented" error in this task and is built out in Task 4 — mirrors
  S001's Task 9→10 pattern of landing one branch of a function per task with an explicit note about
  what's deferred. Also produces `withComputedId(baseMetadata, callerMetadata, title)` (S003
  "Logging"), reused unchanged by every later task in this plan.

- [ ] **Step 1: Write the failing test**

Add to `src/core/notes.test.js`:

```js
import { noteWrite } from './notes.js';

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
```

Extend `src/core/notes.test.js`'s top-level imports for the two new tests above: `vi` from `'vitest'`
(alongside `describe, it, expect, afterEach`), `readFileSync, existsSync` from `'node:fs'` (alongside
the already-imported `mkdtempSync, rmSync`), and `getLogger, runWithLogger` from `'../logger.js'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — `noteWrite is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/notes.js` — add imports, `computeId`, `createNote`, and `noteWrite`:

```js
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import matter from 'gray-matter';
import { getContextLogger } from '../logger.js';

// ... titleToPath, pathToTitle, hashContent, countLines, noteRead unchanged from Task 2 ...

function computeId(title) {
    const segments = title.split('/');
    return segments[segments.length - 1];
}

// `callerMetadata` is the metadata object passed to *this* call (null when the tool has no
// metadata param, e.g. append/rename) — distinct from `baseMetadata`, which may already be a
// merge of existing + caller metadata (S003 "Logging": only a caller-supplied `id` in this call's
// own input is worth flagging, not the routine case of an existing id carrying forward unchanged).
function withComputedId(baseMetadata, callerMetadata, title) {
    const computedId = computeId(title);
    if (callerMetadata && Object.prototype.hasOwnProperty.call(callerMetadata, 'id')) {
        getContextLogger().debug('overwrote caller-supplied id', {
            note_title: title,
            supplied_id: callerMetadata.id,
            computed_id: computedId,
        });
    }
    return { ...(baseMetadata ?? {}), id: computedId };
}

function createNote(filePath, title, metadata, content) {
    const data = withComputedId(metadata, metadata, title);
    const raw = matter.stringify(content, data);

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(content) };
}

export function noteWrite(vaultRoot, title, { hash = null, metadata = null, content } = {}) {
    const filePath = titleToPath(vaultRoot, title);

    if (hash !== null) {
        throw new Error('note_write: updating an existing note is not yet implemented');
    }

    if (existsSync(filePath)) {
        throw new Error(
            `note_write: "${title}" already exists — a null hash only creates a new note. `
            + 'Read the note first to get its current hash.',
        );
    }

    return createNote(filePath, title, metadata, content);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add note_write create path with id injection"
```

---

### Task 4: `noteWrite` — update path, hash staleness check, metadata shallow merge

**Files:**
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Consumes: `createNote`/`computeId` from Task 3.
- Produces: `noteWrite`'s full behavior for `hash !== null` — full content replace, shallow metadata
  merge (`null` deletes a key), hash-mismatch staleness error, hash-provided-but-missing-note error.
  Also introduces `readRawNote` (shared ENOENT→"Note not found" helper) and refactors `noteRead` to use
  it instead of its own inline `try`/`catch`, avoiding duplicated error-shaping logic within this file.

- [ ] **Step 1: Write the failing test**

Add to `src/core/notes.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — the update branch still throws `'not yet implemented'` for every case above.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/notes.js` — add `readRawNote`, `mergeMetadata`, `updateNote`, refactor `noteRead`, and
replace `noteWrite`'s stub branch:

```js
function readRawNote(filePath, title) {
    try {
        return readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Note not found: "${title}"`);
        }
        throw err;
    }
}
```

Update `noteRead` to use it (replaces its inline `try`/`catch` from Task 2):

```js
export function noteRead(vaultRoot, title, { startLine, endLine } = {}) {
    const filePath = titleToPath(vaultRoot, title);
    const raw = readRawNote(filePath, title);

    const { data: metadata, content: body } = matter(raw);
    // ... unchanged from Task 2 from here down ...
}
```

Add the merge helper, the update branch, and wire `noteWrite` to it:

```js
function mergeMetadata(existing, patch) {
    if (!patch) {
        return { ...existing };
    }
    const merged = { ...existing };
    for (const [ key, value ] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function updateNote(filePath, title, hash, metadata, content) {
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_write: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before writing.`,
        );
    }

    const { data: existingMetadata } = matter(currentRaw);
    const data = withComputedId(mergeMetadata(existingMetadata, metadata), metadata, title);
    const raw = matter.stringify(content, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(content) };
}

export function noteWrite(vaultRoot, title, { hash = null, metadata = null, content } = {}) {
    const filePath = titleToPath(vaultRoot, title);
    const fileExists = existsSync(filePath);

    if (hash === null) {
        if (fileExists) {
            throw new Error(
                `note_write: "${title}" already exists — a null hash only creates a new note. `
                + 'Read the note first to get its current hash.',
            );
        }
        return createNote(filePath, title, metadata, content);
    }

    if (!fileExists) {
        throw new Error(
            `note_write: "${title}" does not exist — cannot match hash "${hash}" against a `
            + 'nonexistent note.',
        );
    }

    return updateNote(filePath, title, hash, metadata, content);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS (full suite so far)

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add note_write update path with hash check and metadata merge"
```

---

### Task 5: Size-drop guard on `noteWrite`, `force` bypass

**Files:**
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Produces: `SIZE_DROP_THRESHOLD` (exported constant, `0.5` — flagged as a stand-in for a future
  `config.toml` value per S009, same pattern S001 used for `busy_timeout`/journal mode). `noteWrite`
  gains a `force` option; the update path rejects a body whose new line count is below
  `SIZE_DROP_THRESHOLD` of the current line count unless `force: true` is passed. The guard is
  structurally unreachable on the create path (nothing to compare against), so no test is needed there
  beyond what Task 3 already covers.

- [ ] **Step 1: Write the failing test**

Add to `src/core/notes.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — the first test doesn't throw yet (no guard); the second/third tests pass already but
run them anyway to confirm nothing regresses once the guard is added.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/notes.js` — add the threshold constant and wire the guard into `updateNote`/
`noteWrite`:

```js
export const SIZE_DROP_THRESHOLD = 0.5; // fraction of current line count; config.toml-backed under S009

function updateNote(filePath, title, hash, metadata, content, force) {
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_write: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before writing.`,
        );
    }

    const { data: existingMetadata, content: existingBody } = matter(currentRaw);
    const currentLineCount = countLines(existingBody);
    const newLineCount = countLines(content);

    if (!force && newLineCount < currentLineCount * SIZE_DROP_THRESHOLD) {
        throw new Error(
            `note_write: size-drop guard tripped for "${title}" — new content is ${newLineCount} `
            + `lines, down from ${currentLineCount} (below ${SIZE_DROP_THRESHOLD * 100}% threshold). `
            + 'Pass force: true to override.',
        );
    }

    const data = withComputedId(mergeMetadata(existingMetadata, metadata), metadata, title);
    const raw = matter.stringify(content, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: newLineCount };
}

export function noteWrite(vaultRoot, title, { hash = null, metadata = null, content, force = false } = {}) {
    const filePath = titleToPath(vaultRoot, title);
    const fileExists = existsSync(filePath);

    if (hash === null) {
        if (fileExists) {
            throw new Error(
                `note_write: "${title}" already exists — a null hash only creates a new note. `
                + 'Read the note first to get its current hash.',
            );
        }
        return createNote(filePath, title, metadata, content);
    }

    if (!fileExists) {
        throw new Error(
            `note_write: "${title}" does not exist — cannot match hash "${hash}" against a `
            + 'nonexistent note.',
        );
    }

    return updateNote(filePath, title, hash, metadata, content, force);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add size-drop guard and force bypass to note_write"
```

---

### Task 6: `noteEdit` — surgical replace, ambiguous-match errors, metadata merge, guard (no force)

**Files:**
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Consumes: `readRawNote`, `mergeMetadata`, `computeId`, `SIZE_DROP_THRESHOLD` from Tasks 4–5.
- Produces: `noteEdit(vaultRoot, title, { hash, oldTxt, newTxt, metadata = null } = {}) -> { title,
  hash, line_count }`. Hash is required and non-nullable (no create path exists for this tool, per
  S003). Zero or multiple matches of `old_txt` are both errors. Size-drop guard applies with **no**
  `force` option, per S007's finalized `note_edit` schema (see Architecture's "Design decisions" #3).

- [ ] **Step 1: Write the failing test**

Add to `src/core/notes.test.js`:

```js
import { noteEdit } from './notes.js';

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — `noteEdit is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/notes.js` — add `countOccurrences` and `noteEdit`:

```js
function countOccurrences(haystack, needle) {
    if (needle === '') {
        return 0;
    }
    return haystack.split(needle).length - 1;
}

export function noteEdit(vaultRoot, title, { hash, oldTxt, newTxt, metadata = null } = {}) {
    if (!hash) {
        throw new Error(`note_edit: hash is required for "${title}"`);
    }

    const filePath = titleToPath(vaultRoot, title);
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_edit: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before editing.`,
        );
    }

    const { data: existingMetadata, content: existingBody } = matter(currentRaw);
    const occurrences = countOccurrences(existingBody, oldTxt);

    if (occurrences === 0) {
        throw new Error(`note_edit: old_txt not found in "${title}"`);
    }
    if (occurrences > 1) {
        throw new Error(
            `note_edit: old_txt matches ${occurrences} times in "${title}" — ambiguous edit, `
            + 'provide more surrounding context',
        );
    }

    const newBody = existingBody.replace(oldTxt, newTxt);
    const currentLineCount = countLines(existingBody);
    const newLineCount = countLines(newBody);

    if (newLineCount < currentLineCount * SIZE_DROP_THRESHOLD) {
        throw new Error(
            `note_edit: size-drop guard tripped for "${title}" — new content is ${newLineCount} `
            + `lines, down from ${currentLineCount} (below ${SIZE_DROP_THRESHOLD * 100}% threshold)`,
        );
    }

    const data = withComputedId(mergeMetadata(existingMetadata, metadata), metadata, title);
    const raw = matter.stringify(newBody, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: newLineCount };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add note_edit with ambiguous-match guard and metadata merge"
```

---

### Task 7: `noteAppend`

**Files:**
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Consumes: `readRawNote`, `computeId` from Tasks 4/3.
- Produces: `noteAppend(vaultRoot, title, hash, content) -> { title, hash, line_count }`. Hash required
  (no exemption — CLAUDE.md's "no exceptions" rule, per S003's explicit reversal of an earlier draft).
  No `metadata` parameter. No size-drop guard (append can only grow line count, so the guard is
  structurally unreachable — no test needed for that, it's a property of the code shape, not a
  behavior to verify).

- [ ] **Step 1: Write the failing test**

Add to `src/core/notes.test.js`:

```js
import { noteAppend } from './notes.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — `noteAppend is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/notes.js` — add `noteAppend`:

```js
export function noteAppend(vaultRoot, title, hash, content) {
    if (!hash) {
        throw new Error(`note_append: hash is required for "${title}"`);
    }

    const filePath = titleToPath(vaultRoot, title);
    const currentRaw = readRawNote(filePath, title);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_append: hash mismatch for "${title}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before appending.`,
        );
    }

    const { data: existingMetadata, content: existingBody } = matter(currentRaw);
    const newBody = existingBody === '' ? content : `${existingBody}\n${content}`;

    const data = withComputedId(existingMetadata, null, title);
    const raw = matter.stringify(newBody, data);

    writeFileSync(filePath, raw, 'utf8');

    return { title, hash: hashContent(raw), line_count: countLines(newBody) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add note_append"
```

---

### Task 8: `noteRename`

**Files:**
- Modify: `src/core/notes.js`
- Modify: `src/core/notes.test.js`

**Interfaces:**
- Consumes: `titleToPath`, `readRawNote`, `hashContent`, `countLines`, `computeId` from prior tasks.
- Produces: `noteRename(vaultRoot, oldTitle, newTitle, hash) -> { title, hash, line_count }`. Moves the
  file, rewrites the `id` frontmatter field to match the new filename (so `content_hash` necessarily
  changes even though the body is untouched — this is the natural consequence of `id` being stored in
  the file, per S003, not a special case). Hard error (no `force`) if `newTitle` already exists. Does
  not touch the SQLite index — the rename is a plain filesystem move; the indexing daemon (S005) picks
  it up as an ordinary delete+create pair, out of scope here.

- [ ] **Step 1: Write the failing test**

Add to `src/core/notes.test.js`:

```js
import { existsSync } from 'node:fs';
import { noteRename } from './notes.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: FAIL — `noteRename is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/notes.js` — add `unlinkSync` to the `node:fs` import and add `noteRename`:

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';

// ...

export function noteRename(vaultRoot, oldTitle, newTitle, hash) {
    if (!hash) {
        throw new Error(`note_rename: hash is required for "${oldTitle}"`);
    }

    const oldPath = titleToPath(vaultRoot, oldTitle);
    const newPath = titleToPath(vaultRoot, newTitle);

    const currentRaw = readRawNote(oldPath, oldTitle);
    const currentHash = hashContent(currentRaw);

    if (currentHash !== hash) {
        throw new Error(
            `note_rename: hash mismatch for "${oldTitle}" — note has changed since last read `
            + `(expected ${hash}, found ${currentHash}). Read the note again before renaming.`,
        );
    }

    if (existsSync(newPath)) {
        throw new Error(
            `note_rename: "${newTitle}" already exists — cannot rename onto an existing note`,
        );
    }

    const { data: existingMetadata, content: body } = matter(currentRaw);
    const data = withComputedId(existingMetadata, null, newTitle);
    const raw = matter.stringify(body, data);

    mkdirSync(dirname(newPath), { recursive: true });
    writeFileSync(newPath, raw, 'utf8');
    unlinkSync(oldPath);

    return { title: newTitle, hash: hashContent(raw), line_count: countLines(body) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/notes.test.js`
Expected: PASS (full suite green)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/notes.js src/core/notes.test.js
git commit -m "feat(notes): add note_rename with id rewrite and hard target-exists guard"
```

---

## Self-Review Notes

- **Spec coverage**: every tool S003 defines — `note_read`, `note_write` (create + update + size-drop
  guard + `force`), `note_edit` (surgical replace + ambiguous-match errors + metadata merge + guard
  with no `force`), `note_append` (hash-required, no metadata, no guard), `note_rename` (move + `id`
  rewrite + hard no-force target-exists error) — has a dedicated task and passing tests. The
  system-managed `id` field (computed, never caller-settable, silently overwritten if supplied) is
  covered in Tasks 3, 4, 7, and 8 (every mutation path that touches frontmatter), including the
  `withComputedId` debug-logging behavior added per S003's "Logging" section and S008.
- **Deliberate deviation from the orienting brief**: the task brief for this plan suggested wiring
  `core/db.js` into `notes.js` and using a DB fixture in tests (to track `content_hash`/`line_count`/
  `mtime` on the `notes` row). Reading `docs/specs/S003-notes.md` directly shows this is wrong for this
  spec: S003 states outright that `core/notes.js` "does not touch the SQLite index directly" and that a
  rename "shows up to the indexing daemon as an ordinary file delete + create pair" — i.e. the `notes`
  table is reconciled asynchronously by S005's daemon, never synchronously by this file. Per CLAUDE.md
  ("if anything here conflicts with a spec, the spec wins"), this plan has **no `db` parameter
  anywhere** and **no SQLite fixture in any test** — only a real temp directory standing in for the
  vault root. This should be flagged to AJ before implementation starts, since it's a meaningful
  structural difference from how the task was originally framed.
- **Explicitly out of scope here, per S003's own "Explicitly out of scope" section and cross-references
  to other specs** (not implemented in this plan, and no task above should be read as covering them):
  - Path/title validation against the "flat vault structure" convention (root + `Weekly Notes/` +
    `Daily Notes/`, no other nesting) — deliberately unenforced by the tool, stays social/documented.
  - Tag extraction from frontmatter `tags:` arrays or inline `#hashtags` — S004.
  - How a rename's delete+create filesystem events get picked up and reindexed — S005.
  - `note_rename`'s MCP tool schema and the README's tool-table reconciliation — S007.
  - Any CLI flag parsing, MCP tool registration, or output formatting (pipe-delimited vs. JSON) — S006/
    S007; `core/notes.js` returns plain JS objects only.
  - `config.toml`-backed `vaultRoot` resolution and the `0.5` size-drop threshold becoming a real
    config value instead of the `SIZE_DROP_THRESHOLD` constant introduced in Task 5 — S009.
- **Design decisions flagged for confirmation** (spelled out in the plan's Architecture section, not
  buried): `content_hash` = SHA-1 of the whole raw file (frontmatter included, per S001's exact
  wording); `line_count`/`total_lines` = body-only line count (excludes the frontmatter block, since
  `note_read` already exposes frontmatter separately as `metadata`); `note_edit` has no `force` bypass
  for its size-drop guard, resolved by preferring S007's finalized tool-input list over S003's less
  specific prose; a non-null `hash` against a nonexistent note is treated as its own distinct error
  beyond what S003's prose explicitly enumerates.
- **Placeholder scan**: no TODOs/TBDs left unresolved across tasks; Task 3's intentional
  "not yet implemented" stub for `noteWrite`'s update branch is explicitly closed out by Task 4, mirror-
  ing the same pattern S001's plan used between its Task 9 and Task 10.
- **Type/signature consistency**: every mutating function returns exactly `{ title, hash, line_count }`
  from the task that completes it through the end of the plan; `noteRead`'s return shape is fixed from
  Task 2 onward and never changes shape in later tasks. `vaultRoot` is always the first argument,
  consistently, across all eight exported functions.
