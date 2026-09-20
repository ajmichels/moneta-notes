# Plan — Multi-vault support (S001/S005/S006/S007/S008/S009/S013/S014)

Execution checklist for the multi-vault feature (issue #10), whose config/install shape is owned by
[S009](../specs/S009-config-and-install.md) — the other specs listed above are amended by it. Disposable
— delete this file once implemented and verified against those specs; don't trust checkbox state,
verify against the repo. Rationale lives in the specs, not here. Follow CLAUDE.md's TDD convention
throughout: write/extend the colocated `*.test.js` first for each step, watch it fail, then implement.

Build bottom-up: config resolution (1) has to exist before the daemon (2) or CLI/MCP (3-5) can use it.

## 1. `src/config.js` — vault resolution, defaults, backward compatibility

- [ ] Add `slugifyVaultName(pathString)`: lowercase, non-alphanumeric runs → single `-`, trim leading/
      trailing `-`. Unit-test directly: `~/Documents/Notes` basename `Notes` → `notes`;
      `~/Documents/D&D` basename `D&D` → `d-d`.
- [ ] Add `VAULT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/` and a small `assertValidVaultName(name)`
      throwing a specific error naming the bad key — called from both `loadConfig`'s normalization
      below and anywhere a name is read off `config.vaults`.
- [ ] `buildDefaultConfig()`: replace `vault_path`/`db_path` top-level keys with
      `vaults: { notes: { path: defaultVaultPath() } }` (no `db_path` key — derived, see next bullet)
      and no `default_vault` key.
- [ ] Add `defaultDbPathForVault(name)` → `join(appSupportDir(), \`index-${name}.db\`)`; keep
      `defaultDbPath()` only if still referenced elsewhere (check call sites before deleting — likely
      only the old single-vault default, which this replaces).
- [ ] `loadConfig(configPath)`: after parsing TOML overrides, before `deepMerge`, add a normalization
      step:
  - If `overrides.vault_path` is present and `overrides.vaults` is **also** present → throw
    (`"config.toml mixes the legacy vault_path key with [vaults.*] — remove one"`).
  - If `overrides.vault_path` is present and no `overrides.vaults` → synthesize
    `overrides.vaults = { [slugifyVaultName(overrides.vault_path)]: { path: overrides.vault_path,
    ...(overrides.db_path ? { db_path: overrides.db_path } : {}) } }`, then delete
    `overrides.vault_path`/`overrides.db_path` so `findUnrecognizedKeys` doesn't flag them (they're
    intentionally not part of the schema `deepMerge` expects, once normalized).
  - Validate every key in `overrides.vaults` (if present) against `assertValidVaultName`.
  - If `merged.default_vault` is set, assert it names a key actually in `merged.vaults` (fail loud on
    a stale/typo'd `default_vault`) — this stays a load-time check, since it's a pure internal-
    consistency check independent of any call. **Do not** add a load-time check for "2+ vaults, no
    `default_vault`" — that shape is valid on its own; see `resolveVault` below for where that error
    actually belongs.
- [ ] Add `resolveVault(config, name = null)` → `{ name, path, dbPath, description }`:
  - `name` given → assert it's a key in `config.vaults`, else throw naming every configured vault.
  - `name` omitted → `config.default_vault` if set, else the sole key of `config.vaults` if there's
    exactly one, else throw (`"multiple vaults configured (<list>) — pass --vault/vault explicitly or
    set default_vault"`) — **this is the one and only place that error is thrown**, at call time, not
    at `loadConfig()` time.
  - Resolve `path` to absolute (already absolute by the time it's in `config.vaults`, per install/
    normalization — assert, don't re-resolve).
  - `dbPath` = `config.vaults[name].db_path ?? defaultDbPathForVault(name)`.
- [ ] Add `listVaults(config)` → `[{ name, description: string|null, isDefault: bool }]`, sorted by
      name — used by both `mnotes vaults` (S006) and the `list_vaults` MCP tool (S007). **No `path`
      field** — deliberately, per S007.
- [ ] Add `resolveVaultsForQuery(config, name = null)` → `{ vaults: VaultDescriptor[] }` — backs the
      fan-out behavior for `search`/`grep`/`tag_notes`/`metadata_query`/`links broken` (S006/S007/S009's
      "Cross-vault fan-out" section):
  - `name` given → `{ vaults: [resolveVault(config, name)] }` (same hard error on an unknown name).
  - `name` omitted, exactly one vault configured → `{ vaults: [resolveVault(config, null)] }` —
    identical to today's single-vault path; `default_vault` plays no special role here since there's
    only one possible answer either way.
  - `name` omitted, 2+ vaults configured → `{ vaults: listVaults(config).map(v => resolveVault(config,
    v.name)) }` — **every** configured vault, in `listVaults`'s name-sorted order, regardless of
    whether `default_vault` is set. This is the one case where `resolveVault(config, null)`'s own
    "ambiguous, no default" error is deliberately bypassed — fan-out doesn't need a single answer.
- [ ] `config.test.js`: cover every branch above —
  - legacy flat config (no `vaults`) → `resolveVault(config)` returns the slugified single vault with
    the *exact* pre-existing `db_path` if one was set, or the derived default otherwise;
    `resolveVaultsForQuery(config)` returns that same one-element array.
  - single `[vaults.x]`, no `default_vault` → `resolveVault` resolves to `x` with no error.
  - two vaults, `default_vault` set to one of them → `resolveVault` resolves correctly; explicit
    `name` argument overrides it; `resolveVaultsForQuery(config)` (name omitted) still returns **both**
    vaults, not just the default one.
  - two vaults, no `default_vault` → `loadConfig` does **not** throw; `resolveVault(config, null)`
    throws only when actually called; `resolveVaultsForQuery(config, null)` does not throw and returns
    both vaults.
  - explicit unknown vault name → both `resolveVault` and `resolveVaultsForQuery` throw naming the
    configured vaults.
  - invalid vault name (`"My Vault"`, `"1abc"`, `"abc def"`) → throws from both the config-load path
    and a direct `assertValidVaultName` call.
  - mixed legacy + `[vaults.*]` → throws.
  - `listVaults` omits `path`, includes `isDefault` correctly for both the explicit-default and
    sole-vault-default cases.

## 2. `src/indexer/daemon.js` — multi-vault daemon

- [ ] `startDaemon(options)`: change shape — accept `vaults: [{ name, vaultRoot, dbPath }]` (already
      resolved) instead of singular `vaultRoot`/`dbPath`. For each vault entry, run today's per-vault
      startup sequence independently: `openDb(dbPath)`, `loadIgnoreMatcher(vaultRoot)`,
      `watermarkCatchup`/`existenceCheck`/`ignoredPathsCheck` (skipped on rebuild per existing logic,
      now per-vault), its own `createWatcher(...)`, its own `createSerialGate()`, its own drain loop
      (`startDrainLoop`). Collect these into a `vaultsByName` map (`{ [name]: { db, vaultRoot, deps,
      watcher, gate, drainTimer } }`) closed over by the IPC handler and `stop()`.
  - Keep `embed`/`embedQuery`/`chunkText` resolution (the shared pipeline bits) computed **once**,
    outside the per-vault loop, and passed into every vault's `deps`.
  - `acquireLock`/`releaseLock` stay singular, called once for the whole process — unchanged.
  - `stop()` now tears down every vault's watcher/drainTimer, then closes every vault's `db`, then the
    (single) `ipcServer`, then releases the lock.
- [ ] `handleIpcRequest`: resolve `request.vault` via `resolveVault`-equivalent lookup against
      `vaultsByName` (a plain lookup, config-level validation already happened at daemon startup, but
      an unknown name in a request is still a runtime error to return over the socket) before dispatching
      `embed`/`reindex` — `embed` ignores the resolved vault (shared pipeline, per S005) but still
      validates the name for consistency/future-proofing; `reindex` uses the resolved vault's `db`,
      `vaultRoot`, `deps` (including that vault's own `gate`).
- [ ] `main()`: `loadConfig()` → for each `listVaults(config)` entry, `resolveVault(config, name)`,
      build the `vaults` array `startDaemon` now expects.
- [ ] Every `getContextLogger()` call site in this file (watermark catch-up, existence check,
      ignored-paths check, fswatch watcher started/exited/failed, symlink registered/removed, queue
      drain per-path lines, reindex requested/complete, IPC path-not-resolved) gains `vault: name` in
      its context object — a small threading change, not new logic, since each of these already runs
      inside a per-vault closure once the loop above exists. Embedding pipeline load/unload logging
      stays vault-less (shared, process-wide).
- [ ] `daemon.test.js`: extend/add cases — two vaults configured, each gets its own watcher/queue/db;
      an IPC reindex against one vault doesn't touch the other's `index_queue`; an unknown `vault` name
      over IPC returns `{ error }` without crashing the daemon; a permanent `fswatch` failure in one
      vault's watcher doesn't affect the other's. Existing single-vault tests should still pass with a
      one-entry `vaults` array (confirms this isn't a breaking behavior change for the common case).

## 3. `src/cli/main.js` — `--vault`, `mnotes vaults`

- [ ] Remove `resolveVaultRoot`/`resolveDbPath` (no longer meaningful as standalone singular
      resolvers) — replace every call site with `resolveVault(config, vaultFlag)`.
- [ ] `buildRealDeps()`: stop resolving `vaultRoot`/`dbPath`/opening `db` once at startup for every
      command. Instead, pass `config` through and let each command handler resolve its own vault from
      its own parsed `--vault` value, then open that vault's `db` itself (mirroring how `mcp/tools.js`
      already opens a fresh `db` per call via `withDb`). Check whether this changes `reindex`/`stats`/
      `daemon`'s existing dep shape (`cli/reindex.js`, `cli/stats.js`, `cli/daemon.js`) — thread `--vault`
      into `reindex`/`stats` (they need a resolved vault's `dbPath`/`vaultRoot`/`socketPath` unchanged),
      leave `daemon` alone (no vault concept, per S006).
- [ ] Add `--vault` to every vault-scoped command's `parseArgs` options, split by resolution group
      (S006/S009):
  - **Group 1 (single-vault-target)** — `read`, `write`, `edit`, `append`, `rename`,
    `attachment read`/`write`, `links <title>`, `reindex`, `stats`, `tags list`, `metadata keys`.
    Resolve once per handler via `resolveVault(config, values.vault ?? null)`, pass the resulting
    `vaultRoot`/`dbPath` (open a fresh `db` from `dbPath`) into the existing `core/` call, replacing
    whatever `deps.vaultRoot`/`deps.db` it used before. Unchanged from the original single-group plan.
  - **Group 2 (fan-out)** — `search`, `grep`, `tags notes`, `metadata query`, `links broken`. Resolve
    via `resolveVaultsForQuery(config, values.vault ?? null)`, then **loop**: for each returned vault,
    open its `db`, call the exact same `core/` function with the exact same options, then — only if
    `vaults.length > 1` — map `vault: name` onto every returned row before concatenating (no `vault`
    key at all when there's exactly one resolved vault, preserving today's exact output shape for that
    case). `search` additionally: apply `--limit` per vault (not split across vaults), and group blocks
    in `resolveVaultsForQuery`'s vault order rather than attempting to re-sort across vaults (S009 —
    no cross-vault score/rank comparison). A per-vault target-scoping failure (e.g. `grep --note=<title>`
    unresolvable in one particular vault) contributes zero rows from that vault rather than aborting
    the whole call; an explicit single-vault `--vault` still hard-errors on it as before.
  - `format.js`: `formatSearchTable`, `formatGrepTable`, `formatTagNotesTable`, and whatever formats
    `metadata query`/`links broken` use need a `vault` column added to their row-shaping, present only
    when the row actually carries the key — same convention `readonly` (S015) already uses.
  - `--explain` under fan-out (S006): print each vault's own summary-line-then-table block in sequence
    (labeled with the vault name), not a merged summary — implement as a loop around the existing
    single-vault `--explain` rendering, one call per resolved vault.
- [ ] Add `runVaults(args, deps)`: `parseArgs` for `--json` only, call `listVaults(resolveConfig(deps))`,
      format via a new `formatVaultsTable`/reuse `formatJson` — `registerCommand('vaults', runVaults)`.
      Add `vaults` to `TOP_LEVEL_HELP` and `COMMAND_USAGE`.
- [ ] `mnotes logs --vault=<name>`: add to `cli/logs.js`'s audit-only flag set and filter predicate
      (alongside `--source`/`--tool`/`--note`/`--outcome`), rejected on non-`audit` `--file` same as the
      others (S006). **This is a plain equality filter, not a call to `resolveVault`** — do not give it
      the default-vault-fallback treatment step 3's other `--vault` flags get: omitted, it must show
      every vault's entries unfiltered; an unrecognized name is not an error, it's a filter matching
      zero rows (S006). Also: the audit-line parser's field list gains `vault`; `formatLogsTable`/
      `formatLogRow` (default table + `--follow` streaming) gain a `vault` column; NDJSON `--json` mode
      includes `vault` per entry, `null` when absent (list_vaults tool calls only). An entry with no
      `vault` field never matches a `--vault` filter, regardless of value.
- [ ] `format.js`: add `formatVaultsTable(vaults, { align })` — columns `name | description | default`
      (blank cells for unset description / non-default), following the existing `formatTagListTable`
      shape.
- [ ] Update every `logAudit(...)` call site (`write`/`edit`/`append`/`rename`/`attachment write`) to
      include `vault: resolvedVault.name`.
- [ ] `cli/main.test.js`: `--vault` resolves correctly and is passed through for a representative
      command per group (one read command, one write command, `reindex`, `stats`); an unknown `--vault`
      surfaces as `mnotes: <message>` on stderr with exit code 1; `mnotes vaults`/`--json` output;
      `mnotes vaults --vault=x` is simply ignored/not offered (no flag registered — confirm it errors
      as an unrecognized flag, matching `parseArgs`'s default behavior, rather than silently accepted).
      `mnotes logs --vault=x --file=indexer` still rejects per the existing audit-only-flag rule.

## 4. `src/mcp/tools.js` / `src/mcp/server.js` — `vault` argument, `list_vaults`

- [ ] `server.js`: `createServer`/`main()` stop resolving a single `vaultRoot`/`dbPath` once — pass
      `config` through in `deps` instead (already partially true; confirm `assertSchemaCurrent` now
      needs to run once per configured vault's `dbPath`, not just the default's, so a stale schema in
      a non-default vault is still caught at startup — loop `listVaults(config)` there).
- [ ] Add `list_vaults` to `TOOL_DEFS`: `inputSchema: { reason: z.string() }`, `annotations: {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true }`, `handler: listVaultsTool`.
- [ ] Add `vault: z.string().optional()` to every other tool's `inputSchema`.
- [ ] `tools.js`: split tool handlers into the same two resolution groups as step 3, matching S007's
      grouping:
  - **Group 1** — `note_read`, `note_write`, `note_edit`, `note_append`, `note_rename`,
    `attachment_read`, `attachment_write`, `tag_list`, `metadata_keys`. Add a small
    `resolveToolVault(deps, input)` helper — `resolveVault(deps.config, input.vault ?? null)` — called
    at the top of each handler in place of destructuring `deps.vaultRoot`/`deps.dbPath` directly.
  - **Group 2** — `search`, `grep`, `tag_notes`, `metadata_query`. Add a `resolveToolVaults(deps,
    input)` helper — `resolveVaultsForQuery(deps.config, input.vault ?? null)` — then loop the same way
    step 3's group 2 does: call the existing `core/` function once per resolved vault, map `vault: name`
    onto every row only when more than one vault was resolved, concatenate. `search` groups blocks by
    vault (`resolveVaultsForQuery`'s order) with `limit` applied per vault, never a cross-vault merged
    ranking (S009).
- [ ] Add `listVaultsTool(deps, input)`: `callTool(..., 'list_vaults', input, async () =>
      formatVaultsTable(listVaults(resolveConfig(deps))))` — reuse the CLI's `formatVaultsTable`
      from `src/format.js` (already shared cross-surface per S006/S007's existing pattern for every
      other list tool).
- [ ] `callTool`: add `vault` to both the error and success `logAudit` calls — for group 1, the single
      resolved vault's name (or `null` if resolution itself failed, since there's nothing else to log it
      under); for group 2 under fan-out, there's no single vault to log — use `null` (or a
      comma-joined list of every vault touched, if that reads better in `audit.log`; decide against a
      real fan-out call before committing to one, this is presentation-layer, not load-bearing).
- [ ] `tools.test.js` / `server.test.js`: `vault` argument threads through to the right `dbPath` for a
      representative read tool and a representative write tool; `list_vaults` output shape and
      annotations; an unresolvable `vault` argument produces `isError: true` with the exact
      `resolveVault`/`resolveVaultsForQuery` message, and an `audit.log` entry with `outcome: error`;
      a fan-out tool (e.g. `search`) with `vault` omitted against a 2-vault test config returns rows
      from both, each carrying `vault`, grouped by vault; the same call against a 1-vault test config
      returns rows with no `vault` key at all (shape-unchanged assertion).

## 5. `src/core/metadata.js` tools (S014) — no core change, wiring only

- [ ] Confirm `metadataKeysTool` (group 1, step 4's `resolveToolVault`) and `metadataQueryTool` (group
      2, step 4's `resolveToolVaults`/fan-out loop), and `cli/main.js`'s `runMetadataKeys` (group 1)/
      `runMetadataQuery` (group 2, step 3's fan-out loop) are wired into the correct group each —
      `metadata_query` fans out, `metadata_keys` does not (S014 amendment: separate vocabularies per
      vault, same reasoning as `tag_list`). `core/metadata.js` itself needs no change, it already takes
      `db`/`vaultRoot` as plain args.

## 6. `src/cli/vectors.js` (S013) — `--vault`

- [ ] Add `--vault <name>` to `runVectorsCommand`'s top-level flag parsing (before dispatching to a
      subcommand), resolve via `resolveVault(config, name)`, open that vault's `db`, pass it through to
      whichever `core/vectors.js` function the subcommand calls — same pattern as step 3.
- [ ] `cli/vectors.test.js`: one representative subcommand (e.g. `nearest`) resolves `--vault`
      correctly; an unknown `--vault` errors the same way other commands do.

## 7. `src/logger.js` — audit shape

- [ ] `logAudit`'s accepted fields gain `vault` (nullable — absent for `list_vaults`), rendered via the
      existing trailing-context `key=value` grammar with the same null-omission rule already governing
      `reason`/`error_message`.
- [ ] `logger.test.js`: a `vault` field renders correctly; omitted `vault` produces no `vault=` token
      (matches existing null-omission tests for other fields).

## 8. `scripts/install.sh` / `scripts/lib/common.sh` — vault prompts

- [ ] `common.sh`: replace the single vault-path/db-path prompt block with: path prompt (unchanged
      default), name prompt (default = slugified path, re-prompt with the specific validation message
      on a name matching neither the slugify pattern nor `VAULT_NAME_PATTERN`), description prompt
      (optional, blank default), db-path prompt (default now `<app-support-dir>/index-<name>.db`).
- [ ] `common.sh`'s config-writing step: always emit `default_vault = "<name>"` plus `[vaults.<name>]`
      with `path` (and `db_path`/`description` only if they differ from their suggested defaults) —
      even when every prompt was accepted as-is (this is the one case where S009's "no file at all if
      everything's default" rule from before this feature no longer applies, since `default_vault` must
      always be written per the spec's step-3 rule — confirm this against S009's exact wording before
      implementing, it's a deliberate behavior change from the pre-multi-vault install flow).
- [ ] Bash test/manual check: fresh install with every default accepted still writes a minimal
      `config.toml` containing just `default_vault`/`[vaults.notes].path` (not a full dump); a custom
      name/description round-trips correctly; re-running install against an existing `config.toml`
      changes nothing.

## 9. Docs (per CLAUDE.md's doc-sync rule — same change, not a follow-up)

- [ ] `docs/configuration.md`: document the new `[vaults.<name>]`/`default_vault` shape, the legacy
      flat-key backward-compat behavior, and vault-name validation rules — this is the schema's primary
      user-facing home per the README's docs table.
- [ ] `docs/installation.md`: update the install-prompt walkthrough (vault path/name/description/db
      path, four prompts now instead of two) and mention adding a second vault is a manual config edit.
- [ ] `docs/usage.md`: `--vault` flag on every relevant command, new `mnotes vaults` command, `mnotes
      logs --vault`, and the fan-out behavior for `search`/`grep`/`tags notes`/`metadata query`/
      `links broken` when `--vault` is omitted with 2+ vaults configured (distinct from every other
      command's default-vault-fallback behavior).
- [ ] `docs/usage-mcp.md`: `vault` argument on every relevant tool, new `list_vaults` tool, and the same
      fan-out note for `search`/`grep`/`tag_notes`/`metadata_query` — including the "carry a fanned-out
      result's `vault` into any follow-up tool call" guidance from S007's `search`/`note_read` sections.
- [ ] `docs/usage-vectors.md`: `--vault` flag.
- [ ] `docs/process-management.md`: confirm no change needed (still one daemon process/service
      regardless of vault count) — check for any singular-vault-log-path assumption in its `indexer.log`
      description and update if the multi-vault `vault=` context field is worth mentioning there.
- [ ] `README.md`: spot-check the tool/command tables for anything still implying a single vault beyond
      the architecture line already fixed during spec drafting.

## 10. Verify end-to-end

- [ ] `pnpm lint && pnpm test` clean.
- [ ] Manual smoke test: configure two vaults by hand in `config.toml` (one via install, one
      hand-added), restart the daemon, confirm both get independent `fswatch` watchers and DBs
      (`indexer.log` shows two `vault=` values); `mnotes vaults` and the MCP `list_vaults` tool list
      both with no `path` leaked; a write/note-read/reindex against each `--vault`/`vault` stays isolated
      from the other; **note this two-vault config deliberately has no `default_vault` set** — confirm
      `mnotes search`/`mnotes grep` with no `--vault` return results from *both* vaults grouped by vault
      (not an error), while `mnotes read`/`mnotes stats`/`mnotes tags list` with no `--vault` correctly
      error naming both configured vaults (no default to fall back to); setting `default_vault` afterward
      makes those single-vault-target commands work again with no flag, while search/grep's fan-out
      behavior is unaffected either way; a legacy single-vault config from before this change still
      starts and resolves correctly with zero edits, and produces zero `vault` fields/columns anywhere.
- [ ] Delete this plan file once the above is verified.
