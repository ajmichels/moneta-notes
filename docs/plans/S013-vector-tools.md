# Execution plan — S013 Vector Tools

Disposable checklist, not a reference — see CLAUDE.md. Delete once S013 is implemented and verified.

1. **Deps**: add `ml-kmeans`, `ml-hclust`, `density-clustering`, `ml-pca`, `umap-js` to `package.json`,
   `pnpm install`.
2. **Core infra** (`src/core/vectors.js` + `vectors.test.js`): `cosineSimilarity`, `vectorToBuffer`/
   `bufferToVector`, `getChunkVectors`, `getAllChunkVectors`, `getNoteVector` (centroid),
   `resolveScopeNoteIds` (tag/folder). Add `[vectors]` config section (`config.js`,
   `configuration.md`). Commit.
3. **`compare`**: `compareVectors` (core) + `runVectorsCompare` (cli) + format + usage.md. Commit.
4. **`nearest`**: `nearestNeighbors` (core) + cli + format + usage.md. Commit.
5. **`cluster`**: `clusterVectors` (kmeans/hierarchical/dbscan via new deps) + cli + format +
   usage.md. Commit.
6. **`reduce`**: `reduceVectors` (pca/umap) + cli (stdout-default CSV/JSON, `--output`) + usage.md.
   Commit.
7. **`tag-fit`**: `tagFit` (core, shared tag-centroid helper) + cli + format + usage.md. Commit.
8. **`tag-redundancy`**: `tagRedundancy` (core, reuses tag-centroid helper) + cli + format +
   usage.md. Commit.
9. **`outliers`**: `findOutliers` (isolated/bridge) + cli + format + usage.md. Commit.
10. **`calibrate`**: `calibrate` (core, link-graph sampling) + cli + format + usage.md. Commit.
11. Wire `vectors` into `cli/main.js` dispatch table/help/usage incrementally as each subcommand
    lands (not a separate step).
12. Full `pnpm test` + `pnpm lint` pass before each commit.
