import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import {
    compareVectors, nearestNeighbors, clusterVectors, reduceVectors, tagFit, tagRedundancy,
    findOutliers, calibrate,
} from '../core/vectors.js';
import {
    formatCompareResult, formatNearestTable, formatClusterTable, formatReduceCsv,
    formatTagFitTable, formatTagRedundancyTable, formatOutliersTable, formatCalibrateTable, formatJson,
} from '../format.js';
import { resolveConfig } from '../config.js';

// Detects an explicitly-passed `--name`/`--name=value` flag, as opposed to a parseArgs default —
// needed for the flag-combination usage errors below (e.g. "--aggregate is not valid with
// --level chunk"), which must only fire when the caller actually typed the flag.
function hasFlag(args, name) {
    return args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function embeddingOptions(deps) {
    return { embeddingModel: deps.embeddingModel, embeddingVersion: deps.embeddingVersion };
}

async function runCompare(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            level: { type: 'string', default: 'note' },
            aggregate: { type: 'string', default: 'centroid' },
            json: { type: 'boolean', default: false },
        },
    });
    const [ a, b ] = positionals;

    if (values.level === 'chunk' && hasFlag(args, 'aggregate')) {
        throw new Error('mnotes vectors compare: --aggregate is not valid with --level chunk');
    }

    const result = compareVectors(deps.db, a, b, {
        level: values.level, aggregate: values.aggregate, ...embeddingOptions(deps),
    });

    return {
        stdout: formatCompareResult(result, { aggregate: values.aggregate, json: values.json }),
        stderr: '',
        exitCode: 0,
    };
}

const NEAREST_AGGREGATES = [ 'centroid', 'best-chunk' ];

function validateNearestFlags(args, values) {
    if (values.level === 'chunk' && hasFlag(args, 'aggregate')) {
        throw new Error('mnotes vectors nearest: --aggregate is not valid with --level chunk');
    }
    if (!NEAREST_AGGREGATES.includes(values.aggregate)) {
        throw new Error(`mnotes vectors nearest: --aggregate must be one of ${NEAREST_AGGREGATES.join('|')}`);
    }
}

async function runNearest(args, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            level: { type: 'string', default: 'note' },
            against: { type: 'string' },
            aggregate: { type: 'string', default: 'centroid' },
            k: { type: 'string' },
            score: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    });
    const [ query ] = positionals;
    validateNearestFlags(args, values);

    const { vectors: vectorsConfig } = resolveConfig(deps);
    const k = values.k !== undefined ? Number(values.k) : vectorsConfig.nearest_k_default;

    const against = values.against ?? values.level;
    const results = nearestNeighbors(deps.db, query, {
        level: values.level,
        against,
        aggregate: values.aggregate,
        k,
        ...embeddingOptions(deps),
    });

    if (values.json) {
        return { stdout: formatJson(results), stderr: '', exitCode: 0 };
    }
    return { stdout: formatNearestTable(results, { against, score: values.score }), stderr: '', exitCode: 0 };
}

function toFloatOrUndefined(raw) {
    return raw !== undefined ? Number(raw) : undefined;
}

function toIntOrUndefined(raw) {
    return raw !== undefined ? parseInt(raw, 10) : undefined;
}

async function runCluster(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            level: { type: 'string', default: 'note' },
            algo: { type: 'string' },
            k: { type: 'string' },
            'cut-height': { type: 'string' },
            epsilon: { type: 'string' },
            'min-points': { type: 'string' },
            tag: { type: 'string' },
            folder: { type: 'string' },
            format: { type: 'string', default: 'table' },
        },
    });

    if (!values.algo) {
        throw new Error('mnotes vectors cluster: --algo is required (kmeans|hierarchical|dbscan)');
    }

    const { membership, clusters } = clusterVectors(deps.db, {
        level: values.level,
        algo: values.algo,
        k: toIntOrUndefined(values.k),
        cutHeight: toFloatOrUndefined(values['cut-height']),
        epsilon: toFloatOrUndefined(values.epsilon),
        minPoints: toIntOrUndefined(values['min-points']),
        tag: values.tag,
        folder: values.folder,
        ...embeddingOptions(deps),
    });

    if (values.format === 'json') {
        return { stdout: formatJson(membership), stderr: '', exitCode: 0 };
    }
    return { stdout: formatClusterTable(clusters), stderr: '', exitCode: 0 };
}

function readClustersFile(path) {
    if (path === undefined) {
        return null;
    }
    return JSON.parse(readFileSync(path, 'utf8'));
}

function validateReduceFlags(args, values) {
    if (values.algo === 'pca' && (hasFlag(args, 'neighbors') || hasFlag(args, 'min-dist'))) {
        throw new Error('mnotes vectors reduce: --neighbors/--min-dist are not valid with --algo pca');
    }
    if (![ '2', '3' ].includes(values.dims)) {
        throw new Error('mnotes vectors reduce: --dims must be 2 or 3');
    }
    if (![ 'csv', 'json' ].includes(values.format)) {
        throw new Error('mnotes vectors reduce: --format must be csv or json');
    }
}

async function runReduce(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            level: { type: 'string', default: 'note' },
            algo: { type: 'string' },
            dims: { type: 'string', default: '2' },
            neighbors: { type: 'string' },
            'min-dist': { type: 'string' },
            tag: { type: 'string' },
            folder: { type: 'string' },
            'color-by': { type: 'string', default: 'none' },
            clusters: { type: 'string' },
            output: { type: 'string' },
            format: { type: 'string', default: 'csv' },
        },
    });

    if (!values.algo) {
        throw new Error('mnotes vectors reduce: --algo is required (pca|umap)');
    }
    validateReduceFlags(args, values);

    const { points, metadata } = reduceVectors(deps.db, {
        level: values.level,
        algo: values.algo,
        dims: Number(values.dims),
        neighbors: toIntOrUndefined(values.neighbors),
        minDist: toFloatOrUndefined(values['min-dist']),
        tag: values.tag,
        folder: values.folder,
        colorBy: values['color-by'],
        clusters: readClustersFile(values.clusters),
        ...embeddingOptions(deps),
    });

    const body = values.format === 'json'
        ? formatJson({ points, metadata })
        : formatReduceCsv(points, { level: values.level });

    if (values.output !== undefined) {
        writeFileSync(values.output, body);
        return { stdout: `wrote ${points.length} points to ${values.output}\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: body, stderr: '', exitCode: 0 };
}

async function runTagFit(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            tag: { type: 'string' },
            threshold: { type: 'string' },
            format: { type: 'string', default: 'table' },
        },
    });

    const rows = tagFit(deps.db, {
        tag: values.tag, threshold: toFloatOrUndefined(values.threshold), ...embeddingOptions(deps),
    });

    if (values.format === 'json') {
        return { stdout: formatJson(rows), stderr: '', exitCode: 0 };
    }
    return { stdout: formatTagFitTable(rows), stderr: '', exitCode: 0 };
}

async function runTagRedundancy(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            threshold: { type: 'string' },
            format: { type: 'string', default: 'table' },
        },
    });

    const rows = tagRedundancy(deps.db, {
        threshold: toFloatOrUndefined(values.threshold), ...embeddingOptions(deps),
    });

    if (values.format === 'json') {
        return { stdout: formatJson(rows), stderr: '', exitCode: 0 };
    }
    return { stdout: formatTagRedundancyTable(rows), stderr: '', exitCode: 0 };
}

function validateOutliersFlags(args, values) {
    if (!values.mode) {
        throw new Error('mnotes vectors outliers: --mode is required (isolated|bridge)');
    }
    if (values.mode === 'isolated' && hasFlag(args, 'threshold') && hasFlag(args, 'top')) {
        throw new Error('mnotes vectors outliers: --threshold and --top are mutually exclusive');
    }
    if (values.mode === 'bridge' && hasFlag(args, 'threshold')) {
        throw new Error('mnotes vectors outliers: --threshold is not valid with --mode bridge');
    }
}

async function runOutliers(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            level: { type: 'string', default: 'note' },
            mode: { type: 'string' },
            threshold: { type: 'string' },
            top: { type: 'string' },
            clusters: { type: 'string' },
            format: { type: 'string', default: 'table' },
        },
    });
    validateOutliersFlags(args, values);

    const rows = findOutliers(deps.db, {
        level: values.level,
        mode: values.mode,
        threshold: toFloatOrUndefined(values.threshold),
        top: toIntOrUndefined(values.top),
        clusters: readClustersFile(values.clusters),
        ...embeddingOptions(deps),
    });

    if (values.format === 'json') {
        return { stdout: formatJson(rows), stderr: '', exitCode: 0 };
    }
    return { stdout: formatOutliersTable(rows, { mode: values.mode }), stderr: '', exitCode: 0 };
}

async function runCalibrate(args, deps) {
    const { values } = parseArgs({
        args,
        options: {
            level: { type: 'string', default: 'note' },
            'sample-size': { type: 'string' },
            format: { type: 'string', default: 'table' },
        },
    });

    const { vectors: vectorsConfig } = resolveConfig(deps);
    const sampleSize = values['sample-size'] !== undefined
        ? Number(values['sample-size'])
        : vectorsConfig.calibrate_sample_size;

    const result = calibrate(deps.db, { level: values.level, sampleSize, ...embeddingOptions(deps) });

    if (values.format === 'json') {
        return { stdout: formatJson(result), stderr: '', exitCode: 0 };
    }
    return { stdout: formatCalibrateTable(result), stderr: '', exitCode: 0 };
}

const VECTORS_SUBCOMMANDS = {
    compare: runCompare,
    nearest: runNearest,
    cluster: runCluster,
    reduce: runReduce,
    'tag-fit': runTagFit,
    'tag-redundancy': runTagRedundancy,
    outliers: runOutliers,
    calibrate: runCalibrate,
};

const VECTORS_OVERVIEW_HELP = `Usage: mnotes vectors <subcommand> [flags]

CLI-only debug/analysis tooling over the raw embedding space (S013) — no MCP equivalent,
same rationale as \`mnotes links\`. All read-only.

Subcommands:
  compare           Direct pairwise similarity between two notes or two chunks
  nearest           Nearest neighbors of an existing note's/chunk's own embedding
  cluster           Whole-vault (or scoped) grouping via kmeans/hierarchical/dbscan
  reduce            Dimensionality reduction (PCA/UMAP) for visualization
  tag-fit           How well each note fits the centroid of its tag(s)
  tag-redundancy    Pairwise tag-centroid comparison to flag likely-duplicate tags
  outliers          Isolated notes, or notes bridging two clusters
  calibrate         Empirical similarity thresholds from the vault's link graph

Run 'mnotes vectors <subcommand> --help' for full flag documentation on any of these.
`;

const VECTORS_HELP = {
    compare: `Usage: mnotes vectors compare <a> <b> [flags]

Direct pairwise similarity between two notes or two chunks, using each one's own stored
embedding — no query text is embedded. This is the primitive the other vectors
subcommands' "how close are these two things" logic reduces to.

Arguments:
  <a> <b>
      Note titles (--level=note, the default) or chunk ids (--level=chunk). Note
      titles resolve the same way \`mnotes read\`'s <title> does: an exact match first,
      then a unique-basename fallback.

Flags:
  --level=note|chunk
      Granularity to compare at. Default: note.

  --aggregate=centroid|best-chunk|all-pairs
      Note-level only — a usage error combined with --level=chunk. Default: centroid.
        centroid    Compare each note's single collapsed (mean, re-normalized) chunk
                    vector.
        best-chunk  Compare every chunk in <a> against every chunk in <b> and keep
                    the closest pair; output includes which chunk pair won (their
                    line spans).
        all-pairs   Return the full chunks_a x chunks_b similarity matrix. Always
                    JSON, regardless of --json.

  --json
      Print structured JSON instead of a plain "similarity: N" line.

Examples:
  mnotes vectors compare "Weekly Notes/2026-W32" "Weekly Notes/2026-W33"
  mnotes vectors compare "Note A" "Note B" --aggregate=best-chunk
  mnotes vectors compare "Note A" "Note B" --aggregate=all-pairs
  mnotes vectors compare 42 108 --level=chunk
`,

    nearest: `Usage: mnotes vectors nearest <note-title|chunk-id> [flags]

Nearest-neighbor lookup using an existing note's or chunk's own stored embedding as the
query — distinct from \`mnotes search --mode=semantic\`, which re-embeds typed query text.
The query itself is always excluded from its own results.

Arguments:
  <note-title|chunk-id>
      A note title (--level=note, the default) or a raw chunk id (--level=chunk).
      Note titles resolve like \`mnotes read\`'s <title> does (exact match, then
      unique-basename fallback).

Flags:
  --level=note|chunk
      Query-side granularity: is the argument a note or a chunk id? Default: note.

  --against=note|chunk
      Corpus-side granularity — what to search. Default: matches --level. Set
      independently to ask e.g. "which chunks are nearest this note's centroid"
      (--level=note --against=chunk).

  --aggregate=centroid|best-chunk
      Query-side aggregation, note-level queries only — a usage error combined with
      --level=chunk. Default: centroid.
        centroid    Collapse the query note to one centroid vector.
        best-chunk  Keep every one of the query note's chunk vectors; each candidate
                    is scored by its single best match against any of them (mirrors
                    compare's best-chunk "closest pair wins" logic).

  --k=N
      Number of results to return. Default: [vectors].nearest_k_default (10 unless
      overridden in config.toml).

  --score
      Include the raw similarity in the output. Omitted: rank-only (matching this
      project's "no raw scores" convention elsewhere).

  --json
      Print structured JSON instead of an aligned table.

Examples:
  mnotes vectors nearest "Weekly Notes/2026-W32"
  mnotes vectors nearest "Weekly Notes/2026-W32" --score
  mnotes vectors nearest "Projects/Moneta" --against=chunk --k=5
  mnotes vectors nearest 42 --level=chunk
`,

    cluster: `Usage: mnotes vectors cluster --algo=<algo> [flags]

Whole-vault (or --tag/--folder-scoped) grouping over full-dimensional vectors — never
runs on a \`reduce\` projection, since reducing to 2D/3D first would throw away exactly
the structure clustering is looking for.

Flags:
  --level=note|chunk
      Granularity to cluster. Default: note. Note-level always uses each note's
      centroid — there is no --aggregate flag on this command.

  --algo=kmeans|hierarchical|dbscan
      Required. Which clustering algorithm to run.

  --k=N
      kmeans: required, the cluster count. hierarchical: an alternative to
      --cut-height for cutting the dendrogram to a fixed cluster count — exactly one
      of --k / --cut-height is required for hierarchical (giving both, or neither,
      is an error).

  --cut-height=F
      hierarchical only — cut the dendrogram by cosine-distance height instead of a
      fixed cluster count.

  --epsilon=F
      dbscan only, required together with --min-points. Cosine-distance
      neighborhood radius. No default — a reasonable value depends entirely on your
      vault's actual embedding density.

  --min-points=N
      dbscan only, required together with --epsilon. Minimum neighborhood size
      needed to seed a cluster.

  --tag=T
      Restrict to notes carrying this tag (and its hierarchical children, e.g.
      --tag=project also matches project/moneta). Mutually exclusive with --folder.

  --folder=P
      Restrict to notes under this vault-relative folder path. Mutually exclusive
      with --tag.

  --format=table|json
      Default: table.
        table  cluster_id | size | example_titles (up to 3 titles per cluster,
               closest to its centroid)
        json   Full membership: one row per point, { cluster_id, note_title } (or
               { cluster_id, chunk_id, note_title } at --level=chunk).

DBSCAN's unclustered points get cluster_id: -1 (its own "noise" convention, not
remapped). Fewer points in scope than requested (--k too large, too few points for a
--cut-height cut) is a hard error, not a silently smaller cluster count.

Examples:
  mnotes vectors cluster --algo=kmeans --k=8
  mnotes vectors cluster --algo=hierarchical --cut-height=0.3 --folder="Weekly Notes"
  mnotes vectors cluster --algo=dbscan --epsilon=0.25 --min-points=3 --format=json
`,

    reduce: `Usage: mnotes vectors reduce --algo=<algo> [flags]

Dimensionality reduction for visualization. Streams to stdout by default — the point is
piping straight into a plotting tool that reads delimited data from stdin (uplot,
gnuplot's \`plot '-'\`), not reading the output directly in a terminal.

Flags:
  --level=note|chunk
      Granularity to reduce. Default: note. Note-level always uses each note's
      centroid — there is no --aggregate flag on this command.

  --algo=pca|umap
      Required.

  --dims=2|3
      Output dimensionality. Default: 2.

  --neighbors=N
      umap only (its nNeighbors parameter) — a usage error combined with
      --algo=pca. Default: umap-js's own default (15).

  --min-dist=F
      umap only (its minDist parameter) — a usage error combined with --algo=pca.
      Default: umap-js's own default (0.1).

  --tag=T
      Restrict to notes carrying this tag. Mutually exclusive with --folder.

  --folder=P
      Restrict to notes under this vault-relative folder path. Mutually exclusive
      with --tag.

  --color-by=tag|cluster|none
      Attach a label per point. Default: none.
        tag      Each point's label is its note's first tag, alphabetically.
        cluster  Runs \`cluster --algo=kmeans\` internally with a fixed-heuristic k,
                 unless --clusters points at an already-saved clustering to reuse
                 instead.

  --clusters=path
      Reuse an already-inspected clustering (a saved
      \`vectors cluster --format=json --output=...\` file) for --color-by=cluster,
      instead of computing a fresh, differently-parameterized one internally.

  --output=path
      Write to a file instead of stdout. Same content either way, only the
      destination changes.

  --format=csv|json
      Default: csv — a bare header row (id,title,x,y,z,label, plus
      chunk_line_start/chunk_line_end at --level=chunk) plus one row per point,
      nothing else, so it pipes cleanly into a plotting tool. json gives
      { points, metadata } where metadata.cluster_source is "internal" or the
      --clusters path used (present only for --color-by=cluster).

Examples:
  mnotes vectors reduce --algo=pca | uplot scatter -H -d,
  mnotes vectors reduce --algo=umap --neighbors=15 --min-dist=0.1 --color-by=cluster
  mnotes vectors reduce --algo=pca --dims=3 --format=json --output=points.json
`,

    'tag-fit': `Usage: mnotes vectors tag-fit [flags]

Does each note actually sit near the centroid of the tag(s) it carries?

Flags:
  --tag=T
      Restrict to a single tag. Omit to check every tag in the vault at once.

  --threshold=F
      Only show rows below this similarity. Omit to show every row.

  --format=table|json
      Default: table.
        table  tag | note_title | similarity_to_centroid, sorted ascending (worst
               fit first).
        json   The same rows as structured JSON.

A tag with only one member note is skipped for that tag — that note *is* the centroid,
so 1.0 similarity isn't a real signal.

Examples:
  mnotes vectors tag-fit
  mnotes vectors tag-fit --tag=project --threshold=0.6
`,

    'tag-redundancy': `Usage: mnotes vectors tag-redundancy --threshold=F [flags]

Pairwise tag-centroid comparison, flagging tags that are probably duplicates of each
other.

Flags:
  --threshold=F
      Required — minimum centroid similarity to report. No default: what counts as
      "probably duplicate" depends entirely on how your vault's tags are actually
      used.

  --format=table|json
      Default: table.
        table  tag_a | tag_b | centroid_similarity, sorted descending.
        json   The same rows as structured JSON.

Unlike tag-fit, a tag with a single member note still gets a centroid here (that note's
own vector) — every tag with at least one member is compared.

Example:
  mnotes vectors tag-redundancy --threshold=0.85
`,

    outliers: `Usage: mnotes vectors outliers --mode=<mode> [flags]

Whole-vault outlier detection (no --tag/--folder scoping).

Flags:
  --level=note|chunk
      Granularity. Default: note. Note-level always uses each note's centroid —
      there is no --aggregate flag on this command.

  --mode=isolated|bridge
      Required.
        isolated  Rank every point by its similarity to its single nearest
                  neighbor, most isolated first.
        bridge    Rank points that sit ambiguously between two clusters from a
                  --clusters file.

  --threshold=F
      isolated only — only show points whose nearest-neighbor similarity is below
      this. Mutually exclusive with --top. Not valid with --mode=bridge (bridge's
      score isn't on an independently meaningful scale).

  --top=N
      Show only the N most extreme results. Valid in both modes; the only limiting
      option in bridge mode.

  --clusters=path
      Required for --mode=bridge. A saved
      \`vectors cluster --format=json --output=...\` file — bridge mode never
      recomputes its own clustering, since a bridge result is only meaningful
      relative to a clustering you've actually inspected.

  --format=table|json
      Default: table.
        isolated  note_title | nearest_neighbor_similarity
        bridge    note_title | cluster_a | cluster_b | bridge_score

In bridge mode, points DBSCAN marked as noise (cluster_id: -1 in the --clusters file)
are excluded from scoring — a noise point isn't "between" clusters, it's unclustered
(that's what isolated mode is for).

Examples:
  mnotes vectors outliers --mode=isolated --threshold=0.3
  mnotes vectors outliers --mode=isolated --top=10
  mnotes vectors cluster --algo=kmeans --k=8 --format=json --output=clusters.json
  mnotes vectors outliers --mode=bridge --clusters=clusters.json --top=10
`,

    calibrate: `Usage: mnotes vectors calibrate [flags]

Empirical similarity-threshold finding from the vault's own link graph: compares the
similarity distribution of every actually-linked note pair against a random
unlinked-pair baseline, grounded in real vault structure rather than a guessed constant.

Flags:
  --level=note|chunk
      Default: note. At --level=chunk, each pair's similarity is the best
      chunk-pair match (mirrors compare --aggregate=best-chunk) — there's no
      separate chunk-level linkage concept.

  --sample-size=N
      Size of the random unlinked-pair baseline sample. Default:
      [vectors].calibrate_sample_size (500 unless overridden in config.toml). The
      linked side is never sampled — every resolvable linked pair is included.

  --format=table|json
      Default: table.
        table  A p10/p25/p50/p75/p90 percentile summary for both the linked and
               unlinked populations.
        json   { linked: [{note_a, note_b, similarity}], unlinked: [...] } — full
               raw pairs, e.g. for plotting a histogram elsewhere.

Links to a non-existent note, and self-links, are excluded from the linked population.

Examples:
  mnotes vectors calibrate
  mnotes vectors calibrate --level=chunk --sample-size=1000 --format=json
`,
};

function hasHelpFlag(args) {
    return args.includes('--help') || args.includes('-h');
}

export async function runVectorsCommand(args, deps) {
    const [ sub, ...rest ] = args;

    if (sub === undefined || sub === '--help' || sub === '-h') {
        return { stdout: VECTORS_OVERVIEW_HELP, stderr: '', exitCode: 0 };
    }

    const handler = VECTORS_SUBCOMMANDS[sub];
    if (!handler) {
        return { stdout: '', stderr: `mnotes: unknown vectors subcommand "${sub}"\n`, exitCode: 1 };
    }

    if (hasHelpFlag(rest)) {
        return { stdout: VECTORS_HELP[sub], stderr: '', exitCode: 0 };
    }

    return handler(rest, deps);
}
