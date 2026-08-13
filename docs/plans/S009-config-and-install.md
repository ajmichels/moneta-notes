# S009 Config & Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/config.js` (loads and deep-merges `~/.config/mnotes/config.toml` over
in-code defaults), `scripts/install.sh`, `scripts/uninstall.sh`, and `launchd/*.plist.template`
(the indexing daemon's LaunchAgent and S008's new log-rotation LaunchAgent) per
`docs/specs/S009-config-and-install.md`.

**Architecture:** `src/config.js` exports `buildDefaultConfig()` — a fresh, mutation-safe JS object
mirroring the full `config.toml` schema below — plus `loadConfig(configPath = defaultConfigPath())`,
which deep-merges a sparse on-disk TOML override file over those defaults using `smol-toml` (added as
a new dependency; justification in Task 4). `vault_path`/`db_path` are the two schema keys with no
sensible universal literal default (every machine has its own vault); this plan computes them at call
time from `os.homedir()` via `defaultVaultPath()`/`defaultDbPath()`, the same pattern `S008-logging`'s
plan already established for `defaultLogDir()` — this keeps `config.js`'s built-in defaults and
`install.sh`'s suggested prompts (which also compute from `$HOME`) permanently in sync instead of two
independently-hardcoded copies of the same path. This is a deliberate reading of the spec's "one JS
object mirroring this exact schema" language, flagged here and again in Self-Review Notes since the
spec doesn't spell out the computed-vs-literal distinction explicitly.

`scripts/install.sh`/`scripts/uninstall.sh` are POSIX-ish bash (macOS ships bash 3.2 — no bash-4+-only
syntax), following S009's numbered steps exactly. `launchd/*.plist.template` are XML property lists
with `__TOKEN__`-style placeholders that `install.sh` substitutes via `sed` when rendering the real
plist into `~/Library/LaunchAgents/`.

**Testing note — a deliberate split in this plan:** `src/config.js` is plain JS and gets full
red-green-refactor TDD via Vitest, exactly like every prior plan in this repo (real temp
files/directories for the config fixture, never a mocked `fs`, per CLAUDE.md). `scripts/install.sh`,
`scripts/uninstall.sh`, and the plist templates are **not** JS, and no bash test framework (`bats` or
otherwise) is named anywhere in CLAUDE.md, the README, or any prior spec/plan in this repo —
introducing one here would be a new architectural/tooling decision this plan shouldn't make
unilaterally, per CLAUDE.md's "stop and ask rather than picking a default" guidance. So Part B's tasks
below are structured differently: each is an ordered, verifiable implementation step with a **manual
verification checklist** (commands to run against a scratch `$HOME` and what to confirm) in place of a
`pnpm vitest run` step. If AJ wants automated bash test coverage later, `bats` is the natural
candidate (BATS-core, TAP-compatible, the de facto standard for bash unit testing) — noted here as an
option to raise with him, not adopted by default.

**Tech Stack:** Node 24 built-ins (`node:os`, `node:path`, `node:fs`), `smol-toml` (npm, TOML 1.0.0
parser, added new), Vitest with real temp directories/files (CLAUDE.md) for `config.js`; bash 3.2
(macOS system default) for the scripts; `launchctl`, `sed`, `id`, `rg`, `node` as external system
tools the scripts invoke, matching the posture `S004-grep-tags`/`S005-indexing-daemon` already took
toward `rg`/`fswatch` (trust the system tool, fail clearly if it's missing).

## `config.toml` schema (copied verbatim from `docs/specs/S009-config-and-install.md`)

```toml
vault_path = "/Users/aj/Documents/Notes"
db_path = "/Users/aj/Library/Application Support/mnotes/index.db"
embedding_model = "Qwen3-Embedding-0.6B"

[search]
limit_default = 20          # S002
limit_max = 100              # S002
overfetch_multiplier = 5     # S002
overfetch_cap = 500          # S002
rrf_k = 60                   # S002 (README-stated default)

[notes]
size_drop_threshold = 0.50   # S003 — reject a write/edit dropping below this fraction of prior line count

[grep]
line_match_cap = 10          # S004 — line numbers shown per note before "(+N more)"

[index]
debounce_ms = 15000                    # S005 — per-path fswatch debounce window
model_idle_unload_minutes = 10         # S005
embedding_dtype = "q8"                 # S005 — fp32 | fp16 | q8
retry_backoff_seconds = [30, 120, 600] # S005 — one entry per retry after the initial attempt
retry_max_attempts = 4                 # S005 — initial attempt + len(retry_backoff_seconds)

[logging]
rotation_max_size_mb = 10    # S008
rotation_max_age_days = 7    # S008
rotation_keep = 5            # S008
```

**Cross-check against the existing plans' hardcoded stand-in constants** (done before writing the
tasks below, so any mismatch would be caught and reconciled rather than silently duplicated):

| `config.toml` key | Plan / constant | Value in that plan | Match? |
|---|---|---|---|
| `search.limit_default` | S002 `DEFAULT_LIMIT` | `20` | Yes |
| `search.limit_max` | S002 `MAX_LIMIT` | `100` | Yes |
| `search.overfetch_multiplier` | S002 `OVERFETCH_MULTIPLIER` | `5` | Yes |
| `search.overfetch_cap` | S002 `OVERFETCH_CAP` | `500` | Yes |
| `search.rrf_k` | S002 `RRF_K` | `60` | Yes |
| `notes.size_drop_threshold` | S003 `SIZE_DROP_THRESHOLD` | `0.5` | Yes |
| `grep.line_match_cap` | S004 `DEFAULT_LINE_MATCH_CAP` | `10` | Yes |
| `index.debounce_ms` | S005 `DEFAULT_DEBOUNCE_MS` | `15000` | Yes |
| `index.model_idle_unload_minutes` | S005 `DEFAULT_IDLE_TIMEOUT_MS` | `10 * 60 * 1000` (10 min) | Yes (unit differs — see below) |
| `index.embedding_dtype` | S005 `DEFAULT_DTYPE` | `'q8'` | Yes |
| `index.retry_backoff_seconds` | S005 `DEFAULT_BACKOFF_SCHEDULE_MS` | `[30000, 120000, 600000]` (ms) | Yes (unit differs — see below) |
| `index.retry_max_attempts` | S005 (`backoffSchedule.length + 1`) | `4` | Yes |
| `logging.rotation_max_size_mb` | S008 `DEFAULT_ROTATION_POLICY.maxSizeBytes` | `10 * 1024 * 1024` (bytes) | Yes (unit differs — see below) |
| `logging.rotation_max_age_days` | S008 `DEFAULT_ROTATION_POLICY.maxAgeMs` | `7 * 24 * 60 * 60 * 1000` (ms) | Yes (unit differs — see below) |
| `logging.rotation_keep` | S008 `DEFAULT_ROTATION_POLICY.keepCount` | `5` | Yes |

No value mismatches found. Four keys store their number in a human-friendlier unit in `config.toml`
(seconds/minutes/MB/days) than the consuming module's internal constant (ms/ms/bytes/ms) — this is
expected and not a bug to fix here: converting a loaded config value into the unit each consuming
module's constant actually uses is that module's own integration work (wiring `config.js` into
`search.js`/`notes.js`/`grep.js`/`daemon.js`/`log-rotator.js` in place of their current hardcoded
defaults), explicitly out of scope for this plan — see Self-Review Notes.

## Global Constraints

- Plain JavaScript, ES modules, no TypeScript, no build step for `src/config.js` (CLAUDE.md).
- `kebab-case` filenames; `camelCase` functions/variables in JS (CLAUDE.md). `config.toml`'s own
  keys are `snake_case` (the on-disk/wire format S009 specifies) and are used as plain object keys
  in `config.js`'s return value verbatim — this file has no CLI/MCP boundary to reshape them at,
  unlike `core/notes.js`/`core/grep.js`, so no camelCase translation happens here.
- Test file colocated: `src/config.js` → `src/config.test.js` (CLAUDE.md).
- Real temp directories/files in every `config.js` test — never mock `node:fs` (CLAUDE.md's
  "real, not mocked" testing philosophy, established in S001 for the DB layer and S008 for the
  logger, applied here to the config file).
- **Fail loudly** (CLAUDE.md): malformed TOML syntax in an existing `config.toml` throws a
  descriptive error naming the file path, never a silent fallback to defaults.
- 4-space indentation, single quotes, trailing commas on multiline, spaced array brackets
  (`[ 'a', 'b' ]`), `func-style: declaration` — matches `eslint.config.js` and every prior plan's
  style, applied to `src/config.js`. Bash scripts follow no such linter (none configured in this
  repo for shell) but use consistent 4-space indentation to match the rest of the codebase's style.
- `config.toml` on disk is a **sparse override file, not a full dump** — `loadConfig` must deep-merge
  nested sections (an override supplying only one key of `[search]` must not blank out the rest of
  that section) and must leave untouched any key the file doesn't mention (S009).
- An array-valued override (e.g. `index.retry_backoff_seconds`) replaces the corresponding default
  array **wholesale** — arrays are never merged element-by-element. This isn't stated explicitly in
  S009 but is the only sane reading of "deep-merge" for a list value; flagged and tested explicitly
  (Task 5) rather than left as an accidental property of the merge implementation.
- **Deviation for Part B** (`scripts/install.sh`, `scripts/uninstall.sh`,
  `launchd/*.plist.template`): no automated tests, no `pnpm vitest run` step — see "Testing note"
  above. Each task instead ends with a **Manual verification checklist** run against a scratch
  `$HOME` (`env HOME=/path/to/scratch ./scripts/install.sh`), plus, for the plist templates,
  `plutil -lint` (a real macOS tool, not a new dependency) to catch XML syntax errors before any
  human ever runs the script.
- `scripts/install.sh` assumes `pnpm install` has already run (S009 states this explicitly) —
  dependency installation itself is out of scope here.

---

## Part A: `src/config.js` (TDD via Vitest)

### Task 1: `buildDefaultConfig()` — the full schema as an in-code default object

**Files:**
- Create: `src/config.js`
- Create: `src/config.test.js`
- Modify: `config.example.toml` (documentation sync — see Step 5 below; not code, no test)

**Interfaces:**
- Produces: `defaultVaultPath() -> string`, `defaultDbPath() -> string`, `buildDefaultConfig() ->
  object` — a fresh object on every call (no shared mutable reference), matching the full schema
  above. Every later task in this plan builds on `buildDefaultConfig()`.

- [ ] **Step 1: Write the failing tests**

Create `src/config.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultConfig, defaultVaultPath, defaultDbPath } from './config.js';

describe('defaultVaultPath / defaultDbPath', () => {
    it('computes vault_path under the current user\'s home directory', () => {
        expect(defaultVaultPath()).toBe(join(homedir(), 'Documents', 'Notes'));
    });

    it('computes db_path under ~/Library/Application Support/mnotes', () => {
        expect(defaultDbPath()).toBe(
            join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db'),
        );
    });
});

describe('buildDefaultConfig', () => {
    it('returns the full schema with computed paths and every documented default value', () => {
        const config = buildDefaultConfig();

        expect(config).toEqual({
            vault_path: defaultVaultPath(),
            db_path: defaultDbPath(),
            embedding_model: 'Qwen3-Embedding-0.6B',
            search: {
                limit_default: 20,
                limit_max: 100,
                overfetch_multiplier: 5,
                overfetch_cap: 500,
                rrf_k: 60,
            },
            notes: {
                size_drop_threshold: 0.50,
            },
            grep: {
                line_match_cap: 10,
            },
            index: {
                debounce_ms: 15000,
                model_idle_unload_minutes: 10,
                embedding_dtype: 'q8',
                retry_backoff_seconds: [ 30, 120, 600 ],
                retry_max_attempts: 4,
            },
            logging: {
                rotation_max_size_mb: 10,
                rotation_max_age_days: 7,
                rotation_keep: 5,
            },
        });
    });

    it('returns a fresh object each call — mutating one result never affects the next', () => {
        const first = buildDefaultConfig();
        first.search.limit_default = 999;
        first.index.retry_backoff_seconds.push(9999);

        const second = buildDefaultConfig();

        expect(second.search.limit_default).toBe(20);
        expect(second.index.retry_backoff_seconds).toEqual([ 30, 120, 600 ]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/config.test.js`
Expected: FAIL — `src/config.js` doesn't exist yet (`Cannot find module './config.js'` or similar).

- [ ] **Step 3: Write minimal implementation**

Create `src/config.js`:

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultVaultPath() {
    return join(homedir(), 'Documents', 'Notes');
}

export function defaultDbPath() {
    return join(homedir(), 'Library', 'Application Support', 'mnotes', 'index.db');
}

export function buildDefaultConfig() {
    return {
        vault_path: defaultVaultPath(),
        db_path: defaultDbPath(),
        embedding_model: 'Qwen3-Embedding-0.6B',
        search: {
            limit_default: 20,
            limit_max: 100,
            overfetch_multiplier: 5,
            overfetch_cap: 500,
            rrf_k: 60,
        },
        notes: {
            size_drop_threshold: 0.50,
        },
        grep: {
            line_match_cap: 10,
        },
        index: {
            debounce_ms: 15000,
            model_idle_unload_minutes: 10,
            embedding_dtype: 'q8',
            retry_backoff_seconds: [ 30, 120, 600 ],
            retry_max_attempts: 4,
        },
        logging: {
            rotation_max_size_mb: 10,
            rotation_max_age_days: 7,
            rotation_keep: 5,
        },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/config.test.js`
Expected: PASS

- [ ] **Step 5: Documentation sync (no test — `config.example.toml` is not code)**

`docs/specs/S009-config-and-install.md` states `config.example.toml` "still documents the full shape
(every key shown, for discoverability)" — the file currently on disk only has the original three
top-level keys (`vault_path`, `db_path`, `embedding_model`) from before this spec collected the rest.
Update `config.example.toml` to the full schema block reproduced at the top of this plan (same
content, `jsmith`-style placeholder paths kept as-is per the file's existing convention — it's
documentation, never the real config, and this plan doesn't change that convention).

- [ ] **Step 6: Commit**

```bash
git add package.json src/config.js src/config.test.js config.example.toml
git commit -m "feat(config): add buildDefaultConfig with full config.toml schema as in-code defaults"
```

---

### Task 2: `defaultConfigPath()`

**Files:**
- Modify: `src/config.js`
- Modify: `src/config.test.js`

**Interfaces:**
- Produces: `defaultConfigPath() -> string` — `~/.config/mnotes/config.toml`, the real path every
  caller outside a test passes to `loadConfig`. Mirrors `src/logger.js`'s `defaultLogDir()` (S008):
  a small function wrapping `homedir()`, not a module-level constant, so it's evaluated fresh per
  call and stays trivially testable.

- [ ] **Step 1: Write the failing test**

Add to `src/config.test.js`:

```js
import { defaultConfigPath } from './config.js';

describe('defaultConfigPath', () => {
    it('points at ~/.config/mnotes/config.toml', () => {
        expect(defaultConfigPath()).toBe(join(homedir(), '.config', 'mnotes', 'config.toml'));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config.test.js`
Expected: FAIL — `defaultConfigPath is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/config.js` — add:

```js
export function defaultConfigPath() {
    return join(homedir(), '.config', 'mnotes', 'config.toml');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): add defaultConfigPath pointing at ~/.config/mnotes/config.toml"
```

---

### Task 3: `loadConfig()` — no file on disk returns defaults untouched

**Files:**
- Modify: `src/config.js`
- Modify: `src/config.test.js`

**Interfaces:**
- Consumes: `buildDefaultConfig`, `defaultConfigPath` from Tasks 1–2.
- Produces: `loadConfig(configPath = defaultConfigPath()) -> object`. This task only implements the
  no-file branch; a non-null but currently-unhandled file throws a placeholder error, filled in by
  Task 4 — mirrors the one-branch-per-task pattern `S001`'s Task 9→10 and `S003`'s Task 3→4 already
  established in this project's plans.

- [ ] **Step 1: Write the failing test**

Add near the top of `src/config.test.js` (new imports and a temp-dir helper):

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { loadConfig } from './config.js';

const tempDirs = [];

function makeTempConfigPath() {
    const dir = mkdtempSync(join(tmpdir(), 'mnotes-config-test-'));
    tempDirs.push(dir);
    return join(dir, 'config.toml');
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});
```

Add a new `describe` block:

```js
describe('loadConfig: no file on disk', () => {
    it('returns the built-in defaults untouched when the config file does not exist', () => {
        const configPath = makeTempConfigPath();

        expect(loadConfig(configPath)).toEqual(buildDefaultConfig());
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config.test.js`
Expected: FAIL — `loadConfig is not a function`.

- [ ] **Step 3: Write minimal implementation**

Update `src/config.js` — add:

```js
import { existsSync } from 'node:fs';

export function loadConfig(configPath = defaultConfigPath()) {
    const defaults = buildDefaultConfig();

    if (!existsSync(configPath)) {
        return defaults;
    }

    throw new Error('loadConfig: reading an existing config.toml file is not yet implemented');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): add loadConfig no-file-on-disk branch"
```

---

### Task 4: `loadConfig()` — sparse top-level override merge

**Files:**
- Modify: `package.json` (add `smol-toml` dependency)
- Modify: `src/config.js`
- Modify: `src/config.test.js`

**Interfaces:**
- Consumes: `existsSync`/`buildDefaultConfig` from Task 3.
- Produces: `loadConfig`'s file-exists branch — parses the file with `smol-toml` and deep-merges the
  result over `buildDefaultConfig()`. This task proves the simplest case (one overridden top-level
  scalar key); nested-section merging is proven explicitly in Task 5.

**Why `smol-toml`:** the installed Node version is 24 (confirmed: `node --version` → `v24.14.0`,
matching S001's `node:sqlite` target); Node core has no built-in TOML parser at this version — unlike
`node:sqlite`, there is no experimental `node:toml` module to reach for, so an npm dependency is
required either way. Between the two candidates considered, `smol-toml` is chosen over `@iarna/toml`:
it's TOML 1.0.0-compliant (the spec's array-of-numbers syntax for `retry_backoff_seconds` is valid
1.0.0 syntax either way, but 1.0.0 compliance is the more future-proof baseline), has zero runtime
dependencies, ships native ESM (matches this repo's `"type": "module"` / no-CommonJS-interop
preference), and is actively maintained. `config.js` only ever *reads* TOML (`install.sh` writes the
sparse override file directly as a bash heredoc/printf, per Task 10 below — never round-tripped
through `smol-toml`'s `stringify`), so parse-side API surface is all that matters here.

- [ ] **Step 1: Add the `smol-toml` dependency**

Run: `pnpm add smol-toml@^1`

- [ ] **Step 2: Write the failing test**

Add to `src/config.test.js` (new import: `import { writeFileSync } from 'node:fs';`):

```js
describe('loadConfig: sparse top-level override', () => {
    it('merges one overridden top-level key over the defaults, leaving the rest untouched', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "/custom/vault/path"\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.vault_path).toBe('/custom/vault/path');
        expect(config.db_path).toBe(buildDefaultConfig().db_path);
        expect(config.embedding_model).toBe('Qwen3-Embedding-0.6B');
        expect(config.search.limit_default).toBe(20);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/config.test.js`
Expected: FAIL — `loadConfig` currently throws `"reading an existing config.toml file is not yet
implemented"` for any existing file.

- [ ] **Step 4: Write minimal implementation**

Update `src/config.js`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

// ... defaultVaultPath, defaultDbPath, buildDefaultConfig, defaultConfigPath unchanged from Tasks 1-2 ...

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
    const merged = { ...base };
    for (const [ key, value ] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(base[key])) {
            merged[key] = deepMerge(base[key], value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

export function loadConfig(configPath = defaultConfigPath()) {
    const defaults = buildDefaultConfig();

    if (!existsSync(configPath)) {
        return defaults;
    }

    const raw = readFileSync(configPath, 'utf8');
    const overrides = parse(raw);

    return deepMerge(defaults, overrides);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/config.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/config.js src/config.test.js
git commit -m "feat(config): merge a sparse top-level config.toml override over the defaults"
```

---

### Task 5: `loadConfig()` — nested section merge, array-wholesale-replace

**Files:**
- Modify: `src/config.test.js`

**Interfaces:**
- Consumes: `deepMerge` from Task 4 — no implementation change expected. This task proves the
  already-general recursive merge correctly handles a partial section override (leaving sibling
  keys in that section at their defaults) and an array-valued override (replaced wholesale, not
  merged element-by-element) — the same "lock in already-general behavior with a dedicated test"
  pattern `S002-search`'s Task 2 and `S005-indexing-daemon`'s Tasks 2/5 already used in this project.

- [ ] **Step 1: Write the failing tests**

Add to `src/config.test.js`:

```js
describe('loadConfig: nested section override', () => {
    it('merges one overridden key within a section, leaving sibling keys at their defaults', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '[search]\nlimit_default = 50\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.search.limit_default).toBe(50);
        expect(config.search.limit_max).toBe(100);
        expect(config.search.rrf_k).toBe(60);
    });

    it('merges overrides across multiple different sections independently', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(
            configPath,
            [ '[notes]', 'size_drop_threshold = 0.75', '', '[index]', 'debounce_ms = 5000' ].join('\n'),
            'utf8',
        );

        const config = loadConfig(configPath);

        expect(config.notes.size_drop_threshold).toBe(0.75);
        expect(config.index.debounce_ms).toBe(5000);
        expect(config.index.model_idle_unload_minutes).toBe(10);
    });

    it('replaces an array value wholesale rather than merging its elements', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '[index]\nretry_backoff_seconds = [10, 20]\n', 'utf8');

        const config = loadConfig(configPath);

        expect(config.index.retry_backoff_seconds).toEqual([ 10, 20 ]);
        expect(config.index.retry_max_attempts).toBe(4);
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/config.test.js`
Expected: PASS — Task 4's `deepMerge` is already generic over nesting depth and already leaves
non-plain-object values (arrays included) as wholesale replacements; this task exists to make both
guarantees explicit, permanent regression tests rather than implicit properties of the merge.

- [ ] **Step 3: Commit**

```bash
git add src/config.test.js
git commit -m "test(config): cover nested-section merge and wholesale array replacement"
```

---

### Task 6: `loadConfig()` — malformed TOML is a hard error; empty file is a no-op

**Files:**
- Modify: `src/config.js`
- Modify: `src/config.test.js`

**Interfaces:**
- Consumes: `parse` (Task 4).
- Produces: a descriptive thrown error (naming the offending file path, not a raw `smol-toml` parser
  error) on invalid TOML syntax — CLAUDE.md's "fail loudly," same shape `S002-search`'s malformed-FTS5
  handling and `S003-notes`'s hash-mismatch errors already use in this project. A zero-byte
  `config.toml` (e.g. `touch`ed but never written to) parses to `{}` and is not an error — it's the
  degenerate case of "no overrides," equivalent to no file at all.

- [ ] **Step 1: Write the failing tests**

Add to `src/config.test.js`:

```js
describe('loadConfig: malformed TOML and empty file', () => {
    it('throws a descriptive error naming the file path for invalid TOML syntax', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, 'vault_path = "unterminated\n', 'utf8');

        expect(() => loadConfig(configPath)).toThrow(new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('returns the defaults for a zero-byte config file, same as no file at all', () => {
        const configPath = makeTempConfigPath();
        writeFileSync(configPath, '', 'utf8');

        expect(loadConfig(configPath)).toEqual(buildDefaultConfig());
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/config.test.js`
Expected: FAIL — the malformed-TOML test fails because `smol-toml`'s raw parser error propagates
unwrapped (its message doesn't necessarily contain the file path); the empty-file test may already
pass (`parse('')` returns `{}`, and `deepMerge(defaults, {})` is a no-op) — run it anyway to confirm
that continues to hold once the `try`/`catch` below is added.

- [ ] **Step 3: Write minimal implementation**

Update `src/config.js` — wrap the parse call:

```js
export function loadConfig(configPath = defaultConfigPath()) {
    const defaults = buildDefaultConfig();

    if (!existsSync(configPath)) {
        return defaults;
    }

    const raw = readFileSync(configPath, 'utf8');

    let overrides;
    try {
        overrides = parse(raw);
    } catch (err) {
        throw new Error(`loadConfig: malformed TOML in "${configPath}": ${err.message}`);
    }

    return deepMerge(defaults, overrides);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/config.test.js`
Expected: PASS (full `config.test.js` suite green)

- [ ] **Step 5: Run the full test suite and lint**

Run: `pnpm vitest run && pnpm lint`
Expected: all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): fail loudly on malformed TOML, treat an empty file as no overrides"
```

---

## Part B: `launchd/*.plist.template`, `scripts/install.sh`, `scripts/uninstall.sh`

Per the Testing note and Global Constraints above, these tasks have no automated test step. Each has
a **Manual verification checklist** instead, run against a scratch `$HOME` where practical. Templates
are built first (Tasks 7–8) since `install.sh`'s plist-rendering step (Task 12) consumes them —
building `install.sh` top-to-bottom before its own dependencies existed would leave an
unverifiable gap, so this plan reorders "install → uninstall → templates" (the order suggested in
this plan's originating brief) to "templates → install → uninstall," matching the actual build
-order dependency. Flagged explicitly in Self-Review Notes as a deliberate deviation from that brief.

**A note on scratch-`$HOME` verification's limits:** steps that only touch `$HOME`-relative
filesystem paths (config, Application Support, Logs, plist *files*) are fully sandboxable by running
a script with `HOME=/tmp/some-scratch-dir` — the real user's actual files are never touched. Steps
that call `launchctl bootstrap`/`bootout gui/$(id -u)` are **not** fully sandboxable this way:
`id -u` resolves to the real logged-in user's UID regardless of the `$HOME` override, so those calls
register/unregister a real LaunchAgent in the real user's `launchd` session even when every path
involved is a scratch directory. The checklists below call this out at the specific steps where it
applies, so verification is done with that caveat understood (e.g. checking `launchctl print` output
immediately followed by a real `bootout` to clean up), rather than silently assumed to be as safe as
the filesystem-only steps.

### Task 7: Indexing daemon LaunchAgent plist template

**Files:**
- Create: `launchd/com.ajmichels.mnotes.plist.template`

**Behavior implemented in this task:** the daemon's LaunchAgent — starts `node
src/indexer/daemon.js` at login (`RunAtLoad`) and restarts it if it ever exits (`KeepAlive`), per the
README's "Process management: launchd (indexing daemon + log-rotation agent)". `__NODE_BIN__`,
`__DAEMON_SCRIPT_PATH__`, and `__LOG_DIR__` are placeholder tokens `install.sh`'s `render_plist`
helper (Task 12) substitutes via `sed` before copying the result into
`~/Library/LaunchAgents/com.ajmichels.mnotes.plist`.

- [ ] **Step 1: Create the template**

Create `launchd/com.ajmichels.mnotes.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ajmichels.mnotes</string>
    <key>ProgramArguments</key>
    <array>
        <string>__NODE_BIN__</string>
        <string>__DAEMON_SCRIPT_PATH__</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>__LOG_DIR__/daemon.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>__LOG_DIR__/daemon.stderr.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `plutil -lint launchd/com.ajmichels.mnotes.plist.template` reports `OK` — the placeholder
    tokens are plain string content, so the file is syntactically valid plist XML even before
    substitution.
  - [ ] Every placeholder used here (`__NODE_BIN__`, `__DAEMON_SCRIPT_PATH__`, `__LOG_DIR__`) has a
    corresponding `sed` substitution in Task 12's `render_plist` — cross-check by eye now, since
    Task 12 hasn't been written yet at this point in the plan.

- [ ] **Step 3: Commit**

```bash
git add launchd/com.ajmichels.mnotes.plist.template
git commit -m "feat(install): add indexing daemon LaunchAgent plist template"
```

---

### Task 8: Log-rotation LaunchAgent plist template

**Files:**
- Create: `launchd/com.ajmichels.mnotes.logrotate.plist.template`

**Behavior implemented in this task:** S008's log-rotation agent — a one-shot script (`node
src/log-rotator.js`, per S008's `main()` entry point), not a long-running process, so no
`KeepAlive`. Runs once at login (`RunAtLoad`) and again at `00:00`/`06:00`/`12:00`/`18:00` daily via
`StartCalendarInterval`, exactly as S009 specifies.

- [ ] **Step 1: Create the template**

Create `launchd/com.ajmichels.mnotes.logrotate.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ajmichels.mnotes.logrotate</string>
    <key>ProgramArguments</key>
    <array>
        <string>__NODE_BIN__</string>
        <string>__LOG_ROTATOR_SCRIPT_PATH__</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Hour</key>
            <integer>0</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>6</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>12</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>18</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
    </array>
    <key>StandardOutPath</key>
    <string>__LOG_DIR__/logrotate.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>__LOG_DIR__/logrotate.stderr.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `plutil -lint launchd/com.ajmichels.mnotes.logrotate.plist.template` reports `OK`.
  - [ ] `Label` (`com.ajmichels.mnotes.logrotate`) is distinct from Task 7's daemon `Label`
    (`com.ajmichels.mnotes`) — two different LaunchAgents must never share a `Label`, or the second
    `launchctl bootstrap` in Task 12 will fail/collide with the first.
  - [ ] No `KeepAlive` key is present — this is a scheduled one-shot script, not a persistent daemon;
    `KeepAlive` here would cause `launchd` to immediately relaunch it in a tight loop after every
    exit, which is not the intended behavior.

- [ ] **Step 3: Commit**

```bash
git add launchd/com.ajmichels.mnotes.logrotate.plist.template
git commit -m "feat(install): add log-rotation LaunchAgent plist template"
```

---

### Task 9: `install.sh` — preflight check, prompts with smart defaults, path resolution (S009 steps 1–2)

**Files:**
- Create: `scripts/install.sh`

**Behavior implemented in this task (S009 "Install" steps 1–2):**
- `which rg`-equivalent preflight check — warns and continues (not a hard blocker) if `rg` is
  missing.
- Prompts for `vault_path`/`db_path`, each showing a computed smart default (`$HOME/Documents/Notes`,
  `$HOME/Library/Application Support/mnotes/index.db` — the same values `defaultVaultPath()`/
  `defaultDbPath()` compute in `src/config.js`, kept in sync by both sides deriving from `$HOME`/
  `homedir()` rather than a literal string baked into two places).
- Resolves whatever the user typed (bare Enter, a `~`-relative path, or a relative path) to an
  absolute path — `~` expanded against `$HOME`, relative paths resolved via Node's `path.resolve()`
  (shelling a one-line `node -e` out rather than hand-rolling path-resolution edge cases in bash).

- [ ] **Step 1: Create the script**

Create `scripts/install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"

DEFAULT_VAULT_PATH="$HOME/Documents/Notes"
DEFAULT_DB_PATH="$HOME/Library/Application Support/mnotes/index.db"

# --- Step 1: preflight check -------------------------------------------------

if ! command -v rg >/dev/null 2>&1; then
    echo "WARNING: ripgrep not found — install via \`brew install ripgrep\` before using \`mnotes grep\`."
fi

# --- Step 2: prompt for vault_path / db_path, resolve to absolute paths -----

resolve_path() {
    local raw="$1"
    case "$raw" in
        "~"*) raw="$HOME${raw#\~}" ;;
    esac
    "$NODE_BIN" -e 'console.log(require("node:path").resolve(process.argv[1]))' "$raw"
}

read -r -p "Vault path [$DEFAULT_VAULT_PATH]: " vault_path_input
vault_path_input="${vault_path_input:-$DEFAULT_VAULT_PATH}"
vault_path="$(resolve_path "$vault_path_input")"

read -r -p "Index DB path [$DEFAULT_DB_PATH]: " db_path_input
db_path_input="${db_path_input:-$DEFAULT_DB_PATH}"
db_path="$(resolve_path "$db_path_input")"

echo "Resolved vault_path: $vault_path"
echo "Resolved db_path: $db_path"
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `chmod +x scripts/install.sh`, then `HOME=/tmp/mnotes-install-scratch ./scripts/install.sh`
    (create the scratch dir first) — pressing Enter at both prompts prints
    `Resolved vault_path: /tmp/mnotes-install-scratch/Documents/Notes` and
    `Resolved db_path: /tmp/mnotes-install-scratch/Library/Application Support/mnotes/index.db`.
  - [ ] Re-run, this time entering `~/custom-vault` at the first prompt — confirm the resolved value
    is `/tmp/mnotes-install-scratch/custom-vault` (the `~` expanded against the scratch `$HOME`, not
    the real one).
  - [ ] Re-run, entering a bare relative path (`my-notes`) — confirm it resolves to an absolute path
    under the script's current working directory, not left as a relative string.
  - [ ] Temporarily prepend an empty directory to `PATH` (e.g.
    `PATH=/tmp/empty-dir ./scripts/install.sh`, with `/tmp/empty-dir` created and containing no
    binaries) — confirm the `ripgrep not found` warning prints and the script continues past it
    rather than exiting (this will fail at `command -v node` too in that fully-empty-PATH case, so
    verify the `rg` warning specifically by instead removing only `rg` from a PATH copy, or by
    temporarily renaming a local `rg` shim — whichever is more convenient in the environment at hand).

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(install): add preflight rg check and vault/db path prompts"
```

---

### Task 10: `install.sh` — sparse config file creation (S009 step 3)

**Files:**
- Modify: `scripts/install.sh`

**Behavior implemented in this task (S009 "Install" step 3):** creates `~/.config/mnotes/config.toml`
**only if** it doesn't already exist **and** at least one of `vault_path`/`db_path` differs from its
suggested default — and if written, it contains **only** the overridden keys, never a full dump. An
already-existing `config.toml` is always left completely untouched (checked first, before any diffing
logic runs at all).

- [ ] **Step 1: Update the script**

Update `scripts/install.sh` — add after the path-resolution block from Task 9 (remove the two
`echo "Resolved ..."` debug lines added in Task 9, since their job is now done by real step 3 logic):

```bash
CONFIG_DIR="$HOME/.config/mnotes"
CONFIG_PATH="$CONFIG_DIR/config.toml"

# --- Step 3: create config.toml only if missing AND something differs -------

escape_toml_string() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ -e "$CONFIG_PATH" ]; then
    echo "Config file already exists at $CONFIG_PATH — leaving it untouched."
else
    overrides=""
    if [ "$vault_path" != "$DEFAULT_VAULT_PATH" ]; then
        overrides="${overrides}vault_path = \"$(escape_toml_string "$vault_path")\"\n"
    fi
    if [ "$db_path" != "$DEFAULT_DB_PATH" ]; then
        overrides="${overrides}db_path = \"$(escape_toml_string "$db_path")\"\n"
    fi

    if [ -n "$overrides" ]; then
        mkdir -p "$CONFIG_DIR"
        printf '%b' "$overrides" > "$CONFIG_PATH"
        echo "Wrote $CONFIG_PATH with the overridden default(s)."
    else
        echo "All defaults accepted — no config.toml written."
    fi
fi
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `HOME=/tmp/mnotes-install-scratch ./scripts/install.sh`, accepting both defaults (bare
    Enter twice) — confirm `/tmp/mnotes-install-scratch/.config/mnotes/config.toml` was **not**
    created, and the "All defaults accepted" message printed.
  - [ ] Reset the scratch `$HOME` (`rm -rf /tmp/mnotes-install-scratch`, recreate it), re-run
    entering a custom vault path only (db path defaulted) — confirm `config.toml` was created
    containing **only** a `vault_path = "..."` line, no `db_path` line and no `[search]`/etc.
    sections.
  - [ ] Without resetting, run `./scripts/install.sh` again (same scratch `$HOME`, custom values
    this time at both prompts) — confirm the existing `config.toml`'s content is byte-identical
    before and after (the "already exists — leaving it untouched" message printed, no overwrite).
  - [ ] Confirm a vault path containing a double quote or backslash (contrived, e.g.
    `/tmp/mnotes-install-scratch/weird"vault`) is written with the quote/backslash properly escaped
    — `config.toml` remains valid TOML (spot-check by running `node -e "require('smol-toml').parse(require('fs').readFileSync(process.argv[1],'utf8'))"` against it once Task 4's dependency is installed).

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(install): write a sparse config.toml only when a default is overridden"
```

---

### Task 11: `install.sh` — Application Support and Logs directories (S009 steps 4–5)

**Files:**
- Modify: `scripts/install.sh`

**Behavior implemented in this task (S009 "Install" steps 4–5):** creates
`~/Library/Application Support/mnotes/` (holds `index.db` and the S005 `daemon.sock` — schema
creation is the daemon's own job at startup, never duplicated here) and
`~/Library/Logs/com.ajmichels.mnotes/` (holds the three S008 log files plus this plist's own
`StandardOutPath`/`StandardErrorPath` targets from Tasks 7–8).

- [ ] **Step 1: Update the script**

Update `scripts/install.sh` — add after Task 10's config-file block:

```bash
APP_SUPPORT_DIR="$HOME/Library/Application Support/mnotes"
LOG_DIR="$HOME/Library/Logs/com.ajmichels.mnotes"

# --- Step 4: Application Support directory -----------------------------------

mkdir -p "$APP_SUPPORT_DIR"

# --- Step 5: Logs directory ---------------------------------------------------

mkdir -p "$LOG_DIR"
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `HOME=/tmp/mnotes-install-scratch ./scripts/install.sh` — confirm
    `/tmp/mnotes-install-scratch/Library/Application Support/mnotes/` and
    `/tmp/mnotes-install-scratch/Library/Logs/com.ajmichels.mnotes/` both exist afterward and are
    empty (no `index.db` — this script never creates it, per S009 step 4's explicit note that the
    daemon owns schema creation).
  - [ ] Run the script a second time against the same scratch `$HOME` — confirm no error from
    `mkdir -p` against already-existing directories (idempotent).

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(install): create Application Support and Logs directories"
```

---

### Task 12: `install.sh` — render both plists from templates, bootstrap both jobs (S009 steps 6–7)

**Files:**
- Modify: `scripts/install.sh`

**Behavior implemented in this task (S009 "Install" steps 6–7):** substitutes the placeholder tokens
in both `launchd/*.plist.template` files (Tasks 7–8) via `sed`, writes the results into
`~/Library/LaunchAgents/`, then runs `launchctl bootstrap gui/$(id -u) <plist>` for each — the daemon
first, then the log-rotation agent.

- [ ] **Step 1: Update the script**

Update `scripts/install.sh` — add after Task 11's directory-creation block:

```bash
DAEMON_SCRIPT="$REPO_ROOT/src/indexer/daemon.js"
LOG_ROTATOR_SCRIPT="$REPO_ROOT/src/log-rotator.js"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DAEMON_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.plist"
LOGROTATE_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.logrotate.plist"

# --- Step 6: render both plists from templates --------------------------------

render_plist() {
    local template="$1" dest="$2"
    sed \
        -e "s#__NODE_BIN__#$NODE_BIN#g" \
        -e "s#__DAEMON_SCRIPT_PATH__#$DAEMON_SCRIPT#g" \
        -e "s#__LOG_ROTATOR_SCRIPT_PATH__#$LOG_ROTATOR_SCRIPT#g" \
        -e "s#__LOG_DIR__#$LOG_DIR#g" \
        "$template" > "$dest"
}

mkdir -p "$LAUNCH_AGENTS_DIR"
render_plist "$REPO_ROOT/launchd/com.ajmichels.mnotes.plist.template" "$DAEMON_PLIST"
render_plist "$REPO_ROOT/launchd/com.ajmichels.mnotes.logrotate.plist.template" "$LOGROTATE_PLIST"

# --- Step 7: bootstrap both launchd jobs --------------------------------------

launchctl bootstrap "gui/$(id -u)" "$DAEMON_PLIST"
launchctl bootstrap "gui/$(id -u)" "$LOGROTATE_PLIST"
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `HOME=/tmp/mnotes-install-scratch ./scripts/install.sh` — confirm both
    `/tmp/mnotes-install-scratch/Library/LaunchAgents/com.ajmichels.mnotes.plist` and
    `...logrotate.plist` exist, contain no leftover `__TOKEN__` placeholders (`grep -c '__' <file>`
    returns `0` for both), and `plutil -lint` reports `OK` on both rendered files.
  - [ ] **Caveat (see Part B's intro note):** the `launchctl bootstrap` calls affect the *real*
    logged-in user's `launchd` session regardless of the scratch `$HOME` (`gui/$(id -u)` doesn't
    change). Verify with `launchctl print "gui/$(id -u)/com.ajmichels.mnotes"` and
    `launchctl print "gui/$(id -u)/com.ajmichels.mnotes.logrotate"` (both should show as loaded),
    then immediately clean up with `launchctl bootout "gui/$(id -u)" /tmp/mnotes-install-scratch/Library/LaunchAgents/com.ajmichels.mnotes.plist`
    (and the logrotate equivalent) so the scratch run doesn't leave a real daemon pointed at a
    scratch vault running in the background.
  - [ ] Confirm the two `Label`s in the bootstrapped jobs are distinct (Task 8's checklist already
    called this out at the template level; re-confirm here that `render_plist` didn't accidentally
    collapse them).

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(install): render both LaunchAgent plists and bootstrap them"
```

---

### Task 13: `install.sh` — embedding model pre-download warm-up (S009 step 8)

**Files:**
- Modify: `scripts/install.sh`

**Behavior implemented in this task (S009 "Install" step 8):** the final install step — a one-line
pipeline warm-up call against `src/indexer/embed.js`'s `embed()` (S005), triggering
`@huggingface/transformers`' download-and-cache of the configured (`q8`) model, with a visible
progress message so this multi-minute download happens during install rather than stalling the
daemon's first real indexing pass.

- [ ] **Step 1: Update the script**

Update `scripts/install.sh` — add after Task 12's bootstrap block:

```bash
# --- Step 8: pre-download the embedding model ---------------------------------

echo "downloading embedding model, this may take a minute..."
"$NODE_BIN" -e "
import('$REPO_ROOT/src/indexer/embed.js').then((m) => m.embed('warm-up')).then(() => {
    console.log('embedding model ready.');
});
"

echo "mnotes install complete."
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] With `src/indexer/embed.js` implemented (S005) and dependencies installed, run
    `HOME=/tmp/mnotes-install-scratch ./scripts/install.sh` end to end — confirm the "downloading
    embedding model..." message prints before the call blocks, and "embedding model ready."/"mnotes
    install complete." print afterward (first run may take a minute or more on a clean model cache;
    subsequent runs against the same machine reuse the cache and complete quickly since
    `@huggingface/transformers` caches by model ID regardless of which script triggered the
    download).
  - [ ] Run the full script once more against a **fresh** scratch `$HOME` end-to-end (config prompts
    through model warm-up) and confirm every step from Tasks 9–13 completes without manual
    intervention beyond the two prompts.
  - [ ] `shellcheck scripts/install.sh` if `shellcheck` happens to be available locally (not a new
    project dependency — purely an optional extra check, matching this plan's "no new bash tooling
    without asking" posture; skip this bullet entirely if `shellcheck` isn't already on the machine).

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(install): pre-download the embedding model as the final install step"
```

---

### Task 14: `uninstall.sh` — bootout both jobs, delete both plists (S009 steps 1–2)

**Files:**
- Create: `scripts/uninstall.sh`

**Behavior implemented in this task (S009 "Uninstall" steps 1–2):** the reverse of Task 12 —
`launchctl bootout` both jobs (tolerating "not currently loaded," since uninstall must be safe to run
even if install was only partially completed or the daemon had already crashed out) before deleting
both plist files.

- [ ] **Step 1: Create the script**

Create `scripts/uninstall.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DAEMON_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.plist"
LOGROTATE_PLIST="$LAUNCH_AGENTS_DIR/com.ajmichels.mnotes.logrotate.plist"

# --- Step 1: bootout both launchd jobs ---------------------------------------

launchctl bootout "gui/$(id -u)" "$DAEMON_PLIST" 2>/dev/null || true
launchctl bootout "gui/$(id -u)" "$LOGROTATE_PLIST" 2>/dev/null || true

# --- Step 2: delete both plist files -----------------------------------------

rm -f "$DAEMON_PLIST" "$LOGROTATE_PLIST"
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] `chmod +x scripts/uninstall.sh`, then run `HOME=/tmp/mnotes-install-scratch
    ./scripts/uninstall.sh` against the scratch `$HOME` left over from Task 12/13's checklists —
    confirm both plist files under `/tmp/mnotes-install-scratch/Library/LaunchAgents/` are gone
    afterward.
  - [ ] **Caveat (same as Task 12):** the `bootout` calls target the real `gui/$(id -u)` session.
    Run install (Task 9–13's script) once against the scratch `$HOME` to get a real job bootstrapped,
    then run `./scripts/uninstall.sh` with that same scratch `$HOME` and confirm
    `launchctl print "gui/$(id -u)/com.ajmichels.mnotes"` now reports "could not find service" (i.e.
    genuinely booted out), not still loaded.
  - [ ] Run `./scripts/uninstall.sh` a **second** time immediately after — confirm it exits `0`
    (not an error) even though both jobs are already booted out and both plists already deleted, via
    the `|| true` guards and `rm -f`'s missing-file tolerance. This is the "safe to run repeatedly"
    property CLAUDE.md's idempotency framing (stated there for `notes reindex`, applied here to
    `uninstall.sh` by the same reasoning) implies for any script that undoes install's side effects.

- [ ] **Step 3: Commit**

```bash
git add scripts/uninstall.sh
git commit -m "feat(uninstall): bootout both launchd jobs and delete their plists"
```

---

### Task 15: `uninstall.sh` — delete Logs, Application Support, and Config directories (S009 steps 3–5)

**Files:**
- Modify: `scripts/uninstall.sh`

**Behavior implemented in this task (S009 "Uninstall" steps 3–5):** unconditionally deletes
`~/Library/Logs/com.ajmichels.mnotes/`, `~/Library/Application Support/mnotes/` (the SQLite index and
socket — safe per S001, a pure derived cache a future reinstall's daemon rebuilds from the vault), and
`~/.config/mnotes/` (any hand-written `config.toml`). **Never touches the vault** — no vault-relative
path appears anywhere in this script.

- [ ] **Step 1: Update the script**

Update `scripts/uninstall.sh` — add after Task 14's plist-deletion block:

```bash
APP_SUPPORT_DIR="$HOME/Library/Application Support/mnotes"
LOG_DIR="$HOME/Library/Logs/com.ajmichels.mnotes"
CONFIG_DIR="$HOME/.config/mnotes"

# --- Step 3: delete Logs directory --------------------------------------------

rm -rf "$LOG_DIR"

# --- Step 4: delete Application Support directory -----------------------------

rm -rf "$APP_SUPPORT_DIR"

# --- Step 5: delete Configuration directory -----------------------------------

rm -rf "$CONFIG_DIR"

echo "mnotes uninstall complete. The vault itself was not touched."
```

- [ ] **Step 2: Manual verification checklist**

  - [ ] Run install (Tasks 9–13) against a fresh scratch `$HOME`, confirm `Library/Logs/...`,
    `Library/Application Support/mnotes/`, and `.config/mnotes/` all exist under it, then run
    `./scripts/uninstall.sh` with the same `$HOME` — confirm all three are gone and the "vault itself
    was not touched" message printed.
  - [ ] Set a scratch vault directory with a placeholder file inside it (e.g.
    `mkdir -p /tmp/mnotes-install-scratch/Documents/Notes && echo test >
    /tmp/mnotes-install-scratch/Documents/Notes/Placeholder.md`) before running uninstall — confirm
    that file still exists afterward (uninstall never deletes anything under `vault_path`).
  - [ ] Run `./scripts/uninstall.sh` a second time immediately after — confirm it exits `0` (`rm -rf`
    against already-missing directories is a no-op, not an error).
  - [ ] Run the full test suite and lint one more time for the repo as a whole (`pnpm vitest run &&
    pnpm lint`) to confirm nothing in Part A regressed while Part B was being written.

- [ ] **Step 3: Commit**

```bash
git add scripts/uninstall.sh
git commit -m "feat(uninstall): delete Logs, Application Support, and Config directories"
```

---

## Self-Review Notes

- **Spec coverage**: every value in S009's `config.toml` schema has a dedicated default in
  `buildDefaultConfig()` and a passing test (Task 1); the sparse-override, deep-merge-not-replace,
  create-only-if-something-differs, never-touch-an-existing-file, and array-wholesale-replace
  behaviors S009 specifies are each covered by a task and test (Tasks 3–6, 10). Both LaunchAgents
  (daemon + S008's log-rotation agent), all eight numbered install steps, and all five numbered
  uninstall steps have a dedicated task with a manual verification checklist (Tasks 7–15).
- **Config value cross-check performed up front**: the table near the top of this plan verifies every
  `config.toml` key against the hardcoded stand-in constant the corresponding S002/S003/S004/S005/S008
  plan already introduced. All twelve tunables match in value; four differ only in *unit*
  (`retry_backoff_seconds` seconds vs. `DEFAULT_BACKOFF_SCHEDULE_MS` milliseconds;
  `model_idle_unload_minutes` minutes vs. `DEFAULT_IDLE_TIMEOUT_MS` milliseconds;
  `rotation_max_size_mb` megabytes vs. `maxSizeBytes` bytes; `rotation_max_age_days` days vs.
  `maxAgeMs` milliseconds) — expected, since `config.toml` is meant to be human-editable and those are
  the natural units for a person to type, while the consuming module's internal constant is in
  whatever unit its own arithmetic wants. No mismatch requiring reconciliation was found.
- **Explicitly out of scope here** (this plan does not touch any of the following):
  - **Wiring `loadConfig()`'s result into `search.js`/`notes.js`/`grep.js`/`daemon.js`/
    `log-rotator.js` in place of their current hardcoded `DEFAULT_*` constants** — each of those
    plans already flagged its constant as "config.toml value pending S009" and takes the tunable as
    an overridable default parameter, so swapping the call site to read from `loadConfig()` (including
    the unit conversions noted above) is a small, mechanical follow-up in each of those files, not an
    architecture change — but it's a distinct, separate change touching five other files, not part of
    building `config.js`/`install.sh`/`uninstall.sh`/the plist templates themselves.
  - **Exact plist XML beyond what S005 (daemon behavior) and S008 (log-rotation schedule) specify** —
    e.g. this plan's choice to add `StandardOutPath`/`StandardErrorPath` pointing at
    `daemon.stdout.log`/`daemon.stderr.log`/`logrotate.stdout.log`/`logrotate.stderr.log` (distinct
    from S008's own `indexer.log`/`mcp-server.log`/`audit.log`, which are the *application-level*
    pino logs, not `launchd`'s own stdout/stderr capture) is a reasonable, common `launchd` pattern
    for catching anything a crash prints before the logger itself is initialized, but isn't spelled
    out in either spec — flagged as a judgment call, not a requirement.
  - **`pnpm install` / dependency management itself** — S009 states `install.sh` assumes it already
    ran; this plan doesn't touch `package.json` scripts or add any install-time `pnpm` invocation.
  - **A bash test framework** (`bats` or otherwise) — see the Testing note and Global Constraints
    above; noted as an option to raise with AJ, not adopted.
- **Design decisions made here that the spec leaves implicit** (flagged for AJ's confirmation before/
  during implementation, mirroring the pattern `S003-notes`'s plan used for its own Architecture
  section):
  1. **`vault_path`/`db_path` defaults are computed functions (`defaultVaultPath()`/
     `defaultDbPath()`), not literal strings baked into `buildDefaultConfig()`.** S009's schema block
     shows a literal AJ-specific path (`/Users/aj/Documents/Notes`); this plan reads that as the
     *example* value shown for a schema that's actually machine-relative (README: "Each machine gets
     its own vault, its own index, and its own config"), computed from `os.homedir()` at call time —
     the same pattern `S008-logging`'s `defaultLogDir()` already established for exactly this reason.
     This keeps `install.sh`'s prompt defaults and `config.js`'s built-in defaults from being able to
     drift apart, since both ultimately derive from `$HOME`/`homedir()`.
  2. **`smol-toml` chosen over `@iarna/toml`** for TOML 1.0.0 compliance, zero dependencies, native
     ESM, and active maintenance — justified in Task 4. Confirmed there is no Node-core built-in TOML
     parser at the installed Node version (v24.14.0) to reach for instead, unlike `node:sqlite`.
  3. **`smol-toml`'s exact export name (`parse`) is assumed, not verified against the installed
     package version** during this planning pass — flagged the same way `S003-notes`'s plan flagged
     `gray-matter`'s API surface and `S005-indexing-daemon`'s plan flagged
     `@huggingface/transformers`'s tokenizer/pipeline API surface: Task 4's failing test is exactly
     where a naming mismatch would surface immediately, not silently.
  4. **`install.sh` writes the sparse `config.toml` override directly via bash string
     interpolation** (with minimal quote/backslash escaping), rather than shelling out to
     `smol-toml`'s `stringify` from Node. Justified because the only values ever written this way are
     `vault_path`/`db_path` — two flat top-level string keys, never a nested section — so a full TOML
     serializer is unneeded machinery for what's actually two `printf` lines; flagged as a scope-
     limiting judgment call, not an oversight.
  5. **Templates → install → uninstall task ordering**, not the "install → uninstall → templates"
     order suggested in this plan's originating brief — reordered because `install.sh`'s
     plist-rendering task (Task 12) has a hard dependency on the template files existing (Tasks 7–8),
     matching every other plan's precedent of building dependencies before their consumers (e.g.
     `S001`'s FK-dependency table-creation order).
- **Placeholder scan**: no TODOs/TBDs; every task has complete, runnable code (JS or bash) or a
  complete XML plist. Task 3's "reading an existing config.toml file is not yet implemented" stub is
  explicitly closed out by Task 4, mirroring the same one-branch-per-task pattern `S001`'s Task 9→10
  and `S003`'s Task 3→4 already established.
- **Type/signature consistency**: `buildDefaultConfig() -> object` (Task 1) and
  `loadConfig(configPath = defaultConfigPath()) -> object` (Tasks 3–6) never change shape across the
  tasks that touch them — `loadConfig`'s return value is always a full, schema-shaped object (fully
  merged), never a partial/sparse one, matching how every consumer (a future `cli/`/`mcp/` wiring
  step) would expect to read it. `install.sh`/`uninstall.sh` each grow monotonically across their
  tasks (later tasks append a new numbered-step section; no earlier section is rewritten or
  reordered), so the "Update the script" instruction in each task is always additive against the
  previous task's end state.
