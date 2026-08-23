import { parseArgs } from 'node:util';
import { compareVectors, nearestNeighbors } from '../core/vectors.js';
import { formatCompareResult, formatNearestTable, formatJson } from '../format.js';
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

const VECTORS_SUBCOMMANDS = {
    compare: runCompare,
    nearest: runNearest,
};

export async function runVectorsCommand(args, deps) {
    const [ sub, ...rest ] = args;
    const handler = VECTORS_SUBCOMMANDS[sub];
    if (!handler) {
        return { stdout: '', stderr: `mnotes: unknown vectors subcommand "${sub}"\n`, exitCode: 1 };
    }
    return handler(rest, deps);
}
