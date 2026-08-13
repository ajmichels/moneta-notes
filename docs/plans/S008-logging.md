# S008 Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/logger.js` (shared `pino`-based logger factory + audit-trail writer) and
`src/log-rotator.js` (standalone rotation script, run by its own LaunchAgent) per
`docs/specs/S008-logging.md`.

**Architecture:** `src/logger.js` exports `getLogger(component, logDir)`, a factory that returns a
`pino` instance writing structured JSON lines to `<logDir>/<component>.log`, bound with a
`component` field and a consistent line shape (string `level`, ISO `timestamp`, `msg`). A thin
`getAuditLogger(logDir)` wrapper gets the `'audit'` component's logger, and `logAudit(auditLogger,
entry)` is the only way anything writes to it — it validates the entry against S008's exact shape
(`tool`, `note_title`, `source`, `reason`, `outcome`, plus an `error_message` on failure) and
allowlists fields by destructuring, so any extra data a caller accidentally passes (note body, diff)
is silently dropped rather than persisted. `defaultLogDir()` centralizes the real
`~/Library/Logs/com.ajmichels.mnotes` path so callers (indexer, MCP server) never hardcode it, while
every test passes an explicit temp directory instead — the same `dbPath`-style testability pattern
S001 established for `openDb`.

`src/log-rotator.js` is a one-shot script (not a long-running process): `shouldRotate(filePath,
policy)` checks a single file's size/age against thresholds, `rotateLogFile(filePath, keepCount)`
does the actual numbered-suffix shift-and-truncate, `rotateLogDirectory(logDir, fileNames, policy)`
applies both across the three known log files, and `main(logDir)` is the entry point invoked when the
file is run directly (guarded so importing it in tests has no side effects). The LaunchAgent plist
that schedules `main()` and the `config.toml` keys that would make the policy numbers configurable
are both S009's concern, not this plan's.

**Tech Stack:** `pino` (structured JSON logging), Node built-ins (`node:fs`, `node:os`, `node:path`,
`node:url`), Vitest with real temp directories and real files (no mocking `pino` or the filesystem,
per CLAUDE.md).

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step (CLAUDE.md).
- `src/logger.js` and `src/log-rotator.js` are top-level `src/` modules per the README's file
  layout — not under `core/`, since they're cross-cutting infra consumed by `indexer/`, `cli/`, and
  `mcp/`, not domain/search/notes logic.
- `kebab-case` filenames; `camelCase` functions/variables (CLAUDE.md) — except where a spec-mandated
  on-disk JSON field name is itself snake_case (`note_title`, `error_message` in the audit entry
  shape). JS call sites stay camelCase (`noteTitle`, `errorMessage`); the snake_case only appears as
  an object *key* at the point `logAudit` builds the log line.
- Test files colocated: `src/logger.js` → `src/logger.test.js`, `src/log-rotator.js` →
  `src/log-rotator.test.js` (CLAUDE.md).
- Real temp directories and real files in every test — never mock `pino`, `fs`, or a destination
  stream (CLAUDE.md's "real, not mocked" testing philosophy, established in S001 for the DB layer,
  applied here to the filesystem).
- `pino` destinations are opened with `sync: true` so every test can `readFileSync` immediately after
  a log call with no flush/wait — appropriate for a personal, single-user, low-volume tool where
  synchronous file I/O overhead is a non-issue.
- 4-space indentation, single quotes, trailing commas on multiline (matches existing
  `eslint.config.js`-enforced style).
- `func-style: declaration` — use `function foo() {}`, not `const foo = () => {}`, for named
  functions (arrow functions are fine for inline callbacks).
- Never log full note content or diffs (CLAUDE.md, S008) — enforced structurally in `logAudit` via an
  explicit field allowlist (destructuring only known keys), not by trusting callers to omit content.
- Exact rotation policy numbers (10MB / 7 days / keep 5) and file layout (`indexer.log`,
  `mcp-server.log`, `audit.log`) are per `docs/specs/S008-logging.md`, copied verbatim into the tasks
  below. The LaunchAgent plist and `config.toml` keys that would make these numbers configurable are
  explicitly out of scope (S009) — this plan hardcodes them as default parameter values so every
  function stays overridable/testable without reading config itself.
- What each consuming component actually logs (daemon lifecycle events in S005, protocol events in
  S007, individual tool-call sites) is that component's own concern — this plan only builds the
  shared `logger.js`/`log-rotator.js` infrastructure, no call sites in `indexer/`, `cli/`, or `mcp/`.

---

### Task 1: `getLogger` — per-component file destination

**Files:**
- Modify: `package.json` (add `pino` dependency)
- Create: `src/logger.js`
- Create: `src/logger.test.js`

**Interfaces:**
- Produces: `getLogger(component: string, logDir: string) -> pino.Logger` — a logger bound with a
  `component` field, writing JSON lines to `<logDir>/<component>.log`. Later tasks refine the line
  shape and add directory auto-creation; later files (`log-rotator.js`) treat `<logDir>/<component>.log`
  as the file to rotate.

- [ ] **Step 1: Add the `pino` dependency**

Run: `pnpm add pino@^9`

- [ ] **Step 2: Write the failing test**

Create `src/logger.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from './logger.js';

const tempDirs = [];

function makeTempLogDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-logger-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('getLogger', () => {
    it('writes a JSON line tagged with the component and the log message', () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        logger.info('daemon started');

        const line = JSON.parse(readFileSync(join(logDir, 'indexer.log'), 'utf8').trim());
        expect(line.component).toBe('indexer');
        expect(line.msg).toBe('daemon started');
    });

    it('routes different components to separate files in the same directory', () => {
        const logDir = makeTempLogDir();
        const indexerLogger = getLogger('indexer', logDir);
        const mcpLogger = getLogger('mcp-server', logDir);

        indexerLogger.info('from indexer');
        mcpLogger.info('from mcp');

        const indexerLine = JSON.parse(readFileSync(join(logDir, 'indexer.log'), 'utf8').trim());
        const mcpLine = JSON.parse(readFileSync(join(logDir, 'mcp-server.log'), 'utf8').trim());
        expect(indexerLine.msg).toBe('from indexer');
        expect(mcpLine.msg).toBe('from mcp');
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/logger.test.js`
Expected: FAIL — `src/logger.js` doesn't exist yet (`Cannot find module './logger.js'` or similar).

- [ ] **Step 4: Write minimal implementation**

Create `src/logger.js`:

```js
import pino from 'pino';
import { join } from 'node:path';

export function getLogger(component, logDir) {
    const destination = pino.destination({
        dest: join(logDir, `${component}.log`),
        sync: true,
    });

    return pino({ base: { component } }, destination);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/logger.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/logger.js src/logger.test.js
git commit -m "feat(logging): add getLogger factory with per-component file destinations"
```

---

### Task 2: Consistent line shape — string level label, `timestamp` field

**Files:**
- Modify: `src/logger.js`
- Modify: `src/logger.test.js`

**Interfaces:**
- Consumes: `getLogger` from Task 1.
- Produces: every line from `getLogger` now carries a string `level` (`"info"`, `"warn"`, ...) instead
  of pino's default numeric level, and a `timestamp` field (ISO-8601 string) instead of pino's default
  numeric `time` field — matching CLAUDE.md's "consistent shape (timestamp, component, level,
  message)" requirement literally, not just conceptually.

- [ ] **Step 1: Write the failing test**

Add to `src/logger.test.js`:

```js
describe('getLogger: consistent line shape', () => {
    it('writes level as a string label and timestamp as an ISO string', () => {
        const logDir = makeTempLogDir();
        const logger = getLogger('indexer', logDir);
        logger.warn('something odd');

        const line = JSON.parse(readFileSync(join(logDir, 'indexer.log'), 'utf8').trim());
        expect(line.level).toBe('warn');
        expect(typeof line.timestamp).toBe('string');
        expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
        expect(line.time).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/logger.test.js`
Expected: FAIL — `line.level` is a number (`40`), not `'warn'`; `line.timestamp` is `undefined`
(pino's default field is `time`, a number).

- [ ] **Step 3: Write minimal implementation**

Update `src/logger.js`:

```js
import pino from 'pino';
import { join } from 'node:path';

export function getLogger(component, logDir) {
    const destination = pino.destination({
        dest: join(logDir, `${component}.log`),
        sync: true,
    });

    return pino(
        {
            base: { component },
            formatters: {
                level(label) {
                    return { level: label };
                },
            },
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        },
        destination,
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/logger.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/logger.js src/logger.test.js
git commit -m "feat(logging): use string level labels and a timestamp field"
```

---

### Task 3: Recursive log-directory creation, `defaultLogDir`

**Files:**
- Modify: `src/logger.js`
- Modify: `src/logger.test.js`

**Interfaces:**
- Produces: `getLogger` now creates `logDir` (recursively) if it doesn't exist yet, and
  `defaultLogDir() -> string` returns the real `~/Library/Logs/com.ajmichels.mnotes` path per S008's
  file layout — the value every real caller (indexer, MCP server, `log-rotator.js`) passes as
  `logDir`, while tests keep passing an explicit temp directory instead.

- [ ] **Step 1: Write the failing tests**

Add to `src/logger.test.js` (new import at top: `import { homedir } from 'node:os';` and add
`defaultLogDir` to the existing `import { getLogger, defaultLogDir } from './logger.js';`):

```js
describe('getLogger: directory creation and defaultLogDir', () => {
    it('creates the log directory recursively if it does not exist yet', () => {
        const base = makeTempLogDir();
        const nested = join(base, 'nested', 'logs');
        const logger = getLogger('indexer', nested);
        logger.info('created nested dir');

        const line = JSON.parse(readFileSync(join(nested, 'indexer.log'), 'utf8').trim());
        expect(line.msg).toBe('created nested dir');
    });

    it('defaultLogDir points at ~/Library/Logs/com.ajmichels.mnotes', () => {
        expect(defaultLogDir()).toBe(join(homedir(), 'Library', 'Logs', 'com.ajmichels.mnotes'));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/logger.test.js`
Expected: FAIL — the nested-directory test throws `ENOENT` from `pino.destination` (parent directory
doesn't exist); `defaultLogDir` is not exported (`defaultLogDir is not a function` or `undefined`).

- [ ] **Step 3: Write minimal implementation**

Update `src/logger.js`:

```js
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultLogDir() {
    return join(homedir(), 'Library', 'Logs', 'com.ajmichels.mnotes');
}

export function getLogger(component, logDir) {
    mkdirSync(logDir, { recursive: true });

    const destination = pino.destination({
        dest: join(logDir, `${component}.log`),
        sync: true,
    });

    return pino(
        {
            base: { component },
            formatters: {
                level(label) {
                    return { level: label };
                },
            },
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        },
        destination,
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/logger.test.js`
Expected: PASS (full file green)

- [ ] **Step 5: Commit**

```bash
git add src/logger.js src/logger.test.js
git commit -m "feat(logging): create log directory recursively, add defaultLogDir"
```

---

### Task 4: Audit trail — `getAuditLogger`, `logAudit`, content redaction guarantee

**Files:**
- Modify: `src/logger.js`
- Modify: `src/logger.test.js`

**Interfaces:**
- Consumes: `getLogger` from Tasks 1–3.
- Produces: `getAuditLogger(logDir) -> pino.Logger` (the `'audit'` component's logger) and
  `logAudit(auditLogger, entry) -> void`, where `entry` is
  `{ tool, noteTitle, source<'mcp'|'cli'>, reason?, outcome<'success'|'error'>, errorMessage? }`.
  `logAudit` validates the entry against S008's rules (`reason` required and non-null iff
  `source === 'mcp'`, `null` iff `source === 'cli'`; `errorMessage` required iff
  `outcome === 'error'`, must be `null` iff `outcome === 'success'`) and throws (per CLAUDE.md's
  "fail loudly") on any violation. It writes at `info` level unconditionally — a failed mutation is
  a normal audit event, not a system error, per S008 — with only the allowlisted fields
  (`tool`, `note_title`, `source`, `reason`, `outcome`, `error_message`); any other property on
  `entry` (e.g. a caller accidentally passing `body` or `diff`) is dropped by destructuring, never
  reaching the log line. `timestamp`, `component`, and `level` come for free from the underlying
  `getLogger` machinery built in Tasks 1–3.

- [ ] **Step 1: Write the failing tests**

Add to `src/logger.test.js` (extend the `getLogger`/`defaultLogDir` import to include
`getAuditLogger, logAudit`):

```js
describe('logAudit', () => {
    it('writes only the allowlisted fields, dropping note body/diff even if passed', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        logAudit(auditLogger, {
            tool: 'note_write',
            noteTitle: 'Weekly Notes/2026-W32',
            source: 'mcp',
            reason: 'testing redaction',
            outcome: 'success',
            body: 'SECRET NOTE CONTENT SHOULD NEVER APPEAR',
            diff: '-old\n+SECRET DIFF LINE',
        });

        const raw = readFileSync(join(logDir, 'audit.log'), 'utf8');
        expect(raw).not.toContain('SECRET NOTE CONTENT');
        expect(raw).not.toContain('SECRET DIFF LINE');

        const line = JSON.parse(raw.trim());
        expect(line).toEqual(
            expect.objectContaining({
                tool: 'note_write',
                note_title: 'Weekly Notes/2026-W32',
                source: 'mcp',
                reason: 'testing redaction',
                outcome: 'success',
                error_message: null,
                level: 'info',
            }),
        );
        expect(line.body).toBeUndefined();
        expect(line.diff).toBeUndefined();
    });

    it('writes at info level even when outcome is "error", including the error message', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        logAudit(auditLogger, {
            tool: 'write',
            noteTitle: 'Test.md',
            source: 'cli',
            outcome: 'error',
            errorMessage: 'hash mismatch',
        });

        const line = JSON.parse(readFileSync(join(logDir, 'audit.log'), 'utf8').trim());
        expect(line.level).toBe('info');
        expect(line.source).toBe('cli');
        expect(line.reason).toBeNull();
        expect(line.error_message).toBe('hash mismatch');
    });

    it('throws when source is "mcp" and reason is missing', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'note_write',
                noteTitle: 'Test.md',
                source: 'mcp',
                outcome: 'success',
            }),
        ).toThrow(/reason/);
    });

    it('throws when source is "cli" and reason is non-null', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                reason: 'should not be here',
                outcome: 'success',
            }),
        ).toThrow(/reason/);
    });

    it('throws when outcome is "error" and errorMessage is missing', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                outcome: 'error',
            }),
        ).toThrow(/errorMessage/);
    });

    it('throws when outcome is "success" and errorMessage is non-null', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                outcome: 'success',
                errorMessage: 'should not be here',
            }),
        ).toThrow(/errorMessage/);
    });

    it('throws on an unrecognized source or outcome value', () => {
        const logDir = makeTempLogDir();
        const auditLogger = getAuditLogger(logDir);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'web',
                outcome: 'success',
            }),
        ).toThrow(/source/);

        expect(() =>
            logAudit(auditLogger, {
                tool: 'write',
                noteTitle: 'Test.md',
                source: 'cli',
                outcome: 'partial',
            }),
        ).toThrow(/outcome/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/logger.test.js`
Expected: FAIL — `getAuditLogger`/`logAudit` are not exported.

- [ ] **Step 3: Write minimal implementation**

Update `src/logger.js` — add `getAuditLogger` and `logAudit` (the rest of the file unchanged from
Task 3):

```js
export function getAuditLogger(logDir) {
    return getLogger('audit', logDir);
}

export function logAudit(auditLogger, entry) {
    const { tool, noteTitle, source, reason = null, outcome, errorMessage = null } = entry;

    if (source !== 'mcp' && source !== 'cli') {
        throw new Error(`logAudit: source must be "mcp" or "cli", got ${JSON.stringify(source)}`);
    }
    if (source === 'mcp' && !reason) {
        throw new Error('logAudit: reason is required when source is "mcp"');
    }
    if (source === 'cli' && reason !== null) {
        throw new Error('logAudit: reason must be null when source is "cli"');
    }
    if (outcome !== 'success' && outcome !== 'error') {
        throw new Error(`logAudit: outcome must be "success" or "error", got ${JSON.stringify(outcome)}`);
    }
    if (outcome === 'error' && !errorMessage) {
        throw new Error('logAudit: errorMessage is required when outcome is "error"');
    }
    if (outcome === 'success' && errorMessage !== null) {
        throw new Error('logAudit: errorMessage must be null when outcome is "success"');
    }

    auditLogger.info({
        tool,
        note_title: noteTitle,
        source,
        reason,
        outcome,
        error_message: errorMessage,
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/logger.test.js`
Expected: PASS (full file green)

- [ ] **Step 5: Commit**

```bash
git add src/logger.js src/logger.test.js
git commit -m "feat(logging): add audit trail writer with field allowlist and shape validation"
```

---

### Task 5: `shouldRotate` — size threshold

**Files:**
- Create: `src/log-rotator.js`
- Create: `src/log-rotator.test.js`

**Interfaces:**
- Produces: `shouldRotate(filePath: string, policy: { maxSizeBytes, maxAgeMs }) -> boolean` — `false`
  for a missing file (no throw; a fresh install with no logs yet must not crash the rotator), `true`
  once file size reaches `maxSizeBytes`. Age handling is added in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `src/log-rotator.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldRotate } from './log-rotator.js';

const tempDirs = [];

function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-rotator-test-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('shouldRotate: size threshold', () => {
    it('returns false for a file below the size threshold', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'small');

        expect(shouldRotate(filePath, { maxSizeBytes: 1024, maxAgeMs: Infinity })).toBe(false);
    });

    it('returns true for a file at or above the size threshold', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, Buffer.alloc(2048));

        expect(shouldRotate(filePath, { maxSizeBytes: 1024, maxAgeMs: Infinity })).toBe(true);
    });

    it('returns false when the file does not exist', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'missing.log');

        expect(shouldRotate(filePath, { maxSizeBytes: 1024, maxAgeMs: Infinity })).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: FAIL — `src/log-rotator.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/log-rotator.js`:

```js
import { existsSync, statSync } from 'node:fs';

export function shouldRotate(filePath, policy) {
    if (!existsSync(filePath)) {
        return false;
    }

    const stats = statSync(filePath);
    return stats.size >= policy.maxSizeBytes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/log-rotator.js src/log-rotator.test.js
git commit -m "feat(logging): add shouldRotate size-threshold check"
```

---

### Task 6: `shouldRotate` — age threshold

**Files:**
- Modify: `src/log-rotator.js`
- Modify: `src/log-rotator.test.js`

**Interfaces:**
- Produces: `shouldRotate` now also returns `true` once a file is older than `policy.maxAgeMs`
  (based on mtime), even if it's still below the size threshold — matching S008's "size **or** age,
  whichever comes first" policy.

- [ ] **Step 1: Write the failing tests**

Add to `src/log-rotator.test.js` (extend the top import to `import { mkdtempSync, rmSync,
writeFileSync, utimesSync } from 'node:fs';`):

```js
describe('shouldRotate: age threshold', () => {
    it('returns true for a file older than the age threshold even if small', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'small');

        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        utimesSync(filePath, eightDaysAgo, eightDaysAgo);

        expect(
            shouldRotate(filePath, {
                maxSizeBytes: 10 * 1024 * 1024,
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
            }),
        ).toBe(true);
    });

    it('returns false for a small, recently modified file', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'small');

        expect(
            shouldRotate(filePath, {
                maxSizeBytes: 10 * 1024 * 1024,
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
            }),
        ).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: FAIL — the "older than threshold" test returns `false` (Task 5's implementation only
checks size).

- [ ] **Step 3: Write minimal implementation**

Update `src/log-rotator.js`:

```js
import { existsSync, statSync } from 'node:fs';

export function shouldRotate(filePath, policy) {
    if (!existsSync(filePath)) {
        return false;
    }

    const stats = statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;

    return stats.size >= policy.maxSizeBytes || ageMs >= policy.maxAgeMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: PASS (full file green)

- [ ] **Step 5: Commit**

```bash
git add src/log-rotator.js src/log-rotator.test.js
git commit -m "feat(logging): add age threshold to shouldRotate"
```

---

### Task 7: `rotateLogFile` — numbered-suffix shift, keep-N cap

**Files:**
- Modify: `src/log-rotator.js`
- Modify: `src/log-rotator.test.js`

**Interfaces:**
- Produces: `rotateLogFile(filePath: string, keepCount: number) -> void` — shifts `filePath.N` to
  `filePath.N+1` for every existing numbered file (highest first, to avoid overwriting), deletes
  whatever would land beyond `filePath.<keepCount>`, renames the active `filePath` to `filePath.1`,
  and recreates an empty `filePath`. Unconditional — callers decide *whether* to rotate via
  `shouldRotate`; this function just performs the rotation once called.

- [ ] **Step 1: Write the failing tests**

Add to `src/log-rotator.test.js` (extend the top import to include `existsSync, readFileSync` and
add `rotateLogFile` to the `./log-rotator.js` import):

```js
describe('rotateLogFile', () => {
    it('shifts numbered files up by one and recreates an empty active file', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'active content');
        writeFileSync(`${filePath}.1`, 'rotated-1');
        writeFileSync(`${filePath}.2`, 'rotated-2');

        rotateLogFile(filePath, 5);

        expect(readFileSync(filePath, 'utf8')).toBe('');
        expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('active content');
        expect(readFileSync(`${filePath}.2`, 'utf8')).toBe('rotated-1');
        expect(readFileSync(`${filePath}.3`, 'utf8')).toBe('rotated-2');
    });

    it('deletes the oldest file beyond the keep count', () => {
        const dir = makeTempDir();
        const filePath = join(dir, 'test.log');
        writeFileSync(filePath, 'active content');
        for (let n = 1; n <= 5; n += 1) {
            writeFileSync(`${filePath}.${n}`, `rotated-${n}`);
        }

        rotateLogFile(filePath, 5);

        expect(existsSync(`${filePath}.6`)).toBe(false);
        expect(readFileSync(`${filePath}.5`, 'utf8')).toBe('rotated-4');
        expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('active content');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: FAIL — `rotateLogFile is not a function` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

Update `src/log-rotator.js` — add `rotateLogFile` (the rest of the file unchanged from Task 6):

```js
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

export function rotateLogFile(filePath, keepCount) {
    const oldest = `${filePath}.${keepCount}`;
    if (existsSync(oldest)) {
        rmSync(oldest);
    }

    for (let n = keepCount - 1; n >= 1; n -= 1) {
        const src = `${filePath}.${n}`;
        if (existsSync(src)) {
            renameSync(src, `${filePath}.${n + 1}`);
        }
    }

    if (existsSync(filePath)) {
        renameSync(filePath, `${filePath}.1`);
    }

    writeFileSync(filePath, '');
}
```

(Keep the existing `shouldRotate` export and its `existsSync, statSync` usage — only the import list
grows to include `renameSync, rmSync, writeFileSync`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: PASS (full file green)

- [ ] **Step 5: Commit**

```bash
git add src/log-rotator.js src/log-rotator.test.js
git commit -m "feat(logging): add rotateLogFile numbered-suffix shift and keep-N cap"
```

---

### Task 8: `rotateLogDirectory` — apply policy across the known log files

**Files:**
- Modify: `src/log-rotator.js`
- Modify: `src/log-rotator.test.js`

**Interfaces:**
- Consumes: `shouldRotate` (Task 6), `rotateLogFile` (Task 7).
- Produces: `DEFAULT_ROTATION_POLICY` (`{ maxSizeBytes: 10MB, maxAgeMs: 7 days, keepCount: 5 }`),
  `LOG_FILE_NAMES` (`['indexer.log', 'mcp-server.log', 'audit.log']`), and
  `rotateLogDirectory(logDir: string, fileNames = LOG_FILE_NAMES, policy = DEFAULT_ROTATION_POLICY)
  -> void` — rotates only the files in `logDir` that currently exceed the policy, skipping files that
  don't exist without throwing (a fresh install may not have written all three logs yet).

- [ ] **Step 1: Write the failing tests**

Add to `src/log-rotator.test.js` (add `rotateLogDirectory` to the `./log-rotator.js` import):

```js
describe('rotateLogDirectory', () => {
    it('rotates only files that exceed the policy thresholds', () => {
        const dir = makeTempDir();
        const bigFile = join(dir, 'indexer.log');
        const smallFile = join(dir, 'mcp-server.log');
        writeFileSync(bigFile, Buffer.alloc(2048));
        writeFileSync(smallFile, 'small');

        rotateLogDirectory(
            dir,
            ['indexer.log', 'mcp-server.log'],
            { maxSizeBytes: 1024, maxAgeMs: Infinity, keepCount: 5 },
        );

        expect(readFileSync(bigFile, 'utf8')).toBe('');
        expect(existsSync(`${bigFile}.1`)).toBe(true);
        expect(readFileSync(smallFile, 'utf8')).toBe('small');
        expect(existsSync(`${smallFile}.1`)).toBe(false);
    });

    it('skips files that do not exist yet without throwing', () => {
        const dir = makeTempDir();

        expect(() =>
            rotateLogDirectory(
                dir,
                ['audit.log'],
                { maxSizeBytes: 1024, maxAgeMs: Infinity, keepCount: 5 },
            ),
        ).not.toThrow();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: FAIL — `rotateLogDirectory is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/log-rotator.js` — add the constants and `rotateLogDirectory` (rest of the file unchanged
from Task 7; add `join` to a new `node:path` import):

```js
import { join } from 'node:path';

export const DEFAULT_ROTATION_POLICY = {
    maxSizeBytes: 10 * 1024 * 1024,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    keepCount: 5,
};

export const LOG_FILE_NAMES = ['indexer.log', 'mcp-server.log', 'audit.log'];

export function rotateLogDirectory(logDir, fileNames = LOG_FILE_NAMES, policy = DEFAULT_ROTATION_POLICY) {
    for (const fileName of fileNames) {
        const filePath = join(logDir, fileName);
        if (shouldRotate(filePath, policy)) {
            rotateLogFile(filePath, policy.keepCount);
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: PASS (full file green)

- [ ] **Step 5: Commit**

```bash
git add src/log-rotator.js src/log-rotator.test.js
git commit -m "feat(logging): add rotateLogDirectory with default rotation policy"
```

---

### Task 9: `main` entry point, direct-execution guard

**Files:**
- Modify: `src/log-rotator.js`
- Modify: `src/log-rotator.test.js`

**Interfaces:**
- Consumes: `rotateLogDirectory` (Task 8), `defaultLogDir` (from `src/logger.js`, Task 3).
- Produces: `main(logDir = defaultLogDir()) -> void`, the function the LaunchAgent invokes by running
  `node src/log-rotator.js` (S009 wires the plist; not this plan's concern). Guarded by an
  ESM-equivalent of `require.main === module` so importing the module in tests — or from anywhere
  else — never triggers a real rotation as a side effect.

- [ ] **Step 1: Write the failing test**

Add to `src/log-rotator.test.js` (add `main` to the `./log-rotator.js` import):

```js
describe('main', () => {
    it('rotates the known log files in the given directory', () => {
        const dir = makeTempDir();
        const auditPath = join(dir, 'audit.log');
        writeFileSync(auditPath, Buffer.alloc(20 * 1024 * 1024));

        main(dir);

        expect(readFileSync(auditPath, 'utf8')).toBe('');
        expect(existsSync(`${auditPath}.1`)).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: FAIL — `main is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/log-rotator.js` — add `main` and the direct-execution guard (rest of the file unchanged
from Task 8; add a `node:url` import):

```js
import { fileURLToPath } from 'node:url';
import { defaultLogDir } from './logger.js';

export function main(logDir = defaultLogDir()) {
    rotateLogDirectory(logDir);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/log-rotator.test.js`
Expected: PASS (full file green)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass (both `src/logger.test.js` and `src/log-rotator.test.js`), no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/log-rotator.js src/log-rotator.test.js
git commit -m "feat(logging): add log-rotator main entry point with direct-execution guard"
```

---

## Self-Review Notes

- **Spec coverage**: `src/logger.js` covers every piece of S008's logging half — `pino`-based
  structured JSON, one shared module rather than ad hoc `console.log` (CLAUDE.md), per-component file
  destinations (`indexer.log`, `mcp-server.log`), a consistent line shape (`component`, string
  `level`, `timestamp`, `msg`), and the `audit.log` trail with its exact entry shape (`tool`,
  `note_title`, `source`, `reason`, `outcome`) plus the "never log full note content or diffs"
  guarantee, enforced structurally via `logAudit`'s field allowlist rather than left to caller
  discipline. `src/log-rotator.js` covers the rotation half — size (10MB) **or** age (7 days)
  threshold, keep-last-5 numbered-suffix rotation, and a one-shot `main()` entry point suited to
  `RunAtLoad` + `StartCalendarInterval` LaunchAgent scheduling (a long-running process was explicitly
  rejected by S008 in favor of OS-level/scheduled rotation).
- **Explicitly out of scope, per S008 and this plan**: the `log-rotator.js` LaunchAgent plist itself
  and `scripts/install.sh` wiring (S009); the exact `config.toml` keys that would make the rotation
  policy numbers configurable (S009) — this plan hardcodes `DEFAULT_ROTATION_POLICY` as a default
  parameter value, overridable by any future caller, but doesn't read config; what each component
  (`indexer/daemon.js`, `mcp/server.js`, `cli/*`) actually logs at each call site (S005/S006/S007) —
  this plan only builds `getLogger`/`getAuditLogger`/`logAudit`, not any of their call sites.
- **Design decisions not verbatim in S008, made explicit for consistency**: (1) the audit entry's
  error-detail field is named `error_message` (S008 says outcome is `"success"` or `"error"` "with
  the error message" but doesn't name the JSON key); (2) `logAudit` throws on shape violations
  (missing/extra `reason`, missing/extra `errorMessage`, invalid `source`/`outcome`) rather than
  silently coercing, matching CLAUDE.md's "fail loudly" architecture rule generalized from `core/` to
  this shared infra module; (3) `pino` destinations use `sync: true` throughout, chosen for test
  determinism and appropriate for this project's low log volume — not spec-mandated but consistent
  with S008's own reasoning for avoiding in-process complexity; (4) JS call sites for `logAudit` use
  camelCase (`noteTitle`, `errorMessage`) per CLAUDE.md's naming conventions, while the persisted JSON
  keys stay snake_case (`note_title`, `error_message`) to match S008's literal entry shape.
- **Placeholder scan**: no TODOs/TBDs; every step has complete, runnable code.
- **Type/signature consistency**: `getLogger(component, logDir) -> pino.Logger` is unchanged in
  signature from Task 1 through Task 4 (only its internal options grow); `getAuditLogger`/`logAudit`
  (Task 4) build on it without modification. `shouldRotate(filePath, policy) -> boolean` (Task 5) and
  `rotateLogFile(filePath, keepCount) -> void` (Task 7) keep identical signatures through
  `rotateLogDirectory` (Task 8) and `main` (Task 9); `DEFAULT_ROTATION_POLICY`/`LOG_FILE_NAMES`
  introduced in Task 8 are the only defaults, referenced consistently by `main` in Task 9.
