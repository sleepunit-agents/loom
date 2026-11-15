/** Fresh shared composition. The caller owns the approved shared connection;
 * portable Memory stays in its declared files. No legacy loom tables. */
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { OperationResults } from './core/data/operation-results.js';
import type { Clock } from './core/clock.js';
import { Operations, failure, type Change } from './core/operations/index.js';
import { taskService } from './apps/tasks.js';
import { approvalService, type ApprovedOperations } from './apps/approvals.js';
import { Conversations } from './core/conversations/index.js';
import { registerSharedPreferences } from './shared-preferences.js';
import { registerSharedTaskCommands } from './shared-task-commands.js';
import {sharedMemory,type SharedMemoryOptions} from './shared-memory.js';
import {installMemorySignals} from './transport/memory-signals.js';
import { installSharedTempo, type SharedTempoOptions } from './shared-tempo.js';
import { nextData } from './next-data.js';
import { sharedSigninLinkRoutes } from './core/signin/shared-links.js';

class BodyTooLarge extends Error {}
const envelope = z.object({ input: z.unknown(), id: z.string().min(1).max(200).optional() }).strict();
export function sharedRoot(options: {
  db: DataDatabase;
  clock: Clock;
  originAllowed(request: IncomingMessage): boolean;
  publicOrigin?: string;
  memory?: SharedMemoryOptions;
  fields?: Parameters<typeof nextData>[4];
  approvedOperations?: ApprovedOperations;
  tempo?: SharedTempoOptions;
  changed?(changes: Change[]): void;
  reportError(error: unknown): void;
}) {
  const { db, clock } = options;
  const now = () => new Date(clock.now()).toISOString();
  let closing: Promise<void> | undefined;
  const memory=sharedMemory(db,clock,options.memory);
  const startupCleanups:Array<()=>void>=[memory.close];
  try{
  let memorySignals:ReturnType<typeof installMemorySignals>|undefined;
  const data = nextData(db, clock, request => !closing && options.originAllowed(request), options.publicOrigin, {...memory.fields,...options.fields}, () => !closing);
  startupCleanups.push(()=>{void data.close().catch(options.reportError);});
  const operations = new Operations(db.$client, clock, changes => {memorySignals?.changed();options.changed?.(changes);}, {
    receipts: new OperationResults(db), writes: data.writes, reportError: options.reportError,
  });
  startupCleanups.push(()=>operations.close());
  memory.register(operations);memorySignals=installMemorySignals(clock,memory,()=>data.changed());
  startupCleanups.push(()=>memorySignals?.close());
  registerSharedPreferences(operations, db);
  const services = {
    tasks: taskService(db, now),
    approvals: approvalService(db, options.approvedOperations, now),
    conversations: new Conversations(db, now),
  };
  registerSharedTaskCommands(operations, db, services.tasks);
  let tempo: ReturnType<typeof installSharedTempo>;
  try { tempo = installSharedTempo(db, clock, data.writes, operations, services.conversations, data.changed, options.tempo); }
  catch (error) { operations.close(); void data.close(); throw error; }
  const authenticate = dataAuthentication(db, () => clock.now());
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
    const answer = await operations.callAsync('http', auth.viewer, `${c.req.param('piece')}.${c.req.param('operation')}`,
      parsed.data.input, parsed.data.id, auth.window === true, () => !closing && auth.valid());
    // Execution and its final await can yield. A committed receipt remains
    // durable, but its response must not outlive the admitted credential.
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  return {
    http, operations, services: {...services,tempo}, memory, writes: data.writes, changed: ()=>memorySignals!.changed(),
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
      memorySignals?.close();
      tempo.close();
      const stopped = data.close();
      const pending = [...active];
      for (const entry of pending) entry.abort.abort();
      void Promise.allSettled([stopped, ...pending.map(entry => entry.done)]).then(results => {
        try { try{operations.close();}finally{memory.close();} } catch (error) { reject(error); return; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) reject(failed.reason); else resolve();
      });
      return closing;
    },
  };
  }catch(error){
    for(const stop of startupCleanups.reverse())try{stop();}catch(cleanup){try{options.reportError(cleanup);}catch{/* Preserve the startup failure. */}}
    throw error;
  }
}
