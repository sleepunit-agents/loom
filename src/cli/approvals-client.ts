/** Metadata generated command surface; transport only, with no store or approval decisions. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './api-client.js';
import { approvalCommands } from '../pieces/approvals/commands.js';
const answerSchema = z.object({
  ok: z.literal(true),
  value: z.object({ stdout: z.string(), stderr: z.string(), exit: z.number().int().min(0).max(255) }),
});
const refusalSchema = z.object({ ok: z.literal(false), message: z.string() });
const defaultRuntime: ClientRuntime = {
  request: (...args) => fetch(...args),
  retry: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
export async function runApprovalsClient(argv: string[], io: IOStreams, runtime: ClientRuntime = defaultRuntime): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    io.stdout(`usage: approvals <${approvalCommands.map(c => c.name).join('|')}> ...\n`);
    return 0;
  }
  const fail = (message: string) => { io.stderr(`approvals: ${message}\n`); return 1; };
  let base: URL;
  try {
    base = new URL(io.env.LOOM_URL ?? 'http://127.0.0.1:8787');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      return fail('LOOM_URL must be an HTTP(S) origin without credentials, path, query or fragment');
    }
  } catch { return fail('Invalid LOOM_URL'); }
  let token: string;
  if (!io.env.LOOM_TOKEN_FILE) return fail('LOOM_TOKEN_FILE is required');
  try { token = (await readFile(io.env.LOOM_TOKEN_FILE, 'utf8')).trim(); }
  catch { return fail('Cannot read LOOM_TOKEN_FILE'); }
  if (!token) return fail('Token file is empty');
  const body = JSON.stringify({ id: randomUUID(), input: { argv } });
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await runtime.request(new URL('/api/approvals/command', base), {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body, signal: AbortSignal.timeout(1500),
      });
    } catch {
      if (attempt === 3) return fail('loom daemon is unavailable');
      await runtime.retry(100 * (attempt + 1));
      continue;
    }
    if (response.status === 503 && attempt < 3) {
      await response.body?.cancel();
      await runtime.retry(100 * (attempt + 1));
      continue;
    }
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { return fail('Invalid daemon response'); }
    const answer = answerSchema.safeParse(envelope);
    if (!response.ok || !answer.success) {
      const refusal = refusalSchema.safeParse(envelope);
      return fail(refusal.success ? refusal.data.message.replaceAll(token, '[redacted]') : 'Invalid daemon response');
    }
    io.stdout(answer.data.value.stdout);
    io.stderr(answer.data.value.stderr);
    return answer.data.value.exit;
  }
  return fail('loom daemon is unavailable');
}
