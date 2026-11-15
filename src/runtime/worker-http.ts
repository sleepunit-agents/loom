/** Worker-side client for the ordinary operation door. No local retries: a lost
 * claim or report is reconciled by loom's job-silence sweep. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkerControl } from './worker.js';
export const workerAssignment = z.object({
  id: z.string().min(1), box: z.string().min(1), agent: z.string().min(1),
  conversation: z.string().nullable(), model: z.string(), account: z.string(),
  harness: z.string().min(1), brief: z.string(),
  run: z.object({ nestedContainers: z.boolean(), gpu: z.boolean(),
    ports: z.array(z.object({ address: z.string(), port: z.number().int().min(1).max(65535) })),
  }).optional(),
  house: z.object({ repository: z.string(), file: z.string(), branch: z.string() }),
});
export function httpWorkerControl(input: {
  url: string; token: string; signal: AbortSignal; timeoutMs?: number;
  fetch?: typeof fetch;
}): WorkerControl {
  const base = new URL(input.url);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    throw new Error('Worker needs HTTPS (HTTP allowed only on loopback)');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Worker URL must be an origin');
  if (!input.token.trim() || /[\r\n]/.test(input.token)) throw new Error('Worker token is invalid');
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid worker request timeout');
  async function call<T>(name: string, args: unknown, schema: z.ZodType<T>): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    let response: Response | undefined;
    try {
      const body = JSON.stringify({ id: randomUUID(), input: args });
      if (Buffer.byteLength(body, 'utf8') > 1_048_576) throw new Error('Worker request exceeded limit');
      response = await (input.fetch ?? fetch)(new URL(`/api/runtime/${name}`, base), {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
        body,
      });
      if (!response.ok || !response.body) throw new Error('Worker operation rejected');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) throw new Error('Worker response exceeded limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return z.object({ ok: z.literal(true), value: schema }).parse(data).value;
    } catch {
      // Never include upstream bodies, URLs, tokens or fetch diagnostics in logs.
      throw new Error(`Worker ${name} failed; outcome may be uncertain`);
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  const ack = z.object({ ok: z.literal(true) });
  return {
    next: async () => (await call('next', {}, workerAssignment.nullable())) ?? undefined,
    started: async (job, build) => { await call('started', { job, build }, ack); },
    heartbeat: async (job, state) => (await call('heartbeat', { job, state }, z.object({ active: z.boolean() }))).active,
    finish: async (job, exitCode, logTail) => { await call('finish', { job, exitCode, logTail }, ack); },
  };
}
