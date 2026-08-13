# S004 Grep & Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/core/grep.js` (a system-`rg` wrapper scoped to the vault) and
`src/core/tags.js` (tag extraction from note content plus the `tag_list`/`tag_notes` read queries)
per `docs/specs/S004-grep-tags.md`.

**Architecture:**

- `grep(vaultRoot, pattern, options)` shells out to a **system-installed `rg` binary** (never an
  npm-bundled copy) via `node:child_process`'s `execFileSync`, using `rg --json` so results are
  parsed from structured NDJSON rather than scraped from plain-text output. It restricts matches to
  `*.md` files, supports fixed-string (default) vs. regex mode, always applies `--smart-case`, can
  scope to a single note by title, and caps per-note line matches at 10 (returning the true total
  alongside the capped array so a caller can compute "(+N more)"). `assertRipgrepAvailable()` gives a
  clear, actionable error instead of a raw `ENOENT` when `rg` isn't on `PATH` — this project already
  assumes `rg` is a system prerequisite (README tech-stack table), the same posture taken toward
  `node`/`fswatch`/`launchd` elsewhere in this codebase, so tests exercise the real binary rather than
  mocking `child_process`.
- `extractTags(body, metadata)` is a pure function: it merges frontmatter `metadata.tags` with inline
  `#hashtag` matches scanned from `body`, deduplicating case-insensitively within the note (first
  occurrence wins — frontmatter is scanned before the inline body scan, matching the spec's own
  ordering of the two sources) and skipping matches inside fenced code blocks / inline code spans.
  Nothing about *when* this runs during reindex is decided here — that's S005's job; this spec's
  scope is the extraction function and the two read queries only.
- `syncNoteTags(db, noteId, tagNames)` performs the case-insensitive upsert into `tags`
  (`INSERT ... ON CONFLICT(name) DO NOTHING`, `COLLATE NOCASE` preserves first-seen casing per S001)
  and replaces that note's `note_tags` rows (delete-then-reinsert, mirroring S001's idempotent-reindex
  step 4). This lives in `tags.js` because S004's own "Storage" section specifies the exact upsert SQL
  — S005 calls this function during reindex rather than re-deriving the SQL itself.
- `tagList(db)` and `tagNotes(db, tagName)` are read-only queries per the spec: `tagList` is an exact-
  match inventory (one row per distinct tag string, own count, nested tags shown separately), while
  `tagNotes` does case-insensitive parent-includes-child prefix matching (`tag_notes("project")` also
  returns notes tagged `project/api-migration`, etc.).

**Tech Stack:** Node 24 built-in `node:child_process` (`execFileSync`) and `node:fs`/`node:path`
(no new npm dependencies — `rg` is a system binary per the README), `node:sqlite` via
`openDb`/`SCHEMA_VERSION` from `src/core/db.js` (S001, already implemented), Vitest with a real
temp vault directory (`mkdtempSync`) for `grep.js` tests and a real in-memory/temp-file SQLite DB
(`openDb(':memory:')` or a temp-file path) for `tags.js` tests — no mocking `child_process` or the DB
layer, per CLAUDE.md.

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `core/` takes plain arguments, returns plain data, throws on error — no CLI/MCP concerns
  (CLAUDE.md, S001). Notably: **no `reason` parameter anywhere in `core/grep.js` or `core/tags.js`.**
  `reason<string>` is an MCP-tool-schema concern (S007) — it's logged at the MCP boundary, never
  passed down into `core/` (confirmed against S006 "No `reason` flag" / S007 "Every tool takes
  `reason<string>` ... logged per S008" — the CLI has no equivalent flag at all, so a `core/` function
  that required `reason` would be unusable from `cli/`).
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md). Function/object-property naming
  in this plan uses `camelCase` throughout `core/` (`noteTitle`, `fileLineCount`, `lineMatches`,
  `totalMatchCount`, `notesWithTag`) even though the spec's tool-facing field names are `snake_case`
  (`note_title`, `file_line_count`, ...) — that snake_case shape is the MCP/CLI **output format**
  (S006/S007's job, not this plan's), consistent with CLAUDE.md's "All formatting ... happens in
  `cli/` and `mcp/`."
- Test files colocated: `src/core/grep.js` → `src/core/grep.test.js`,
  `src/core/tags.js` → `src/core/tags.test.js` (CLAUDE.md).
- `grep.js` tests use a real temp vault directory (`mkdtempSync(join(tmpdir(), 'mnotes-grep-test-'))`)
  with real files and the real `rg` binary — no mocking `child_process`, matching this project's
  "real, not mocked" testing philosophy for anything touching the filesystem/external tools it already
  assumes are installed.
- `tags.js` tests that touch the DB use a real `openDb(':memory:')` connection from `src/core/db.js`
  (S001) — no mocking the DB layer (CLAUDE.md). `extractTags` itself is pure (no DB), so its tests
  don't need a DB at all.
- 4-space indentation, single quotes, trailing commas on multiline, `func-style: declaration`
  (`function foo() {}`, arrow functions OK for inline callbacks) — matches
  `eslint.config.js`/existing `src/core/db.js` style.
- No new npm dependencies for either file. `rg` is a system binary (README tech-stack table); no
  YAML/frontmatter-parsing library is needed here because `extractTags` receives already-parsed
  `metadata` (S003's job to produce, per the spec: "the `tags` array in parsed YAML metadata
  (`metadata.tags`, already available from the frontmatter parse in S003)") — S004 depends only on
  S001 per its own header, not on S003, so `tags.js` never parses YAML itself.
- Exact function signatures used consistently through every task:
  - `assertRipgrepAvailable(env = process.env) -> void` (throws)
  - `grep(vaultRoot, pattern, options = {}) -> Array<{ noteTitle, fileLineCount, lineMatches, totalMatchCount }>`
    where `options` is `{ regex = false, noteTitle = null, lineMatchCap = 10 }` and `lineMatches` is
    `Array<{ line, text }>`.
  - `extractTags(body, metadata = {}) -> Array<string>`
  - `syncNoteTags(db, noteId, tagNames) -> void`
  - `tagList(db) -> Array<{ tag, notesWithTag }>`
  - `tagNotes(db, tagName) -> Array<{ noteTitle, fileLineCount }>`
- **Known, deliberate small duplication**: `grep.js` needs a filesystem-absolute-path → note-title
  transform (vault-root-relative, strip `.md`), and `tags.js` needs a DB-stored-relative-path →
  note-title transform (strip `.md` — the DB already stores vault-relative paths per S001, so no
  vault-root stripping is needed there). Both are one-line transforms and operate on different input
  shapes, so this plan does **not** invent a shared helper module for them — that would mean building
  ahead of S003's own `core/notes.js`, which owns the canonical path↔title transform once it's speced
  into an implementation. Flagged here so it isn't mistaken for an oversight; worth revisiting once
  S003 lands.

---

### Task 1: `assertRipgrepAvailable` — clear error when `rg` isn't on `PATH`

**Files:**
- Create: `src/core/grep.js`
- Create: `src/core/grep.test.js`

**Interfaces:**
- Produces: `assertRipgrepAvailable(env = process.env) -> void`, throwing a descriptive error
  (`ripgrep not found — install via \`brew install ripgrep\``) when `rg` can't be resolved, used
  internally by every later `grep()` task.

- [ ] **Step 1: Write the failing test**

Create `src/core/grep.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { assertRipgrepAvailable } from './grep.js';

describe('assertRipgrepAvailable', () => {
    it('does not throw when rg is resolvable on PATH', () => {
        expect(() => assertRipgrepAvailable()).not.toThrow();
    });

    it('throws an actionable error when rg is not on PATH', () => {
        expect(() => assertRipgrepAvailable({ PATH: '' })).toThrow(/ripgrep not found/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `src/core/grep.js` doesn't exist yet (`Cannot find module './grep.js'`).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/grep.js`:

```js
import { execFileSync } from 'node:child_process';

export function assertRipgrepAvailable(env = process.env) {
    try {
        execFileSync('rg', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('ripgrep not found — install via `brew install ripgrep`');
        }
        throw error;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): check rg is resolvable on PATH before spawning"
```

---

### Task 2: `grep()` — basic fixed-string match against the vault

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Consumes: `assertRipgrepAvailable` from Task 1.
- Produces: `grep(vaultRoot, pattern) -> Array<{ noteTitle, fileLineCount, lineMatches, totalMatchCount }>`,
  spawning `rg --json -F <pattern> .` with `cwd: vaultRoot`, parsing NDJSON `match` messages into
  per-note results. No glob restriction, `regex` option, `note_title` scoping, smart-case, or line cap
  yet — those are later tasks.

- [ ] **Step 1: Write the failing test**

Add to `src/core/grep.test.js` (new imports + helper, then a new `describe` block):

```js
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { grep } from './grep.js';

const tempDirs = [];

function makeTempVault(files) {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-grep-test-'));
    tempDirs.push(dir);
    for (const [ relPath, content ] of Object.entries(files)) {
        writeFileSync(join(dir, relPath), content);
    }
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});
```

```js
describe('grep', () => {
    it('finds a literal match in a single note', () => {
        const vaultRoot = makeTempVault({
            'Recipe.md': 'line one\nsome hello world text\nline three\n',
        });

        const results = grep(vaultRoot, 'hello');

        expect(results).toHaveLength(1);
        expect(results[0].noteTitle).toBe('Recipe');
        expect(results[0].fileLineCount).toBe(4);
        expect(results[0].lineMatches).toEqual([ { line: 2, text: 'some hello world text' } ]);
        expect(results[0].totalMatchCount).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `grep is not a function` / `does not provide an export named 'grep'`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/grep.js`:

```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function assertRipgrepAvailable(env = process.env) {
    try {
        execFileSync('rg', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('ripgrep not found — install via `brew install ripgrep`');
        }
        throw error;
    }
}

function pathToTitle(vaultRoot, filePath) {
    const rel = relative(vaultRoot, filePath).split(sep).join('/');
    return rel.replace(/\.md$/, '');
}

function countLines(filePath) {
    const content = readFileSync(filePath, 'utf8');
    return content.length === 0 ? 0 : content.split('\n').length;
}

function runRipgrep(args, cwd) {
    try {
        return execFileSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        const stderr = error.stderr ? error.stderr.toString() : error.message;
        throw new Error(`ripgrep failed: ${stderr.trim()}`);
    }
}

export function grep(vaultRoot, pattern) {
    assertRipgrepAvailable();

    const args = [ '--json', '-F', pattern, '.' ];
    const stdout = runRipgrep(args, vaultRoot);
    const matchesByPath = new Map();

    for (const line of stdout.split('\n')) {
        if (!line) {
            continue;
        }
        const message = JSON.parse(line);
        if (message.type !== 'match') {
            continue;
        }
        const absPath = join(vaultRoot, message.data.path.text);
        if (!matchesByPath.has(absPath)) {
            matchesByPath.set(absPath, []);
        }
        matchesByPath.get(absPath).push({
            line: message.data.line_number,
            text: message.data.lines.text.replace(/\n$/, ''),
        });
    }

    const results = [];
    for (const [ absPath, lineMatches ] of matchesByPath) {
        results.push({
            noteTitle: pathToTitle(vaultRoot, absPath),
            fileLineCount: countLines(absPath),
            lineMatches,
            totalMatchCount: lineMatches.length,
        });
    }

    return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): basic fixed-string match via rg --json"
```

---

### Task 3: Restrict to `*.md`, multiple notes

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Produces: `grep()` now passes `--glob '*.md'`, so non-note files (attachments, a stray `.txt`) never
  appear in results even if their text content would otherwise match; multiple matching notes each get
  their own result row.

- [ ] **Step 1: Write the failing test**

Add to `src/core/grep.test.js`:

```js
describe('grep: glob restriction', () => {
    it('only searches .md files and returns one row per matching note', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'first note mentions apple\n',
            'B.md': 'second note also mentions apple pie\n',
            'notes.txt': 'this is not a note but also mentions apple\n',
        });

        const results = grep(vaultRoot, 'apple');
        const titles = results.map(r => r.noteTitle).sort();

        expect(titles).toEqual([ 'A', 'B' ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `titles` includes `'notes.txt'` (the `.txt` file has no `.md` suffix for
`pathToTitle` to strip), because `rg` currently searches every file, not just `*.md`.

- [ ] **Step 3: Write minimal implementation**

Update `grep()` in `src/core/grep.js` — add the glob flag:

```js
export function grep(vaultRoot, pattern) {
    assertRipgrepAvailable();

    const args = [ '--json', '-F', '--glob', '*.md', pattern, '.' ];
    const stdout = runRipgrep(args, vaultRoot);
    // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): restrict search to .md note files"
```

---

### Task 4: `regex` option, invalid-regex error

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Produces: `grep(vaultRoot, pattern, { regex })`. `regex: false` (default) keeps fixed-string mode
  (`-F` — a pattern with regex metacharacters matches literally); `regex: true` drops `-F` so `rg`'s
  regex engine applies, and a syntactically invalid regex throws a descriptive error surfacing `rg`'s
  stderr instead of a raw non-zero-exit failure.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/grep.test.js`:

```js
describe('grep: regex option', () => {
    it('matches literally by default even with regex metacharacters in the pattern', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'price is $5.00 exactly\n',
            'B.md': 'price is $5x00 which should not match the literal pattern\n',
        });

        const results = grep(vaultRoot, '5.00');

        expect(results.map(r => r.noteTitle)).toEqual([ 'A' ]);
    });

    it('treats the pattern as a regex when regex: true', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'price is $5.00 exactly\n',
            'B.md': 'price is $5x00 which should match the regex pattern\n',
        });

        const results = grep(vaultRoot, '5.00', { regex: true });

        expect(results.map(r => r.noteTitle).sort()).toEqual([ 'A', 'B' ]);
    });

    it('throws a descriptive error for an invalid regex pattern', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'hello\n' });

        expect(() => grep(vaultRoot, '(unclosed', { regex: true })).toThrow(/ripgrep failed/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `grep()` doesn't accept an `options` argument yet, so the `regex: true` case behaves
identically to fixed-string mode (second test fails: `B` is missing from results). The invalid-regex
test currently throws too (any non-zero exit throws `ripgrep failed`), so it may already pass — that's
fine, it just confirms the existing error path is reused, not a new one.

- [ ] **Step 3: Write minimal implementation**

Update `grep()` in `src/core/grep.js`:

```js
export function grep(vaultRoot, pattern, options = {}) {
    const { regex = false } = options;
    assertRipgrepAvailable();

    const args = [ '--json', '--glob', '*.md' ];
    if (!regex) {
        args.push('-F');
    }
    args.push(pattern, '.');

    const stdout = runRipgrep(args, vaultRoot);
    // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): add regex option, default to fixed-string matching"
```

---

### Task 5: Smart-case

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Produces: `grep()` always passes `--smart-case` to `rg` — an all-lowercase pattern matches any
  casing; a pattern containing an uppercase letter narrows to that exact casing. (`rg`'s own default is
  plain case-sensitive matching, not smart-case, so this must be passed explicitly.)

- [ ] **Step 1: Write the failing tests**

Add to `src/core/grep.test.js`:

```js
describe('grep: smart-case', () => {
    it('matches any casing when the pattern is all-lowercase', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'calling the API directly\n' });

        const results = grep(vaultRoot, 'api');

        expect(results).toHaveLength(1);
    });

    it('narrows to exact casing when the pattern contains an uppercase letter', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'calling the API directly\n',
            'B.md': 'calling the api directly\n',
        });

        const results = grep(vaultRoot, 'API');

        expect(results.map(r => r.noteTitle)).toEqual([ 'A' ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — first test fails (`rg` is case-sensitive by default, so lowercase `api` doesn't match
`API`).

- [ ] **Step 3: Write minimal implementation**

Update `grep()` in `src/core/grep.js` — add `--smart-case`:

```js
export function grep(vaultRoot, pattern, options = {}) {
    const { regex = false } = options;
    assertRipgrepAvailable();

    const args = [ '--json', '--smart-case', '--glob', '*.md' ];
    if (!regex) {
        args.push('-F');
    }
    args.push(pattern, '.');

    const stdout = runRipgrep(args, vaultRoot);
    // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): apply smart-case matching"
```

---

### Task 6: `note_title` scoping

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Produces: `grep(vaultRoot, pattern, { noteTitle })` resolves `noteTitle` to
  `join(vaultRoot, noteTitle + '.md')` and searches only that file; throws a clear error if the
  resolved path doesn't exist on disk (fail loudly per CLAUDE.md, rather than silently returning `[]`
  for a typo'd title).

- [ ] **Step 1: Write the failing tests**

Add to `src/core/grep.test.js`:

```js
describe('grep: note_title scoping', () => {
    it('searches only the resolved note when noteTitle is given', () => {
        const vaultRoot = makeTempVault({
            'A.md': 'apple pie recipe\n',
            'B.md': 'apple crumble recipe\n',
        });

        const results = grep(vaultRoot, 'apple', { noteTitle: 'A' });

        expect(results).toHaveLength(1);
        expect(results[0].noteTitle).toBe('A');
    });

    it('throws when the given note title does not resolve to a file', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'apple pie recipe\n' });

        expect(() => grep(vaultRoot, 'apple', { noteTitle: 'Nonexistent' })).toThrow(/note not found/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `grep()` ignores `options.noteTitle` entirely, so the first test returns both `A` and
`B`, and the second test doesn't throw.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/grep.js`:

```js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ... assertRipgrepAvailable, pathToTitle, countLines, runRipgrep unchanged from prior tasks

function titleToPath(vaultRoot, noteTitle) {
    return join(vaultRoot, `${noteTitle}.md`);
}

export function grep(vaultRoot, pattern, options = {}) {
    const { regex = false, noteTitle = null } = options;
    assertRipgrepAvailable();

    const args = [ '--json', '--smart-case', '--glob', '*.md' ];
    if (!regex) {
        args.push('-F');
    }

    let targetPath = null;
    if (noteTitle !== null) {
        targetPath = titleToPath(vaultRoot, noteTitle);
        if (!existsSync(targetPath)) {
            throw new Error(`grep: note not found: "${noteTitle}"`);
        }
        args.push(pattern, targetPath);
    } else {
        args.push(pattern, '.');
    }

    const stdout = runRipgrep(args, vaultRoot);
    const matchesByPath = new Map();

    for (const line of stdout.split('\n')) {
        if (!line) {
            continue;
        }
        const message = JSON.parse(line);
        if (message.type !== 'match') {
            continue;
        }
        const absPath = targetPath ?? join(vaultRoot, message.data.path.text);
        if (!matchesByPath.has(absPath)) {
            matchesByPath.set(absPath, []);
        }
        matchesByPath.get(absPath).push({
            line: message.data.line_number,
            text: message.data.lines.text.replace(/\n$/, ''),
        });
    }

    const results = [];
    for (const [ absPath, lineMatches ] of matchesByPath) {
        results.push({
            noteTitle: pathToTitle(vaultRoot, absPath),
            fileLineCount: countLines(absPath),
            lineMatches,
            totalMatchCount: lineMatches.length,
        });
    }

    return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): scope search to a single resolved note title"
```

---

### Task 7: Line-match cap (10 per note)

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Produces: `grep(vaultRoot, pattern, { lineMatchCap = 10 })` — `lineMatches` is capped at
  `lineMatchCap` entries per note, while `totalMatchCount` always reflects the true number of matching
  lines in that note (so a caller can render "(+N more)"). The cap applies per note, not to the total
  number of notes returned.

- [ ] **Step 1: Write the failing test**

Add to `src/core/grep.test.js`:

```js
describe('grep: line-match cap', () => {
    it('caps lineMatches at 10 per note but reports the true total', () => {
        const lines = Array.from({ length: 15 }, (_, i) => `apple mention number ${i}`);
        const vaultRoot = makeTempVault({ 'A.md': `${lines.join('\n')}\n` });

        const results = grep(vaultRoot, 'apple');

        expect(results).toHaveLength(1);
        expect(results[0].lineMatches).toHaveLength(10);
        expect(results[0].totalMatchCount).toBe(15);
    });

    it('accepts a custom lineMatchCap', () => {
        const lines = Array.from({ length: 15 }, (_, i) => `apple mention number ${i}`);
        const vaultRoot = makeTempVault({ 'A.md': `${lines.join('\n')}\n` });

        const results = grep(vaultRoot, 'apple', { lineMatchCap: 3 });

        expect(results[0].lineMatches).toHaveLength(3);
        expect(results[0].totalMatchCount).toBe(15);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `lineMatches` currently has all 15 entries, not capped at 10.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/grep.js` — add a `DEFAULT_LINE_MATCH_CAP` constant, destructure `lineMatchCap` from
`options`, and slice when building results:

```js
const DEFAULT_LINE_MATCH_CAP = 10;

export function grep(vaultRoot, pattern, options = {}) {
    const { regex = false, noteTitle = null, lineMatchCap = DEFAULT_LINE_MATCH_CAP } = options;
    // ... unchanged up through building matchesByPath

    const results = [];
    for (const [ absPath, lineMatches ] of matchesByPath) {
        results.push({
            noteTitle: pathToTitle(vaultRoot, absPath),
            fileLineCount: countLines(absPath),
            lineMatches: lineMatches.slice(0, lineMatchCap),
            totalMatchCount: lineMatches.length,
        });
    }

    return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): cap line matches per note, report true total"
```

---

### Task 8: Zero matches returns `[]`, not a thrown error

**Files:**
- Modify: `src/core/grep.js`
- Modify: `src/core/grep.test.js`

**Interfaces:**
- Produces: `grep()` returns an empty array for a pattern that matches nothing, distinguishing `rg`'s
  exit code `1` ("no matches" — not an error) from exit code `2` ("actual error," e.g. bad pattern,
  already covered by Task 4's invalid-regex test) or a `child_process` spawn failure.

- [ ] **Step 1: Write the failing test**

Add to `src/core/grep.test.js`:

```js
describe('grep: zero matches', () => {
    it('returns an empty array when nothing matches, instead of throwing', () => {
        const vaultRoot = makeTempVault({ 'A.md': 'nothing relevant here\n' });

        const results = grep(vaultRoot, 'no-such-term-anywhere');

        expect(results).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: FAIL — `rg` exits with status `1` for no matches, which `runRipgrep`'s current catch block
treats as a generic failure, so `grep()` throws `ripgrep failed: ` instead of returning `[]`.

- [ ] **Step 3: Write minimal implementation**

Update `runRipgrep` in `src/core/grep.js`:

```js
function runRipgrep(args, cwd) {
    try {
        return execFileSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        if (error.status === 1) {
            return '';
        }
        const stderr = error.stderr ? error.stderr.toString() : error.message;
        throw new Error(`ripgrep failed: ${stderr.trim()}`);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/grep.test.js`
Expected: PASS (full `grep.js` suite green)

- [ ] **Step 5: Run lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/grep.js src/core/grep.test.js
git commit -m "feat(grep): treat rg exit code 1 as zero matches, not an error"
```

---

### Task 9: `extractTags` — frontmatter tags

**Files:**
- Create: `src/core/tags.js`
- Create: `src/core/tags.test.js`

**Interfaces:**
- Produces: `extractTags(body, metadata = {}) -> Array<string>`. Reads `metadata.tags` (an array, per
  S003's already-parsed frontmatter), trims each entry, and dedupes case-insensitively (first-seen
  casing wins) — the `body` parameter exists in the signature now but inline scanning is added in
  Task 10.

- [ ] **Step 1: Write the failing test**

Create `src/core/tags.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { extractTags } from './tags.js';

describe('extractTags: frontmatter', () => {
    it('returns tags from metadata.tags', () => {
        const tags = extractTags('some body text', { tags: [ 'Project', 'work' ] });
        expect(tags).toEqual([ 'Project', 'work' ]);
    });

    it('returns an empty array when there is no tags array', () => {
        expect(extractTags('body', {})).toEqual([]);
        expect(extractTags('body')).toEqual([]);
    });

    it('dedupes case-insensitively within frontmatter, keeping the first casing', () => {
        const tags = extractTags('body', { tags: [ 'Project', 'project', 'PROJECT' ] });
        expect(tags).toEqual([ 'Project' ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — `src/core/tags.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/tags.js`:

```js
export function extractTags(body, metadata = {}) {
    const seen = new Map();

    addTags(seen, frontmatterTags(metadata));

    return Array.from(seen.values());
}

function frontmatterTags(metadata) {
    if (!Array.isArray(metadata.tags)) {
        return [];
    }
    return metadata.tags.map(tag => String(tag).trim()).filter(tag => tag.length > 0);
}

function addTags(seen, tags) {
    for (const tag of tags) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, tag);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): extract tags from frontmatter metadata"
```

---

### Task 10: `extractTags` — inline `#hashtags`

**Files:**
- Modify: `src/core/tags.js`
- Modify: `src/core/tags.test.js`

**Interfaces:**
- Produces: `extractTags` now also scans `body` for inline `#hashtags` per Obsidian's rules: a `#`
  starts a candidate only at line-start or after whitespace/a non-word character (never mid-word, never
  a URL fragment); valid tag characters are Unicode letters, digits, `_`, `-`, `/`. Frontmatter and
  inline sources merge into one deduped set (frontmatter processed first, so it wins on casing
  conflicts, matching the spec's source ordering).

- [ ] **Step 1: Write the failing tests**

Add to `src/core/tags.test.js`:

```js
describe('extractTags: inline hashtags', () => {
    it('extracts a tag at the start of a line and after whitespace', () => {
        const tags = extractTags('#project kickoff\nsome notes about #work today', {});
        expect(tags.sort()).toEqual([ 'project', 'work' ]);
    });

    it('extracts nested tags with slashes and hyphens', () => {
        const tags = extractTags('working on #project/api-migration today', {});
        expect(tags).toEqual([ 'project/api-migration' ]);
    });

    it('does not extract a mid-word # or a URL fragment', () => {
        const tags = extractTags('see foo#bar and https://example.com/page#section', {});
        expect(tags).toEqual([]);
    });

    it('merges frontmatter and inline sources, frontmatter casing wins on conflict', () => {
        const tags = extractTags('mentions #Project inline too', { tags: [ 'project' ] });
        expect(tags).toEqual([ 'project' ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — inline hashtags aren't scanned yet, so the first three new tests return `[]`
unexpectedly and the fourth returns `[]` instead of `['project']`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/tags.js`:

```js
const INLINE_TAG_PATTERN = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_/-]+)/gmu;

export function extractTags(body, metadata = {}) {
    const seen = new Map();

    addTags(seen, frontmatterTags(metadata));
    addTags(seen, inlineTags(body));

    return Array.from(seen.values());
}

function frontmatterTags(metadata) {
    if (!Array.isArray(metadata.tags)) {
        return [];
    }
    return metadata.tags.map(tag => String(tag).trim()).filter(tag => tag.length > 0);
}

function inlineTags(body) {
    const tags = [];
    for (const match of body.matchAll(INLINE_TAG_PATTERN)) {
        tags.push(match[2]);
    }
    return tags;
}

function addTags(seen, tags) {
    for (const tag of tags) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, tag);
        }
    }
}
```

Note on the regex: `(^|[^\p{L}\p{N}_])` is a **consuming** alternation (start-of-line, via the `m`
flag, or a single non-word character), not a lookbehind — simpler and avoids any lookbehind edge
cases, and it works correctly for adjacent tags separated by a single character because `matchAll`
resumes scanning right after each match ends, so the separator before the *next* `#` is still
unconsumed input.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): extract inline #hashtags from note body"
```

---

### Task 11: Numeric-only tags are invalid

**Files:**
- Modify: `src/core/tags.js`
- Modify: `src/core/tags.test.js`

**Interfaces:**
- Produces: `inlineTags` now rejects a candidate whose captured characters are entirely digits
  (`#1984` invalid), while a candidate with at least one non-digit character is valid (`#y1984`,
  `#1984x`, `#84/notes` all valid — the check applies to the whole captured string, so a numeric
  segment inside a nested tag is fine as long as the full string isn't pure digits).

- [ ] **Step 1: Write the failing test**

Add to `src/core/tags.test.js`:

```js
describe('extractTags: numeric-only tags are invalid', () => {
    it('rejects a purely numeric tag', () => {
        expect(extractTags('the year #1984 was notable', {})).toEqual([]);
    });

    it('accepts a tag with at least one non-numeric character', () => {
        expect(extractTags('see #y1984 for context', {})).toEqual([ 'y1984' ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — `#1984` is currently extracted as a valid tag.

- [ ] **Step 3: Write minimal implementation**

Update `inlineTags` in `src/core/tags.js`:

```js
function inlineTags(body) {
    const tags = [];
    for (const match of body.matchAll(INLINE_TAG_PATTERN)) {
        const tag = match[2];
        if (/^\d+$/.test(tag)) {
            continue;
        }
        tags.push(tag);
    }
    return tags;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): reject purely numeric inline tags"
```

---

### Task 12: Exclude code fences and inline code spans

**Files:**
- Modify: `src/core/tags.js`
- Modify: `src/core/tags.test.js`

**Interfaces:**
- Produces: `inlineTags` scans a version of `body` with fenced code blocks (` ``` `) and inline code
  spans (`` ` ``) blanked out first, so a shell shebang, CSS hex color, or a tag-shaped string
  mentioned inside a code span (e.g. discussing `#project` syntax in prose) is never extracted as a
  real tag.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/tags.test.js`:

```js
describe('extractTags: excludes code fences and inline code spans', () => {
    it('ignores a hashtag-shaped string inside an inline code span', () => {
        const body = 'the tag syntax is `#project` written like that';
        expect(extractTags(body, {})).toEqual([]);
    });

    it('ignores a CSS hex color inside an inline code span', () => {
        const body = 'use `#3498db` for the accent color';
        expect(extractTags(body, {})).toEqual([]);
    });

    it('ignores a shebang inside a fenced code block', () => {
        const body = [
            'run this script:',
            '```bash',
            '#!/bin/bash',
            'echo hello',
            '```',
            'that was #actual/tag though',
        ].join('\n');
        expect(extractTags(body, {})).toEqual([ 'actual/tag' ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — the first two tests currently extract `project` / `3498db` from inside the backticks.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/tags.js` — add `stripCode` and call it inside `inlineTags`:

```js
function inlineTags(body) {
    const stripped = stripCode(body);
    const tags = [];
    for (const match of stripped.matchAll(INLINE_TAG_PATTERN)) {
        const tag = match[2];
        if (/^\d+$/.test(tag)) {
            continue;
        }
        tags.push(tag);
    }
    return tags;
}

function stripCode(body) {
    return body
        .replace(/```[\s\S]*?```/g, blank)
        .replace(/`[^`\n]*`/g, blank);
}

function blank(match) {
    return ' '.repeat(match.length);
}
```

Blanking (replacing with same-length spaces) rather than deleting keeps line/column positions stable,
which doesn't matter for `extractTags`'s current output but avoids accidentally merging text on either
side of a removed span into a new false-positive match.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): exclude code fences and inline code spans from tag scanning"
```

---

### Task 13: `syncNoteTags` — upsert tags, replace `note_tags` rows

**Files:**
- Modify: `src/core/tags.js`
- Create: `src/core/tags.test.js` DB test helper (new imports + helper in the same file)

**Interfaces:**
- Consumes: `openDb` from `src/core/db.js` (S001).
- Produces: `syncNoteTags(db, noteId, tagNames) -> void`. Upserts each name into `tags`
  (`INSERT ... ON CONFLICT(name) DO NOTHING`, relying on `COLLATE NOCASE` to preserve first-seen
  casing across notes per S001), then replaces that note's `note_tags` rows entirely (delete existing,
  insert fresh) — matching S001's idempotent-reindex step 4, so re-running with the same `tagNames`
  twice leaves the same rows.

- [ ] **Step 1: Write the failing tests**

Add near the top of `src/core/tags.test.js` (new imports + a DB helper):

```js
import { openDb } from './db.js';

function makeTestDb() {
    const { db } = openDb(':memory:');
    return db;
}

function insertTestNote(db, path) {
    db.prepare(
        'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path, 'abc123', 1, 1000, 1000);
    return db.prepare('SELECT id FROM notes WHERE path = ?').get(path).id;
}
```

Add a new `describe` block:

```js
describe('syncNoteTags', () => {
    it('creates tags and links them to the note', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'Project', 'work' ]);

        const tagNames = db.prepare('SELECT name FROM tags ORDER BY name').all().map(r => r.name);
        expect(tagNames).toEqual([ 'Project', 'work' ]);

        const linkCount = db.prepare('SELECT COUNT(*) AS count FROM note_tags WHERE note_id = ?')
            .get(noteId).count;
        expect(linkCount).toBe(2);
        db.close();
    });

    it('preserves first-seen tag casing across notes via COLLATE NOCASE', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');

        syncNoteTags(db, noteA, [ 'Project' ]);
        syncNoteTags(db, noteB, [ 'project' ]);

        const tagNames = db.prepare('SELECT name FROM tags').all().map(r => r.name);
        expect(tagNames).toEqual([ 'Project' ]);
        db.close();
    });

    it('replaces note_tags rows on a second call, dropping stale links', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'old-tag' ]);
        syncNoteTags(db, noteId, [ 'new-tag' ]);

        const linkedNames = db.prepare(`
            SELECT t.name FROM tags t
            JOIN note_tags nt ON nt.tag_id = t.id
            WHERE nt.note_id = ?
        `).all(noteId).map(r => r.name);
        expect(linkedNames).toEqual([ 'new-tag' ]);
        db.close();
    });

    it('is idempotent when called twice with the same tags', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'Test.md');

        syncNoteTags(db, noteId, [ 'stable' ]);
        syncNoteTags(db, noteId, [ 'stable' ]);

        const linkCount = db.prepare('SELECT COUNT(*) AS count FROM note_tags WHERE note_id = ?')
            .get(noteId).count;
        expect(linkCount).toBe(1);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — `syncNoteTags is not a function` / not exported yet.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/tags.js` — add `syncNoteTags` and `upsertTag`:

```js
export function syncNoteTags(db, noteId, tagNames) {
    const tagIds = new Set(tagNames.map(name => upsertTag(db, name)));

    db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);

    const insert = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)');
    for (const tagId of tagIds) {
        insert.run(noteId, tagId);
    }
}

function upsertTag(db, name) {
    db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
    return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): upsert tags and sync note_tags links for a note"
```

---

### Task 14: `tagList`

**Files:**
- Modify: `src/core/tags.js`
- Modify: `src/core/tags.test.js`

**Interfaces:**
- Consumes: `syncNoteTags` (Task 13) to set up fixture data.
- Produces: `tagList(db) -> Array<{ tag, notesWithTag }>` — one row per distinct tag (exact string,
  nested tags counted separately), exact-match note count, ordered alphabetically (`COLLATE NOCASE`).
  Tags with zero linked notes (orphaned after all their notes were deleted/retagged) are excluded via
  an inner join — an inventory of "tags currently in use," not a historical record of every name ever
  seen.

- [ ] **Step 1: Write the failing test**

Add to `src/core/tags.test.js`:

```js
describe('tagList', () => {
    it('returns exact-match counts per distinct tag, nested tags counted separately', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');
        const noteC = insertTestNote(db, 'C.md');

        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'project' ]);
        syncNoteTags(db, noteC, [ 'project/api-migration' ]);

        const list = tagList(db);

        expect(list).toEqual([
            { tag: 'project', notesWithTag: 2 },
            { tag: 'project/api-migration', notesWithTag: 1 },
        ]);
        db.close();
    });

    it('excludes a tag with no linked notes', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'A.md');

        syncNoteTags(db, noteId, [ 'temp' ]);
        syncNoteTags(db, noteId, []);

        expect(tagList(db)).toEqual([]);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — `tagList is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/tags.js` — add `tagList`:

```js
export function tagList(db) {
    return db.prepare(`
        SELECT t.name AS tag, COUNT(nt.note_id) AS notesWithTag
        FROM tags t
        JOIN note_tags nt ON nt.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.name COLLATE NOCASE
    `).all();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): add tagList query"
```

---

### Task 15: `tagNotes` — parent-includes-child matching

**Files:**
- Modify: `src/core/tags.js`
- Modify: `src/core/tags.test.js`

**Interfaces:**
- Produces: `tagNotes(db, tagName) -> Array<{ noteTitle, fileLineCount }>` — case-insensitive
  exact-or-child-prefix match (`tagNotes('project')` also returns notes tagged
  `project/api-migration`), `DISTINCT` so a note tagged with both a parent and a child tag appears
  once, `noteTitle` derived from the DB's already-vault-relative `path` column (strip `.md` only — no
  vault-root stripping needed here, unlike `grep.js`, since `notes.path` is stored relative to the
  vault root per S001).

- [ ] **Step 1: Write the failing tests**

Add to `src/core/tags.test.js`:

```js
describe('tagNotes', () => {
    it('returns notes tagged exactly and notes tagged with a nested child', () => {
        const db = makeTestDb();
        const noteA = insertTestNote(db, 'A.md');
        const noteB = insertTestNote(db, 'B.md');
        const noteC = insertTestNote(db, 'Unrelated.md');

        syncNoteTags(db, noteA, [ 'project' ]);
        syncNoteTags(db, noteB, [ 'project/api-migration' ]);
        syncNoteTags(db, noteC, [ 'other' ]);

        const results = tagNotes(db, 'project');

        expect(results.map(r => r.noteTitle).sort()).toEqual([ 'A', 'B' ]);
        db.close();
    });

    it('matches case-insensitively', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'Project' ]);

        const results = tagNotes(db, 'project');

        expect(results.map(r => r.noteTitle)).toEqual([ 'A' ]);
        db.close();
    });

    it('returns a note only once when it carries both a parent and a child tag', () => {
        const db = makeTestDb();
        const noteId = insertTestNote(db, 'A.md');
        syncNoteTags(db, noteId, [ 'project', 'project/api-migration' ]);

        const results = tagNotes(db, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].noteTitle).toBe('A');
        db.close();
    });

    it('includes fileLineCount from the notes table', () => {
        const db = makeTestDb();
        db.prepare(
            'INSERT INTO notes (path, content_hash, line_count, mtime, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('A.md', 'abc123', 42, 1000, 1000);
        const noteId = db.prepare('SELECT id FROM notes WHERE path = ?').get('A.md').id;
        syncNoteTags(db, noteId, [ 'project' ]);

        const results = tagNotes(db, 'project');

        expect(results[0].fileLineCount).toBe(42);
        db.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: FAIL — `tagNotes is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/core/tags.js` — add `tagNotes`:

```js
export function tagNotes(db, tagName) {
    const rows = db.prepare(`
        SELECT DISTINCT n.path AS path, n.line_count AS fileLineCount
        FROM notes n
        JOIN note_tags nt ON nt.note_id = n.id
        JOIN tags t ON t.id = nt.tag_id
        WHERE t.name = ? OR t.name LIKE ? || '/%'
        ORDER BY n.path
    `).all(tagName, tagName);

    return rows.map(row => ({
        noteTitle: row.path.replace(/\.md$/, ''),
        fileLineCount: row.fileLineCount,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/tags.test.js`
Expected: PASS (full `tags.js` suite green)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass (both `grep.test.js` and `tags.test.js`), no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/tags.js src/core/tags.test.js
git commit -m "feat(tags): add tagNotes query with parent-includes-child matching"
```

---

## Self-Review Notes

- **Spec coverage**: every behavior called out in `docs/specs/S004-grep-tags.md` has a task —
  fixed-string default / regex opt-in (Task 4), smart-case (Task 5), `note_title` scoping (Task 6),
  the 10-line-match cap with true-total reporting (Task 7), the `*.md` glob restriction (Task 3), a
  clear "rg not found" error (Task 1); frontmatter + inline `#hashtag` extraction merged with no
  source distinction (Tasks 9–10), the numeric-only-tag rejection (Task 11), code-fence/inline-code
  exclusion (Task 12), the `COLLATE NOCASE` upsert-preserving-first-seen-casing storage behavior
  (Task 13), exact-match `tag_list` (Task 14), and parent-includes-child `tag_notes` (Task 15).
- **Explicitly out of scope, per the spec's own "Explicitly out of scope here" section** — not
  covered by this plan, deliberately: when/how extraction+`syncNoteTags` actually gets invoked during
  a reindex (per-note vs. full-vault, idempotency at the reindex-loop level) is S005's job, not S004's
  — this plan only builds the extraction function and the storage/query functions S005 will call.
  CLI `--explain`-style debug output is S006's call, if it ends up needed at all. The MCP/CLI surfaces
  themselves (tool schemas, `snake_case` output formatting, the `reason` parameter) are S006/S007.
- **`reason` deliberately absent**: confirmed against S006 ("No `reason` flag" — the CLI has nothing
  equivalent) and S007 ("Every tool takes `reason<string>`... logged per S008") that `reason` is an
  MCP-tool-schema concern layered on top of `core/` calls, not a `core/` function parameter — so
  `grep()`/`extractTags()`/`syncNoteTags()`/`tagList()`/`tagNotes()` never take one.
- **camelCase vs. snake_case boundary**: this plan's `core/` functions return camelCase object keys
  (`noteTitle`, `fileLineCount`, `notesWithTag`, ...); the spec's field names are snake_case
  (`note_title`, `file_line_count`, `notes_with_tag`) because that's the *tool output* shape from
  README/S007, which is S006/S007's formatting responsibility per CLAUDE.md, not this plan's.
  Flagging explicitly so a future S006/S007 implementer knows a key-name mapping step is expected at
  that boundary, not a naming inconsistency to "fix" here.
- **`rg` assumed present, real binary in tests**: matches this project's existing posture toward other
  system-installed tools (`fswatch`, `launchd`) — `grep.test.js` spawns the real `rg` against real temp
  vault directories rather than mocking `child_process`, consistent with CLAUDE.md's DB-testing
  guidance extended to this file's own external dependency.
- **Design calls made without an existing precedent to copy** (flagging per CLAUDE.md's "stop and ask
  when a new architectural decision is needed" — these are small enough to proceed on, but are called
  out here rather than silently baked in):
  - `tagList` excludes zero-linked (orphaned) tags via `JOIN` rather than `LEFT JOIN`. An orphan can
    only arise if every note carrying a tag is deleted or retagged without ever re-running extraction
    against a note that still uses it — a "tags currently in use" inventory reads as more useful than
    surfacing dead rows, but this is a judgment call, not something the spec states outright.
  - `rg --json` (structured NDJSON) is used instead of parsing `rg`'s plain-text output — not
    mentioned in the spec either way, but far more robust than regex-scraping `file:line:text` lines,
    especially for filenames/content containing colons.
  - The `grep.js` / `tags.js` path→title duplication noted in Global Constraints (two different,
    small, one-line transforms — not the same code) is deliberate, not an oversight; consolidating
    into a shared helper is deferred to whenever S003's `core/notes.js` exists as the canonical home.
- **Placeholder scan**: no TODOs/TBDs; every step has complete, runnable code.
- **Type/signature consistency**: `grep(vaultRoot, pattern, options)` and its return shape are
  identical from Task 2 through Task 8; `extractTags(body, metadata)`, `syncNoteTags(db, noteId,
  tagNames)`, `tagList(db)`, and `tagNotes(db, tagName)` are each introduced once and never change
  shape afterward.
