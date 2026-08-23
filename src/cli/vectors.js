import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { compareVectors, nearestNeighbors, clusterVectors, reduceVectors } from '../core/vectors.js';
import {
    formatCompareResult, formatNearestTable, formatClusterTable, formatReduceCsv, formatJson,
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

const VECTORS_SUBCOMMANDS = {
    compare: runCompare,
    nearest: runNearest,
    cluster: runCluster,
    reduce: runReduce,
};

export async function runVectorsCommand(args, deps) {
    const [ sub, ...rest ] = args;
    const handler = VECTORS_SUBCOMMANDS[sub];
    if (!handler) {
        return { stdout: '', stderr: `mnotes: unknown vectors subcommand "${sub}"\n`, exitCode: 1 };
    }
    return handler(rest, deps);
}
