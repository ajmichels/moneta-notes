Read `README.md` first for the full architecture and tool specs — this file is about *how* to build
it, not *what* to build.

## `docs/specs/` vs. `docs/plans/`

- **`docs/specs/S0xx-*.md` are living documentation.** They're the contract for what each subsystem
  does and *why* — update them in place as behavior changes (don't leave them describing stale
  behavior, and don't fork a new spec number for a change to something already specified).
- **`docs/plans/S0xx-*.md` are disposable.** They're step-by-step execution checklists written for
  agentic implementation of a spec, not a reference anyone should need afterward — any rationale
  worth keeping belongs in the corresponding spec, not the plan. Checkbox state in these files isn't
  reliably maintained during implementation, so don't use it to judge completion — verify against the
  actual repo (does the code exist, does it match the spec, do the tests pass) instead.
- **Once a plan's spec is implemented and verified, delete the plan file.** Keeping it around past
  that point only invites drift between plan and reality.

## Language & Runtime

- **Plain JavaScript. No TypeScript.** No `tsc`, no `.ts`/`.d.ts` files, no build step for the JS
  code. Entry points run directly with `node`.
- **ES modules** (`"type": "module"` in `package.json`, `import`/`export` syntax).
- **No Python anywhere in this repo.** Embeddings run entirely in Node via
  `@huggingface/transformers` (Transformers.js), using the `onnx-community/Qwen3-Embedding-0.6B-ONNX`
  model. There is no sidecar process, no second language runtime, no IPC to a Python process —
  `src/indexer/embed.js` runs the `feature-extraction` pipeline directly in-process. If a task seems
  to need Python for anything, stop and check with AJ rather than assume — this has been explicitly
  decided against.

## Testing

- Use test driven development when writing/editing code
- **Vitest.** Test files are **colocated** with the code they test: `src/core/search.js` →
  `src/core/search.test.js`, in the same directory. Do not create a separate `test/` directory.
- Unit-test `core/` directly — that's the whole point of keeping it free of CLI/MCP concerns. Don't
  write tests that require spinning up the MCP server or shelling out to the CLI to exercise core
  logic.
- Prefer a real temp SQLite DB (in-memory or tmpdir) over mocking the database layer for anything
  touching `core/db.js` or `core/search.js` — this is a thin system where the SQL/FTS5/sqlite-vec
  behavior itself is what's worth testing.

## Linting

- **ESLint.** Use it to catch real bugs and enforce consistency (unused vars, no-undef,
  consistent-return, etc.), not as a style-formatting tool. If AJ wants stricter formatting
  enforcement (Prettier or ESLint stylistic rules) later, that's a separate decision — don't add it
  unprompted.

## Naming Conventions (JavaScript)

Standard JS conventions — `camelCase` for variables and functions, `PascalCase` for classes,
`kebab-case` for filenames (`note-writer.js`, not `noteWriter.js` or `note_writer.js`). Note this is
distinct from **note titles**, which follow Obsidian's Title Case wikilink convention and are a
separate namespace entirely (vault content, not code).

## Architecture Rules — do not violate

- **`core/` knows nothing about CLI flags, MCP tool schemas, or output formatting.** It takes plain
  JS arguments, returns plain JS data (objects/arrays), and throws on error. All formatting
  (pipe-delimited text vs. JSON) and protocol plumbing happens in `cli/` and `mcp/`.
- **`cli/` and `mcp/` must not duplicate logic.** If you find yourself writing the same conditional
  or query in both, it belongs in `core/`.
- **Note title is the identifier, never the raw file path**, across every tool-facing surface. Path
  resolution from title happens inside `core/`.
- **Every mutating operation on an existing note requires a matching content hash.** No hash +
  existing title is an error (not a silent overwrite), directing the caller to read first. Don't
  "helpfully" relax this even for internal/CLI-only code paths — the whole point is that notes can
  change outside of any given session.
- **Metadata is always a structured object at the API boundary**, never raw YAML string
  manipulation. Frontmatter parsing/serialization is a `core/` concern.
- **Fail loudly.** Prefer throwing a specific, descriptive error over returning a partial or
  best-effort result. This applies to hash mismatches, ambiguous `note_edit` matches (zero or
  multiple), size-drop guard trips, and index/vault inconsistencies.
- **Don't show raw RRF/BM25/cosine scores anywhere in tool output** — rank position only.
- **Don't add MCP resources.** This was deliberately decided against; if it comes up again, that's a
  discussion to have with AJ, not a default to reach for.
- **Every MCP tool takes a required `reason<string>` argument**, mirroring `description` on Claude
  Code's native `view`/`create_file`/`str_replace` tools. It gets logged, not used to gate behavior —
  don't build conditional logic keyed on its contents beyond that.
- **`notes reindex` must be idempotent.** Running it twice with no intervening vault changes should
  leave the index in the same state both times — no double-inserted FTS rows, no duplicate vectors.
  This matters because it's meant to be safe to run ad hoc (after a bulk file operation, or just out
  of caution) without reasoning about current index state first.

## Logging

- Use a shared logger module (`src/logger.js`) rather than ad hoc `console.log` scattered through
  `core/`, `indexer/`, and `mcp/` — every log line should carry a consistent shape (timestamp,
  component, level, message) regardless of which part of the system emitted it.
- Log destination and rotation strategy are proposed in README.md but not finalized — don't hardcode
  assumptions about the logging library beyond what's there without checking in.
- Never log full note content. Tool-call logging captures `tool`, `note_title`, `reason`,
  `timestamp`, and outcome — not the note body or diff.

## Git

- This repo is committed normally, by hand. `gitwatch` is a separate tool that runs against the
  **notes vault**, not against this codebase — don't confuse the two or wire any auto-commit behavior
  into this repo's own tooling.

## When something's ambiguous

This project has a lot of already-settled architecture (see README). If a task seems to require a
new architectural decision rather than an implementation of something already specified, stop and
ask rather than picking a default — AJ uses these sessions to validate and extend specific
decisions, not to have direction generated from scratch.
