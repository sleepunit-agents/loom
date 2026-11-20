import type { LoginReason } from './account-login-check.js';
import type { MachineReading } from './machine-check.js';
import { privateSecretClient, PRIVATE_SECRET_TIMEOUT_MS } from '../pieces/secrets/private-client.js';
/** Worker-side client for the ordinary operation door. Claims are never replayed. */
import { randomUUID } from 'node:crypto';
import { credentialFingerprint } from '../core/data/authentication.js';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { connectionRefused, privateOrigin } from '../core/private-origin.js';
import { machineFacts } from './machine-facts.js';
import type { WorkerControl } from './worker.js';
import type { QuotaWindow } from './quota.js';
import type { SignInReason } from './account-signin-reasons.js';
import { CONTACT_PROBE_MS, SILENCE_MS, WORKER_REQUEST_MAX_MS } from './silence.js';
import { mintBodyToken } from './body-token.js';
import { DOOR_REQUEST_BYTES } from '../core/data/door-limit.js';
import { houseProgramSchema } from './house-program.js';
export const workerAssignment = z.object({
  id: z.string().min(1), box: z.string().min(1), agent: z.string().min(1),
  conversation: z.string().nullable(), thread: z.string().min(1).nullable().optional(), venue:z.string().min(1).nullable().optional(), venueDescription:z.string().optional(), model: z.string(), account: z.string(), accountChoices: z.number().int().min(1).optional(),
  harness: z.string().min(1), brief: z.string(),
  run: z.object({ policy: z.object({
    deniedTools: z.array(z.object({ pattern: z.string().min(1), guestsOnly: z.boolean() })),
    people: z.array(z.object({ kind: z.enum(['person', 'outside', 'unknown']), person: z.string().nullable(), tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable() })),
    mail: z.array(z.string().min(1)).optional(),
    word: z.enum(['own', 'owners', 'others']).optional(),
  }).optional(), nestedContainers: z.boolean(), gpu: z.boolean(),
    ports: z.array(z.object({ address: z.string(), port: z.number().int().min(1).max(65535) })),
  }).optional(),
  program: houseProgramSchema.optional(),
  house: z.object({ repository: z.string(), file: z.string(), branch: z.string() }),
});
export interface WorkerHttpOptions {
  url: string; token: string; signal: AbortSignal; timeoutMs?: number;
  fetch?: typeof fetch;
  silenceExpired?: (elapsedMs: number) => void;
  /** Wait between attempts at a receipt-backed report. */
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}
class WorkerOperationFailure extends Error {
  constructor(name: string, readonly temporary: boolean, readonly beforeDelivery = false, readonly denied = false) {
    super(`Worker ${name} failed; outcome may be uncertain`);
  }
}
function operationCaller(input: WorkerHttpOptions) {
  let base: URL;
  try { base = privateOrigin(input.url); } catch { throw new Error('Worker URL must be an HTTPS origin (HTTP allowed only on loopback)'); }
  if (!input.token.trim() || /[\r\n]/.test(input.token)) throw new Error('Worker token is invalid');
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_REQUEST_MAX_MS) throw new Error('Invalid worker request timeout');
  async function call<T>(name: string, args: unknown, schema: z.ZodType<T>, onAbort?: () => void, id: string = randomUUID(), withinMs = timeoutMs): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(0, Math.min(timeoutMs, withinMs)));
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    let response: Response | undefined;
    if (onAbort) { signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); }
    let rejectAbort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new WorkerOperationFailure(name, deadline.signal.aborted));
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new WorkerOperationFailure(name, false);
      const body = JSON.stringify({ id, input: args });
      if (Buffer.byteLength(body, 'utf8') > DOOR_REQUEST_BYTES) throw new Error('Worker request exceeded limit');
      try {
        const flight = (input.fetch ?? fetch)(new URL(`/api/runtime/${name}`, base), {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
          body,
        });
        void flight.then(late => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
        response = await Promise.race([flight, stopped]);
      } catch (error) { throw new WorkerOperationFailure(name, true, !signal.aborted && connectionRefused(error)); }
      // Only a parsed refusal from Loom says this worker has lost authority. A gateway
      // can return its own page (including a 403) while Loom is starting.
      if (!response.ok && !(name === 'next' && response.status === 400) && !(name === 'heartbeat' && (response.status === 401 || response.status === 403))) {
        throw new WorkerOperationFailure(name, response.status === 408 || response.status === 429 || response.status >= 500);
      }
      if (!response.body) throw new WorkerOperationFailure(name, false);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), stopped]).catch(() => { throw new WorkerOperationFailure(name, true); });
          if (done) break;
          size += value.byteLength;
          // An answer to a worker is small: it reads no more of one than it may send.
          if (size > DOOR_REQUEST_BYTES) throw new Error('Worker response exceeded limit');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (signal.aborted) throw new Error('Worker request cancelled');
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const denied = z.object({ ok: z.literal(false), code: z.literal('denied'), message: z.string() }).strict().safeParse(data).success;
        throw new WorkerOperationFailure(name, false, false, denied);
      }
      return z.object({ ok: z.literal(true), value: schema }).parse(data).value;
    } catch (error) {
      if (error instanceof WorkerOperationFailure) throw error;
      // Never include upstream bodies, URLs, tokens or fetch diagnostics in logs.
      throw new WorkerOperationFailure(name, deadline.signal.aborted);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAbort);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  return call;
}
/** Keep one operation id across the outage. Enrollment is retried only when no connection was made. */
async function reportWithRetry<T>(input: WorkerHttpOptions, name: string, attempt: (id: string, withinMs: number) => Promise<T>): Promise<T> {
  const id = randomUUID();
  let firstFailure: number | undefined;
  const pause = input.pause ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const remaining = () => firstFailure === undefined ? Infinity : SILENCE_MS - (performance.now() - firstFailure);
  while (!input.signal.aborted) {
    const left = remaining(), final = left <= 0;
    const withinMs = final ? left + CONTACT_PROBE_MS : left;
    if (withinMs <= 0) break;
    try { return await attempt(id, Math.min(WORKER_REQUEST_MAX_MS, withinMs)); }
    catch (error) {
      if (!(error instanceof WorkerOperationFailure) || !error.temporary || input.signal.aborted ||
        (name === 'enrollBody' && !error.beforeDelivery)) throw error;
      firstFailure ??= performance.now();
      if (final) break;
      const wait = Math.min(2_000, remaining());
      if (wait > 0) {
        try { await pause(wait, input.signal); } catch { throw error; }
      }
    }
  }
  if (!input.signal.aborted && firstFailure !== undefined) input.silenceExpired?.(Math.floor(performance.now() - firstFailure));
  throw new WorkerOperationFailure(name, true);
}
export interface WorkerAccountIdentity { account: string; owner: string; provider: string }
export interface WorkerLoginCheck { account: string; harness: string; place: 'containers' | 'host'; state: 'signed-in' | 'signed-out' | 'unknown'; expiresAt?: string | null; why?: LoginReason | null }
export function readWorkerAccountBasis(input: WorkerHttpOptions, identity: WorkerAccountIdentity) {
  return operationCaller(input)('accountUsageBasis', identity, z.object({ basis: z.uuid() }).strict());
}
export function reportWorkerAccountUnavailable(input: WorkerHttpOptions, observation: WorkerAccountIdentity & { basis: string }) {
  return operationCaller(input)('accountUnavailable', observation, z.object({ recorded: z.boolean() }).strict());
}
export function reportWorkerAccountUsage(input: WorkerHttpOptions, observation: WorkerAccountIdentity & { windows: readonly QuotaWindow[]; basis: string }) {
  return operationCaller(input)('accountUsage', observation, z.object({ recorded: z.boolean() }).strict());
}
/** What this machine's files say about each sign-in it watches (account-login-check.ts), all of them each time. */
export function reportWorkerAccountLogins(input: WorkerHttpOptions, logins: readonly WorkerLoginCheck[]) {
  return operationCaller(input)('signInState', { logins }, z.object({ changed: z.number().int().nonnegative() }).strict());
}
/** What this machine's worker read about the machine itself (machine-check.ts), including unknown readings.
 * Loom tracks the report order. */
export function reportWorkerMachineReadings(input: WorkerHttpOptions, readings: readonly MachineReading[]) {
  return operationCaller(input)('machineReadings', { readings }, z.object({ changed: z.boolean() }).strict());
}
export function workerMachineReads(input: WorkerHttpOptions) {
  const call = operationCaller(input);
  return {
    next: (reads: readonly string[]) => call('machineReadNext', {reads}, z.object({id:z.uuid(),read:z.string(),args:z.record(z.string(),z.union([z.string(),z.number()]))}).strict().nullable()),
    done: (result: {id:string;ok:boolean;output:string}) => call('machineReadDone',result,z.boolean()),
  };
}

export function reportWorkerHealth(input: WorkerHttpOptions & { facts?: readonly string[]; slots?: number }) {
  const facts = input.facts === undefined ? undefined : machineFacts.parse(input.facts);
  return operationCaller(input)('health', { facts, slots: input.slots }, z.object({ ok: z.literal(true) }).strict());
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
export function httpWorkerControl(input: WorkerHttpOptions & { facts?: readonly string[]; slots?: number; programs?: boolean }): WorkerControl {
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
        const options = { ...input, signal: cancellation }, enroll = operationCaller(options);
        const args = { job, fingerprint: credentialFingerprint(token) };
        await reportWithRetry(options, 'enrollBody', (id, remaining) => enroll('enrollBody',
          args, z.object({ registered: z.literal(true) }).strict(), erase, id, remaining));
        if (cancellation.aborted || erased) throw new Error('Body enrollment cancelled');
        return { origin: new URL(input.url).origin, job, token, erase };
      } catch { erase(); throw new Error('Worker body enrollment failed; outcome may be uncertain'); }
    },
    programInputs: async (job, aliases, signal) => {
      const client = privateSecretClient({ ...input, signal: AbortSignal.any([input.signal, signal]),
        timeoutMs: Math.min(input.timeoutMs ?? PRIVATE_SECRET_TIMEOUT_MS, PRIVATE_SECRET_TIMEOUT_MS) });
      try { return await client.program(job, aliases); }
      finally { client.close(); }
    },
    repositoryInput: async (job, signal) => {
      const client = privateSecretClient({
        ...input, signal: AbortSignal.any([input.signal, signal]),
        timeoutMs: Math.min(input.timeoutMs ?? PRIVATE_SECRET_TIMEOUT_MS, PRIVATE_SECRET_TIMEOUT_MS),
      });
      try { return await client.repository(job); }
      finally { client.close(); }
    },
    next: async () => (await call('next', {
      execution: 'container', facts, slots: input.slots, programs: input.programs || undefined,
    }, workerAssignment.nullable())) ?? undefined,
    started: async (job, build, signal) => {
      const options = signal ? { ...input, signal: AbortSignal.any([input.signal, signal]) } : input;
      const report = operationCaller(options);
      await reportWithRetry(options, 'started', (id, remaining) => report('started', { job, build }, ack, undefined, id, remaining));
    },
    heartbeat: async (job, state, signal) => {
      const beat = signal ? operationCaller({ ...input, signal: AbortSignal.any([input.signal, signal]) }) : call;
      try { return (await beat('heartbeat', { job, state }, z.object({ active: z.boolean() }))).active; }
      catch (error) { if (error instanceof WorkerOperationFailure && error.denied) return false; throw error; }
    },
    // The body has already ended, so nothing is lost by asking again, and one dropped reply should not turn
    // finished work into a lost job. Every try carries the same operation id: if loom saved the first one,
    // it answers the next from that receipt and the job is finished once.
    finish: async (job, exitCode, logTail, exitBy, programResult) => {
      await reportWithRetry(input, 'finish', (id, remaining) => call('finish', { job, exitCode, logTail, exitBy, programResult }, ack, undefined, id, remaining));
    },
  };
}
