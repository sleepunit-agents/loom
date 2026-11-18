import { privateSecretClient, PRIVATE_SECRET_TIMEOUT_MS } from '../pieces/secrets/private-client.js';
/** Worker-side client for the ordinary operation door. No local retries: a lost
 * claim or report is reconciled by loom's job-silence sweep. The one exception is
 * finish, which is sent again under the same operation id (see httpWorkerControl). */
import { randomUUID } from 'node:crypto';
import { credentialFingerprint } from '../core/data/authentication.js';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { privateOrigin } from '../core/private-origin.js';
import { machineFacts } from './machine-facts.js';
import type { WorkerControl } from './worker.js';
import type { QuotaWindow } from './quota.js';
import type { SignInReason } from './account-signin-reasons.js';
import { FINISH_BUDGET_MS } from './silence.js';
import { mintBodyToken } from './body-token.js';
import { DOOR_REQUEST_BYTES } from '../core/data/door-limit.js';
export const workerAssignment = z.object({
  id: z.string().min(1), box: z.string().min(1), agent: z.string().min(1),
  conversation: z.string().nullable(), thread: z.string().min(1).nullable().optional(), venue:z.string().min(1).nullable().optional(), model: z.string(), account: z.string(), accountChoices: z.number().int().min(1).optional(),
  harness: z.string().min(1), brief: z.string(),
  run: z.object({ policy: z.object({
    deniedTools: z.array(z.object({ pattern: z.string().min(1), guestsOnly: z.boolean() })),
    people: z.array(z.object({ kind: z.enum(['person', 'outside', 'unknown']), person: z.string().nullable(), tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable() })),
    mail: z.array(z.string().min(1)).optional(),
    word: z.enum(['own', 'owners', 'others']).optional(),
  }).optional(), nestedContainers: z.boolean(), gpu: z.boolean(),
    machine: z.object({ approval: z.string().trim().min(1) }).strict().optional(),
    ports: z.array(z.object({ address: z.string(), port: z.number().int().min(1).max(65535) })),
  }).optional(),
  house: z.object({ repository: z.string(), file: z.string(), branch: z.string() }),
});
export interface WorkerHttpOptions {
  url: string; token: string; signal: AbortSignal; timeoutMs?: number;
  fetch?: typeof fetch;
  /** Waits between the tries of a finish report; tests supply their own. */
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** A finish report is sent at most this many times, this far apart, and all of it inside FINISH_BUDGET_MS:
 * a try is given no more time than the budget has left, whatever the request deadline is set to. */
const FINISH_TRIES = 3, FINISH_PAUSE_MS = 2_000;
function operationCaller(input: WorkerHttpOptions) {
  let base: URL;
  try { base = privateOrigin(input.url); } catch { throw new Error('Worker URL must be an HTTPS origin (HTTP allowed only on loopback)'); }
  if (!input.token.trim() || /[\r\n]/.test(input.token)) throw new Error('Worker token is invalid');
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid worker request timeout');
  async function call<T>(name: string, args: unknown, schema: z.ZodType<T>, onAbort?: () => void, id: string = randomUUID(), withinMs = timeoutMs): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(0, Math.min(timeoutMs, withinMs)));
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    let response: Response | undefined;
    if (onAbort) { signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); }
    try {
      const body = JSON.stringify({ id, input: args });
      if (Buffer.byteLength(body, 'utf8') > DOOR_REQUEST_BYTES) throw new Error('Worker request exceeded limit');
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
          // An answer to a worker is small: it reads no more of one than it may send.
          if (size > DOOR_REQUEST_BYTES) throw new Error('Worker response exceeded limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (signal.aborted) throw new Error('Worker request cancelled');
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return z.object({ ok: z.literal(true), value: schema }).parse(data).value;
    } catch {
      // Never include upstream bodies, URLs, tokens or fetch diagnostics in logs.
      throw new Error(`Worker ${name} failed; outcome may be uncertain`);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  return call;
}
export interface WorkerAccountIdentity { account: string; owner: string; provider: string }
export function readWorkerAccountBasis(input: WorkerHttpOptions, identity: WorkerAccountIdentity) {
  return operationCaller(input)('accountUsageBasis', identity, z.object({ basis: z.uuid() }).strict());
}
export function reportWorkerAccountUnavailable(input: WorkerHttpOptions, observation: WorkerAccountIdentity & { basis: string }) {
  return operationCaller(input)('accountUnavailable', observation, z.object({ recorded: z.boolean() }).strict());
}
export function reportWorkerAccountUsage(input: WorkerHttpOptions, observation: WorkerAccountIdentity & { windows: readonly QuotaWindow[]; basis: string }) {
  return operationCaller(input)('accountUsage', observation, z.object({ recorded: z.boolean() }).strict());
}
export function reportWorkerHealth(input: WorkerHttpOptions & { facts?: readonly string[] }) {
  const facts = input.facts === undefined ? undefined : machineFacts.parse(input.facts);
  return operationCaller(input)('health', facts === undefined ? {} : { facts }, z.object({ ok: z.literal(true) }).strict());
}
/** The worker's side of a relayed account sign-in: see account-signin-relay.ts. */
export function workerSignIn(input: WorkerHttpOptions) {
  const call = operationCaller(input), saved = z.object({ saved: z.literal(true) }).strict();
  return {
    next: () => call('signInNext', {}, z.object({ id: z.string(), account: z.string(), owner: z.string(), provider: z.string() }).strict().nullable()),
    page: async (page: { id: string; link: string; userCode?: string }) => { await call('signInPage', page, saved); },
    // The take is a write sent under the take id itself, so sending it again is the same take.
    take: (id: string, take: string) => call('signInTake', { id }, z.object({ taken: z.boolean() }).strict(), undefined, take),
    code: (id: string, take: string) => call('signInCode', { id, take }, z.object({ code: z.string().nullable(), stop: z.boolean(), answered: z.boolean() }).strict()),
    done: async (done: { id: string; signedIn: boolean; why?: SignInReason }) => { await call('signInDone', done, saved); },
  };
}
export function httpWorkerControl(input: WorkerHttpOptions & { facts?: readonly string[] }): WorkerControl {
  const facts = input.facts === undefined ? undefined : machineFacts.parse(input.facts);
  const call = operationCaller(input);
  const ack = z.object({ ok: z.literal(true) });
  return {
    enrollBody: async (job, signal) => {
      const token = mintBodyToken();
      const cancellation = AbortSignal.any([input.signal, signal]);
      let erased = false;
      const erase = () => { erased = true; token.fill(0); cancellation.removeEventListener('abort', erase); };
      cancellation.addEventListener('abort', erase, { once: true });
      try {
        if (cancellation.aborted) throw new Error('Body enrollment cancelled');
        await operationCaller({ ...input, signal: cancellation })('enrollBody',
          { job, fingerprint: credentialFingerprint(token) }, z.object({ registered: z.literal(true) }).strict(), erase);
        if (cancellation.aborted || erased) throw new Error('Body enrollment cancelled');
        return { origin: new URL(input.url).origin, job, token, erase };
      } catch { erase(); throw new Error('Worker body enrollment failed; outcome may be uncertain'); }
    },
    repositoryInput:async(job,signal)=>{const client=privateSecretClient({...input,timeoutMs:Math.min(input.timeoutMs??PRIVATE_SECRET_TIMEOUT_MS,PRIVATE_SECRET_TIMEOUT_MS),signal:AbortSignal.any([input.signal,signal])});try{return await client.repository(job);}finally{client.close();}},
    next: async () => (await call('next', facts === undefined ? {} : { facts }, workerAssignment.nullable())) ?? undefined,
    started: async (job, build) => { await call('started', { job, build }, ack); },
    heartbeat: async (job, state) => (await call('heartbeat', { job, state }, z.object({ active: z.boolean() }))).active,
    // The body has already ended, so nothing is lost by asking again, and one dropped reply should not turn
    // finished work into a lost job. Every try carries the same operation id: if loom saved the first one,
    // it answers the next from that receipt and the job is finished once.
    finish: async (job, exitCode, logTail, exitBy) => {
      const id = randomUUID(), pause = input.pause ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
      const until = performance.now() + FINISH_BUDGET_MS;
      for (let tries = 1; ; tries++) {
        try { await call('finish', { job, exitCode, logTail, exitBy }, ack, undefined, id, until - performance.now()); return; }
        catch (error) {
          if (tries >= FINISH_TRIES || input.signal.aborted || until - performance.now() <= FINISH_PAUSE_MS) throw error;
          try { await pause(FINISH_PAUSE_MS, input.signal); } catch { throw error; }
        }
      }
    },
  };
}
