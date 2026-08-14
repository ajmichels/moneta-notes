# Architecture

`core/` has zero knowledge of CLI flags or MCP tool schemas — it takes plain arguments and returns
plain data. `cli/main.js` and `mcp/server.js` each do their own argument parsing / protocol plumbing
and then call the same functions underneath. This guarantees the two surfaces can never drift out of
sync.

Plain JS, no build step — `node src/indexer/daemon.js` runs directly, no `tsc`, no `dist/`.

## Directory layout

```
moneta-notes/
├── docs/
│   ├── specs/          # binding functional specs — see README's Specs table
│   └── *.md             # user-facing guides (installation, usage, ...)
├── src/
│   ├── config.js        # loads ~/.config/mnotes/config.toml — S009
│   ├── logger.js         # shared logger — S008
│   ├── log-rotator.js    # log rotation, run by its own LaunchAgent — S008
│   ├── core/              # shared library: db, search, notes, grep, tags, links
│   ├── indexer/           # daemon.js (fswatch loop, IPC socket), embed.js
│   ├── cli/                # mnotes command surface — S006
│   └── mcp/                 # MCP server, tool defs, prompts — S007
├── launchd/              # plist templates, native launcher — S009
└── scripts/              # install.sh, uninstall.sh — S009
```

Test files live next to the code they test (`src/core/search.js` / `src/core/search.test.js`), not
in a separate `test/` tree.

## Tech stack

| Concern            | Choice |
|--------------------|--------|
| Language           | Node.js, plain JavaScript (no TypeScript) — no Python anywhere in this repo |
| Search index       | SQLite — FTS5 (BM25, contentless) + sqlite-vec |
| Hybrid ranking     | Reciprocal Rank Fusion, k=60 (config-backed) |
| Embeddings         | Qwen3-Embedding-0.6B via `@huggingface/transformers` (ONNX, q8, in-process Node) |
| Chunking           | Token-based, ~512 tokens / ~15% overlap |
| File watching      | fswatch, unified per-path debounce |
| Indexing queue     | SQLite-backed (`index_queue`), retry with backoff |
| CLI↔daemon IPC     | Unix domain socket |
| Process management | launchd (indexing daemon + log-rotation agent) |
| Grep               | ripgrep (system-installed) |
| Logging            | Hand-rolled plain-text logger (`src/logger.js`), rotation via a dedicated LaunchAgent — see [S008](specs/S008-logging.md) |
| Versioning         | gitwatch — vault only, not this repo; see [Note Versioning](note-versioning.md) |
| CLI parsing        | Node's built-in `util.parseArgs` |
| Package manager    | pnpm |
| Testing            | Vitest, colocated `*.test.js` files |
| Linting            | ESLint |
| Git hooks          | Husky — lint on commit, tests on push, commitlint + DCO sign-off on commit message |

## Development

- **Install deps**: `pnpm install`
- **Run tests**: `pnpm test` (Vitest, run mode; omit `run` for watch mode: `pnpm test -- --watch`)
- **Lint**: `pnpm lint` (ESLint — bug/consistency rules, not a formatter; see CLAUDE.md)

Husky hooks (`.husky/`) enforce these automatically:

| Hook | Runs |
|---|---|
| `pre-commit` | `pnpm lint` |
| `commit-msg` | `pnpm commitlint --edit` — Conventional Commits, per `commitlint.config.js` |
| `pre-push` | `pnpm test run` — the full Vitest suite |
| `post-checkout` / `post-merge` | `nvm use` — keeps the Node version pinned per `.nvmrc` |
