import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { getContextLogger } from '../logger.js';
import { titleToPath, pathToTitle, countLines, resolveTitle } from './note-fs.js';
import { ripgrepInstallHint } from '../platform/index.js';

const DEFAULT_LINE_MATCH_CAP = 10;

export function assertRipgrepAvailable(env = process.env) {
    try {
        execFileSync('rg', [ '--version' ], { env, stdio: 'ignore' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            getContextLogger().warn('ripgrep not found on PATH');
            throw new Error(`ripgrep not found — install via \`${ripgrepInstallHint()}\``, { cause: error });
        }
        throw error;
    }
}

// Exact match first (S010); fall back to a unique-basename match only when db is available — same
// read-oriented resolution note_read gets, additive and never a behavior change for a caller that
// passes no db.
function resolveNoteTitlePath(vaultRoot, noteTitle, db) {
    const exactPath = titleToPath(vaultRoot, noteTitle);
    if (existsSync(exactPath) || db === null) {
        return exactPath;
    }
    const resolved = resolveTitle(db, noteTitle);
    return resolved !== null ? titleToPath(vaultRoot, resolved) : exactPath;
}

export function grep(vaultRoot, pattern, options = {}) {
    const { regex = false, noteTitle = null, lineMatchCap = DEFAULT_LINE_MATCH_CAP, db = null } = options;
    assertRipgrepAvailable();

    const args = [ '--json', '--smart-case', '--glob', '*.md' ];
    if (!regex) {
        args.push('-F');
    }
    // .mnotesignore isn't a name ripgrep recognizes on its own (only .gitignore/.ignore/.rgignore
    // are), so it has to be pointed at explicitly. Ignore rules only apply to ripgrep's own
    // directory walk (the noteTitle === null branch below) — an explicitly named target file is
    // still searched regardless, same as `rg pattern some/gitignored/file` would be.
    const ignoreFilePath = join(vaultRoot, '.mnotesignore');
    if (existsSync(ignoreFilePath)) {
        args.push('--ignore-file', ignoreFilePath);
    }

    let targetPath = null;
    if (noteTitle !== null) {
        targetPath = resolveNoteTitlePath(vaultRoot, noteTitle, db);
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
            fileLineCount: fileLineCount(absPath),
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

// file_line_count means the same thing everywhere it appears (search/tags/stats/read) — the
// frontmatter-stripped body's line count, per core/note-fs.js's countLines contract — so this
// strips frontmatter the same way core/notes.js's noteRead does before counting, rather than
// counting raw file bytes (which would include frontmatter lines grep never actually searches
// meaningfully as "content").
function fileLineCount(filePath) {
    const raw = readFileSync(filePath, 'utf8');
    const { content: body } = matter(raw);
    return countLines(body);
}

function runRipgrep(args, cwd) {
    try {
        return execFileSync('rg', args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: [ 'ignore', 'pipe', 'pipe' ],
        });
    } catch (error) {
        if (error.status === 1) {
            return '';
        }
        const stderr = error.stderr ? error.stderr.toString() : error.message;
        throw new Error(`ripgrep failed: ${stderr.trim()}`, { cause: error });
    }
}
