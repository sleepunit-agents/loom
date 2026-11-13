/** Generated JSON argument binding only; schemas, policy and transitions stay in the daemon. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { accessCommands, accessResponses } from '../core/signin/commands.js';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
const defaults: ClientRuntime = { request: (...args) => fetch(...args), retry: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export async function runAccessClient(piece: 'token'|'sessions', argv: string[], io: IOStreams, runtime: ClientRuntime & { now?: () => number } = defaults): Promise<number> {
  const commands = accessCommands(piece);
  const responses: Record<string, z.ZodType> = accessResponses[piece];
  const ephemeral = piece === 'token' && argv[0] === 'create';
  const help = `usage: loom-${piece} <${commands.map(c => c.name).join('|')}> [json-object]\n`;
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { io.stdout(help); return 0; }
  const command = commands.find(c => c.name === argv[0]);
  if (!command || argv.length !== 2) { io.stderr(help); return 2; }
  const inputText = argv[1] ?? '{}';
  let input: unknown;
  try {
    input = JSON.parse(inputText);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
  } catch { io.stderr(`loom-${piece}: expected a JSON object\n`); return 2; }
  const fail = (message: string) => { io.stderr(`loom-${piece}: ${message}\n`); return 1; };
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
  const now = runtime.now ?? (() => performance.now());
  const deadline = now() + 4000;
  for (;;) {
    if (now() >= deadline) return fail('loom daemon is unavailable');
    try {
      const response = await runtime.request(new URL(`/api/${piece}/${command.name}`, base), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(Math.max(1, Math.min(1500, Math.ceil(deadline - now())))),
      });
      if (!ephemeral && response.status >= 500 && now() < deadline) {
        await response.body?.cancel().catch(() => {});
        await runtime.retry(Math.min(500, Math.max(0, deadline - now())));
        continue;
      }
      if (!response.ok) return fail('Request refused');
      const answer: unknown = await response.json();
      // Validate against the same response schema installed in the operation registry.
      const schema = responses[command.name as keyof typeof responses];
      const result = z.object({ ok: z.literal(true), value: schema }).strict().safeParse(answer);
      if (!result.success) return fail('Invalid daemon response');
      io.stdout(ephemeral ? (result.data.value as {token:string}).token + '\n' : JSON.stringify(result.data.value, null, 2) + '\n');
      return 0;
    } catch { if (ephemeral) return fail('Token creation outcome unknown; list tokens before trying again'); if (now() >= deadline) return fail('loom daemon is unavailable'); }
    await runtime.retry(Math.min(500, Math.max(0, deadline - now())));
  }
}
