import {randomBytes} from 'node:crypto';
import {and, count, eq, gt, lt} from 'drizzle-orm';
import {z} from 'zod';
import type {Clock} from '../clock.js';
import type {DataDatabase} from '../data/database.js';
import {tokens, workerJoinRequests as requests} from '../data/schema.js';
import {machineName} from '../line-name.js';
import {OperationError} from '../operations/index.js';
import {SHA256_HEX} from '../sha256-hex.js';

const requestBody = z.object({
  request:z.uuid(), name:machineName, fingerprint:z.string().regex(SHA256_HEX),
}).strict();
const lifetime = 15 * 60_000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function matchCode() {
  const digits = Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]).join('');
  return digits.slice(0,4) + '-' + digits.slice(4);
}

/** The transport supplies the source bucket. Repeated polls use the original request and consume no slots. */
export function requestWorkerAdmission(db:DataDatabase, clock:Pick<Clock,'now'>, sourceBucket:string, body:unknown) {
  const input = requestBody.parse(body);
  return db.transaction(tx => {
    const now = clock.now();
    const at = new Date(now).toISOString();
    // Keep expired requests for one day so a worker returning late can see the outcome.
    tx.delete(requests).where(and(eq(requests.state,'pending'),lt(requests.expiresAt,new Date(now-86_400_000).toISOString()))).run();
    const existing = tx.select().from(requests).where(eq(requests.id,input.request)).get();
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.name !== input.name)
        throw new OperationError('conflict','Join request already belongs to a different machine');
      if (existing.state === 'allowed') return {state:'allowed' as const,box:existing.box!};
      if (existing.state === 'blocked') return {state:'blocked' as const};
      if (existing.expiresAt <= at) return {state:'expired' as const};
      return {state:'pending' as const,code:existing.code};
    }
    const recent = gt(requests.requestedAt,new Date(now-lifetime).toISOString());
    const recentCount = (bucket?:string) => tx.select({n:count()}).from(requests)
      .where(bucket === undefined ? recent : and(recent,eq(requests.sourceBucket,bucket))).get()!.n;
    if (recentCount() >= 20 || recentCount(sourceBucket) >= 2)
      throw new OperationError('conflict','Too many recent join requests. Try again later.');
    if (tx.select({id:requests.id}).from(requests).where(eq(requests.fingerprint,input.fingerprint)).get() ||
        tx.select({id:tokens.fingerprint}).from(tokens).where(eq(tokens.fingerprint,input.fingerprint)).get())
      throw new OperationError('conflict','Credential already registered');
    let code = matchCode();
    while (tx.select({id:requests.id}).from(requests).where(eq(requests.code,code)).get()) code = matchCode();
    tx.insert(requests).values({id:input.request,name:input.name,fingerprint:input.fingerprint,code,sourceBucket,
      requestedAt:at,expiresAt:new Date(now+lifetime).toISOString(),state:'pending'}).run();
    return {state:'pending' as const,code};
  },{behavior:'immediate'});
}
