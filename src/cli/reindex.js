import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';

export function streamReindex(socketPath, noteTitle, onMessage) {
    return new Promise((resolve, reject) => {
        const client = createConnection(socketPath);
        let buffer = '';

        client.on('connect', () => {
            client.write(`${JSON.stringify({ action: 'reindex', noteTitle })}\n`);
        });
        client.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                onMessage(JSON.parse(buffer.slice(0, newlineIndex)));
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf('\n');
            }
        });
        client.on('end', resolve);
        client.on('error', (err) => {
            reject(new Error(
                `mnotes reindex: could not connect to the daemon at "${socketPath}" — is it running? (${err.message})`,
                { cause: err },
            ));
        });
    });
}

export async function runReindexCommand(args, deps) {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const noteTitle = positionals[0] ?? null;
    const lines = [];
    let summary = null;

    await streamReindex(deps.socketPath, noteTitle, (msg) => {
        if (msg.summary) {
            summary = msg.summary;
            return;
        }
        const suffix = msg.attempts ? ` (attempt ${msg.attempts})` : '';
        lines.push(`${msg.path} | ${msg.outcome}${suffix}`);
    });

    lines.push(`reindexed: ${summary.reindexed}, skipped: ${summary.skipped}, failed: ${summary.failed}`);

    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: summary.failed > 0 ? 1 : 0 };
}
