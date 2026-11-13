/** Generated JSON argument binding only; schemas, policy and transitions stay in the daemon. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { attentionCommands } from './commands.js';
import type { IOStreams } from '../../cli/io.js';
import type { ClientRuntime } from '../../cli/api-client.js';
const defaults: ClientRuntime = { request: (...args) => fetch(...args), retry: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export async function runAttentionClient(argv: string[], io: IOStreams, runtime: ClientRuntime = defaults): Promise<number> {
  const help = `usage: loom-attention <${attentionCommands.map(c => c.name).join('|')}> [json-object]\n`;
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { io.stdout(help); return 0; }
  const command = attentionCommands.find(c => c.name === argv[0]);
  if (!command || argv.length > 2) { io.stderr(help); return 2; }
  let input: unknown;
  try {
    input = JSON.parse(argv[1] ?? '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
  } catch { io.stderr('loom-attention: expected a JSON object\n'); return 2; }
  const fail = (message: string) => { io.stderr(`loom-attention: ${message}\n`); return 1; };
  let base: URL, token: string;
  try {
    if (!io.env.LOOM_URL) return fail('LOOM_URL is required');
    base = new URL(io.env.LOOM_URL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return fail('Invalid LOOM_URL');
    if (!io.env.LOOM_TOKEN_FILE) return fail('LOOM_TOKEN_FILE is required');
    token = (await readFile(io.env.LOOM_TOKEN_FILE, 'utf8')).trim();
    if (!token) return fail('Token file is empty');
  } catch { return fail('Cannot configure loom connection'); }
  const body = JSON.stringify({ input, ...(command.write ? { id: randomUUID() } : {}) });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await runtime.request(new URL(`/api/attention/${command.name}`, base), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(1500),
      });
      if (response.status === 503 && attempt < 3) { await response.body?.cancel().catch(() => {}); await runtime.retry(100 * (attempt + 1)); continue; }
      const answer: unknown = await response.json();
      if (!response.ok) return fail('Request refused');
      if (!answer || typeof answer !== 'object' || !('ok' in answer)) return fail('Invalid daemon response');
      if (answer.ok !== true || !('value' in answer)) return fail('Operation refused');
      // Redact before serialization so escaped token characters cannot bypass it.
      const output = JSON.parse(JSON.stringify(answer.value), (_key, value: unknown) => typeof value === 'string' ? value.split(token).join('[redacted]') : value);
      io.stdout(JSON.stringify(output, null, 2) + '\n');
      return 0;
    } catch { if (attempt === 3) return fail('loom daemon is unavailable'); }
    await runtime.retry(100 * (attempt + 1));
  }
  return fail('loom daemon is unavailable');
}
