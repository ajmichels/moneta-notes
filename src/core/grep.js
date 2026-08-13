import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getContextLogger } from '../logger.js';

const DEFAULT_LINE_MATCH_CAP = 10;

export function assertRipgrepAvailable(env = process.env) {
    try {
        execFileSync('rg', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            getContextLogger().warn('ripgrep not found on PATH');
            throw new Error('ripgrep not found — install via `brew install ripgrep`', { cause: error });
        }
        throw error;
    }
}

export function grep(vaultRoot, pattern, options = {}) {
    const { regex = false, noteTitle = null, lineMatchCap = DEFAULT_LINE_MATCH_CAP } = options;
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
    const matchesByPath = parseMatches(stdout, vaultRoot, targetPath);

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

function parseMatches(stdout, vaultRoot, targetPath) {
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

    return matchesByPath;
}

function pathToTitle(vaultRoot, filePath) {
    const rel = relative(vaultRoot, filePath).split(sep).join('/');
    return rel.replace(/\.md$/, '');
}

function titleToPath(vaultRoot, noteTitle) {
    return join(vaultRoot, `${noteTitle}.md`);
}

function countLines(filePath) {
    const content = readFileSync(filePath, 'utf8');
    return content.length === 0 ? 0 : content.split('\n').length;
}

function runRipgrep(args, cwd) {
    try {
        return execFileSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        if (error.status === 1) {
            return '';
        }
        const stderr = error.stderr ? error.stderr.toString() : error.message;
        throw new Error(`ripgrep failed: ${stderr.trim()}`, { cause: error });
    }
}
