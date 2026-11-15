import { SecretRequests } from './pieces/secrets/requests.js';
import { SecretValues, type RecoverableSecretMutations } from './pieces/secrets/shared-values.js';
import { registerSharedSecretCommands } from './shared-secret-commands.js';
/** Fresh shared composition. The caller initializes the approved schema and owns
 * the connection; this never bootstraps legacy tables or opens another store. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { tempoSettingsProposals } from './core/tempo/proposal.js';
import { sharedTempoSettings, type TempoChatAuthentication } from './shared-tempo-settings.js';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { sharedCredentials } from './shared-credentials.js';
import { OperationResults } from './core/data/operation-results.js';
import type { Clock } from './core/clock.js';
import { Operations, failure, type Change } from './core/operations/index.js';
import { taskService } from './apps/tasks.js';
import { approvalService, type ApprovedOperations } from './apps/approvals.js';
import { Conversations } from './core/conversations/index.js';
import { registerSharedPreferences } from './shared-preferences.js';
import { registerSharedTaskCommands } from './shared-task-commands.js';
import { nextData } from './next-data.js';
import { sharedSigninLinkRoutes } from './core/signin/shared-links.js';
import { installSharedTempo, type SharedTempoOptions } from './shared-tempo.js';

class BodyTooLarge extends Error {}
const envelope = z.object({ input: z.unknown(), id: z.string().min(1).max(200).optional() }).strict();
export function sharedRoot(options: {
  db: DataDatabase;
  clock: Clock;
  originAllowed(request: IncomingMessage): boolean;
  publicOrigin?: string;
  fields?: Parameters<typeof nextData>[4];
  approvedOperations?: ApprovedOperations;
  tempo?: SharedTempoOptions;
  /** Explicit authenticated private holder and stable private retry key. */
  secretWrites?: {holder:RecoverableSecretMutations;fingerprintKey:Uint8Array};
  changed?(changes: Change[]): void;
  reportError(error: unknown): void;
}) {
  if(options.secretWrites && (!(options.secretWrites.fingerprintKey instanceof Uint8Array) || options.secretWrites.fingerprintKey.byteLength!==32))throw Error('Invalid secret retry key');
  const { db, clock } = options;
  const now = () => new Date(clock.now()).toISOString();
  const chat = new AsyncLocalStorage<TempoChatAuthentication>();
  const settings = tempoSettingsProposals(db, clock);
  let closing: Promise<void> | undefined;
  const credentials = sharedCredentials(db, clock, () => !closing);
  const data = nextData(db, clock, request => !closing && options.originAllowed(request), options.publicOrigin, options.fields, () => !closing, credentials.authenticate);
  const operations = new Operations(db.$client, clock, changes => options.changed?.(changes), {
    receipts: new OperationResults(db), writes: data.writes,
    reportError: () => options.reportError(new Error('Shared operation notification failed')),
  });
  registerSharedPreferences(operations, db);
  const requests = new SecretRequests(db, now);
  const values = options.secretWrites && new SecretValues(db, now, options.secretWrites.holder,
    options.secretWrites.fingerprintKey, write => {
      const result = data.writes.run(write);
      for (const _error of result.notificationErrors) { try { options.reportError(new Error('Secret write notification failed')); } catch { /* reporting cannot undo a commit */ } }
    });
  registerSharedSecretCommands(operations, db, requests, values && {
    values, fingerprintKey:options.secretWrites!.fingerprintKey,
  });
  let secretRecovery:Promise<void>|undefined, cancelSecretRecovery:(()=>void)|undefined;
  const recoverSecrets=()=>{
    if(closing || !values)return Promise.resolve();
    if(secretRecovery)return secretRecovery;
    cancelSecretRecovery?.();
    secretRecovery=values.reconcilePending().catch(()=>{}).finally(()=>{
      secretRecovery=undefined;
      if(!closing)cancelSecretRecovery=clock.at(clock.now()+60_000,recoverSecrets);
    });
    return secretRecovery;
  };
  if(values)cancelSecretRecovery=clock.at(clock.now(),recoverSecrets);
  const services = {
    tasks: taskService(db, now),
    approvals: approvalService(db, new Map([...(options.approvedOperations ?? []), settings.operation]), now),
    conversations: new Conversations(db, now),
    secrets: {requests,values,reconcile:recoverSecrets},
  };
  registerSharedTaskCommands(operations, db, services.tasks);
  const settingsBinding = sharedTempoSettings(db, clock, () => chat.getStore(), services.approvals);
  let tempo: ReturnType<typeof installSharedTempo>;
  try { tempo = installSharedTempo(db, clock, data.writes, operations, services.conversations, data.changed, {
    ...options.tempo, settings: options.tempo?.settings ?? settingsBinding.request,
    settingsAuthorized: options.tempo?.settings ? options.tempo.settingsAuthorized : settingsBinding.allowed,
  }); }
  catch (error) { cancelSecretRecovery?.(); values?.close(); operations.close(); void data.close(); throw error; }
  const authenticate = credentials.authenticate;
  const active = new Set<{ abort: AbortController; done: Promise<void> }>();
  const http = new Hono<{ Variables: { shutdown: AbortController } }>();
  const bodyRequest = (request: Request, abort: AbortController, limited = false) => {
    let size = 0;
    return request.body ? new Request(request, {
      body: request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          size += chunk.byteLength;
          if (limited && size > 1024 * 1024) throw new BodyTooLarge();
          stream.enqueue(chunk);
        },
      }), { signal: abort.signal }), signal: abort.signal, duplex: 'half',
    } as RequestInit) : request;
  };
  http.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (closing) return c.json(failure('unavailable', 'Loom is closing'), 503);
    const abort = new AbortController();
    let finished!: () => void;
    const entry = { abort, done: new Promise<void>(resolve => { finished = resolve; }) };
    active.add(entry); c.set('shutdown', abort);
    try { await next(); } finally { active.delete(entry); finished(); }
  });
  http.route('/', sharedSigninLinkRoutes({ db, clock, writes: data.writes, publicOrigin: options.publicOrigin, admitted: () => !closing, reportError: options.reportError }));
  http.all('/graphql', c => data.http.fetch(bodyRequest(c.req.raw, c.get('shutdown'))));
  http.onError(() => Response.json(failure('unavailable', 'Request could not complete'), { status: 503, headers: { 'cache-control': 'no-store' } }));
  http.post('/api/:piece/:operation', async c => {
    const request = c.req.raw, origin = request.headers.get('origin'), url = new URL(request.url);
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin && !(origin === options.publicOrigin && new URL(origin).host === url.host)))
      return c.json(failure('denied', 'Cross-origin request refused'), 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return c.json(failure('invalid', 'Use application/json'), 415);
    const auth = authenticate(request);
    if (!auth?.valid()) return c.json(failure('denied', 'Authentication required'), 401);
    let body: unknown;
    try { body = await bodyRequest(request, c.get('shutdown'), true).json(); } catch (error) { return error instanceof BodyTooLarge ? c.json(failure('invalid', 'Request body too large'), 413) : c.json(failure('invalid', 'Invalid JSON'), 400); }
    const parsed = envelope.safeParse(body);
    if (!parsed.success) return c.json(failure('invalid', 'Expected {input, id?}'), 400);
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    const answer = await chat.run(auth, () => operations.callAsync('http', auth.viewer, `${c.req.param('piece')}.${c.req.param('operation')}`,
      parsed.data.input, parsed.data.id, auth.window === true, () => !closing && auth.valid()));

    // Execution and its final await can yield. A committed receipt remains
    // durable, but its response must not outlive the admitted credential.
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  return {
    http, operations, services: { ...services, tempo }, credentials, writes: data.writes, changed: data.changed,
    attach(server: Parameters<typeof data.attach>[0]) {
      if (closing) throw new Error('Loom is closing');
      return data.attach(server);
    },
    /** Stop admission synchronously; the caller closes SQLite only after this. */
    close() {
      if (closing) return closing;
      let resolve!: () => void, reject!: (error: unknown) => void;
      closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      // Install shared completion before synchronous detach/abort callbacks.
      tempo.close();
      cancelSecretRecovery?.(); values?.close();
      const stopped = data.close();
      const pending = [...active];
      for (const entry of pending) entry.abort.abort();
      void Promise.allSettled([stopped, secretRecovery, ...pending.map(entry => entry.done)]).then(results => {
        try { operations.close(); } catch (error) { reject(error); return; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) reject(failed.reason); else resolve();
      });
      return closing;
    },
  };
}
