/** Generated JSON argument binding only; schemas, policy and transitions stay in the daemon. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bridgeCommands } from '../pieces/bridges/commands.js';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
const defaults: ClientRuntime = { request: (...args) => fetch(...args), retry: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export async function runBridgesClient(argv: string[], io: IOStreams, runtime: ClientRuntime = defaults): Promise<number> {
  const help = `usage: loom-bridges <${bridgeCommands.map(c => c.name).join('|')}> [json-object]\n`;
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { io.stdout(help); return 0; }
  const command = bridgeCommands.find(c => c.name === argv[0]);
  if (!command || argv.length !== 2) { io.stderr(help); return 2; }
  const inputText = argv[1] ?? '{}';
  let input: unknown;
  try {
    input = JSON.parse(inputText);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
  } catch { io.stderr('loom-bridges: expected a JSON object\n'); return 2; }
  const fail = (message: string) => { io.stderr(`loom-bridges: ${message}\n`); return 1; };
  let base: URL, token: string;
  try {
    if (!io.env.LOOM_URL) return fail('LOOM_URL is required');
    base = new URL(io.env.LOOM_URL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return fail('Invalid LOOM_URL');
    if (!io.env.LOOM_TOKEN_FILE) return fail('LOOM_TOKEN_FILE is required');
    token = (await readFile(io.env.LOOM_TOKEN_FILE, 'utf8')).trim();
    if (!token) return fail('Token file is empty');
  } catch { return fail('Cannot configure loom connection'); }
  // Preserve raw validated JSON: reserialization would turn overflow numbers into null.
  const body = `{"input":${inputText}${command.write ? `,"id":${JSON.stringify(randomUUID())}` : ''}}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await runtime.request(new URL(`/api/bridges/${command.name}`, base), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(1500),
      });
      if (response.status >= 500 && attempt < 3) { await response.body?.cancel().catch(() => {}); await runtime.retry(100 * (attempt + 1)); continue; }
      if (!response.ok) return fail('Request refused');
      const answer: unknown = await response.json();
      // Both envelope and acknowledgement are closed shapes; print only the requested id.
      const result = z.object({ ok: z.literal(true), value: z.object({ id: z.string() }).strict() }).strict().safeParse(answer);
      if (!result.success || result.data.value.id !== (input as Record<string, unknown>).id) return fail('Invalid daemon response');
      io.stdout(JSON.stringify(result.data.value, null, 2) + '\n');
      return 0;
    } catch { if (attempt === 3) return fail('loom daemon is unavailable'); }
    await runtime.retry(100 * (attempt + 1));
  }
  return fail('loom daemon is unavailable');
}
