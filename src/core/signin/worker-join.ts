import {isIP} from 'node:net';
import {randomBytes} from 'node:crypto';
import {and, count, eq, gt, lt, lte, sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Clock} from '../clock.js';
import type {DataDatabase} from '../data/database.js';
import {inbox, tokens, workerJoinRequests as requests} from '../data/schema.js';
import {machineName} from '../line-name.js';
import type {Viewer} from '../../policy.js';
import {OperationError,type Operations} from '../operations/index.js';
import {currentSession,freshProof} from '../data/authentication.js';
import {Conversations} from '../conversations/index.js';
import type {DataWrites} from '../data/writes.js';
import {householdOwner,householdOwners} from '../../shared-sharing.js';
import {createReportOnlyMachine} from '../../shared-machine-registry.js';
import {sharedTokens} from './shared-tokens.js';
import {DAY_MS} from '../day.js';
import {SHA256_HEX} from '../sha256-hex.js';

const requestBody = z.object({
  request:z.uuid(), name:machineName, fingerprint:z.string().regex(SHA256_HEX), renew:z.literal(true).optional(),
}).strict();
const lifetime = 15 * 60_000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Only the socket peer is trusted. Hosts behind the same proxy share its limit. */
export function workerJoinSource(peer?:string) {
  if (!peer) return 'local';
  if (isIP(peer)===4) return peer.split('.').slice(0,3).join('.');
  if (isIP(peer)!==6) return 'local';
  const canonical=new URL('http://['+peer.split('%')[0]+']/').hostname.slice(1,-1);
  const mapped=/^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (mapped) {
    const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);
    return [high>>>8,high&255,low>>>8].join('.');
  }
  const [start,end]=canonical.split('::');
  const left=start?start.split(':'):[], right=end?end.split(':'):[];
  return [...left,...Array(8-left.length-right.length).fill('0'),...right].slice(0,4).join(':');
}

const noticeKey=(id:string,code:string)=>'worker-join:'+id+':'+code;

/** One deadline for the earliest waiting card. Rebuild it from durable mail on startup. */
export function workerJoinDeadlines(db:DataDatabase,clock:Clock,writes:DataWrites) {
  let cancel:(()=>void)|undefined;
  const mail=new Conversations(db,()=>new Date(clock.now()).toISOString());
  function arm(){
    cancel?.();
    const now=new Date(clock.now()).toISOString();
    const waiting=()=>db.selectDistinct({id:requests.id,code:requests.code,expiresAt:requests.expiresAt})
      .from(requests).innerJoin(inbox,and(eq(inbox.source,'notice'),eq(inbox.state,'waiting'),
        eq(inbox.sourceId,sql`'worker-join:' || ${requests.id} || ':' || ${requests.code}`)));
    const expired=waiting().where(lte(requests.expiresAt,now)).all();
    if (expired.length) writes.run(()=>{
      for (const row of expired) mail.resolveSource('notice',noticeKey(row.id,row.code),'Join request expired');
    });
    const first=waiting().where(gt(requests.expiresAt,now)).orderBy(requests.expiresAt).limit(1).get();
    cancel=first && clock.at(Date.parse(first.expiresAt),arm);
  }
  arm();
  return {arm,close:()=>cancel?.()};
}

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
    tx.delete(requests).where(and(eq(requests.state,'pending'),lt(requests.expiresAt,new Date(now-DAY_MS).toISOString()))).run();
    const existing = tx.select().from(requests).where(eq(requests.id,input.request)).get();
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.name !== input.name)
        throw new OperationError('conflict','Join request already belongs to a different machine');
      if (existing.state === 'allowed') return {state:'allowed' as const,box:existing.box!};
      if (existing.state === 'blocked') return {state:'blocked' as const};
      if (existing.expiresAt > at) return {state:'pending' as const,code:existing.code};
      if (!input.renew) return {state:'expired' as const};
    }
    const recent = gt(requests.requestedAt,new Date(now-lifetime).toISOString());
    const recentCount = (bucket?:string) => tx.select({n:count()}).from(requests)
      .where(bucket === undefined ? recent : and(recent,eq(requests.sourceBucket,bucket))).get()!.n;
    if (recentCount() >= 20 || recentCount(sourceBucket) >= 2)
      throw new OperationError('conflict','Too many recent join requests. Try again later.');
    if ((!existing && tx.select({id:requests.id}).from(requests).where(eq(requests.fingerprint,input.fingerprint)).get()) ||
        tx.select({id:tokens.fingerprint}).from(tokens).where(eq(tokens.fingerprint,input.fingerprint)).get())
      throw new OperationError('conflict','Credential already registered');
    let code = matchCode();
    while (tx.select({id:requests.id}).from(requests).where(eq(requests.code,code)).get() ||
      tx.select({id:inbox.id}).from(inbox).where(and(eq(inbox.source,'notice'),eq(inbox.sourceId,noticeKey(input.request,code)))).get()) code = matchCode();
    const mail=new Conversations(db,()=>at);
    if (existing) {
      mail.resolveSource('notice',noticeKey(existing.id,existing.code),'Join request expired');
      tx.delete(requests).where(eq(requests.id,existing.id)).run();
    }
    tx.insert(requests).values({id:input.request,name:input.name,fingerprint:input.fingerprint,code,sourceBucket,
      requestedAt:at,expiresAt:new Date(now+lifetime).toISOString(),state:'pending'}).run();
    for (const owner of householdOwners(db)) mail.send({toKind:'person',to:owner,member:owner,source:'notice',
      sourceId:noticeKey(input.request,code),fromKind:'unknown',answers:'yes-no',words:input.name+' wants to join Loom',
      why:'Match '+code+' with the code shown on the machine.',ifYes:'Add this machine as a report-only worker.',
      ifNo:'Block this join request.'});
    return {state:'pending' as const,code};
  },{behavior:'immediate'});
}

/** sessionId comes from the authenticated browser transport. A decision and any resulting credential commit together. */
export function decideWorkerAdmission(db:DataDatabase, clock:Pick<Clock,'now'>, sessionId:string,
  request:string, code:string, decision:'allow'|'block') {
  return db.transaction(() => {
    const now=clock.now();
    const auth=currentSession(db,sessionId,now);
    if (!auth || !freshProof(auth.session,now) || !householdOwner(db,auth.viewer))
      throw new OperationError('denied','Sign in again as a household owner to decide this request');
    const row=db.select().from(requests).where(eq(requests.id,request)).get();
    if (!row || row.code!==code) throw new OperationError('not-found','Join request could not be matched');
    const state=decision==='allow'?'allowed':'blocked';
    if (row.state===state) return {state,box:row.box};
    if (row.state!=='pending') throw new OperationError('conflict','This request has already been decided');
    const at=new Date(now).toISOString();
    if (row.expiresAt<=at) throw new OperationError('conflict','Join request has expired');
    let box:string|null=null;
    if (state==='allowed') {
      box=createReportOnlyMachine(db,row.name,auth.viewer.id,false,at);
      sharedTokens(db,clock).enrolRunner(box,row.fingerprint);
    }
    db.update(requests).set({state,box,decidedBy:auth.viewer.id}).where(eq(requests.id,row.id)).run();
    new Conversations(db,()=>at).resolveSource('notice',noticeKey(row.id,row.code),state==='allowed'?'Machine admitted':'Join request blocked');
    return {state,box};
  },{behavior:'immediate'});
}

export function registerWorkerAdmission(operations:Operations,db:DataDatabase,clock:Pick<Clock,'now'>,
  browser:(viewer:Viewer)=>Readonly<{session:string}>|undefined) {
  const may=(viewer:Viewer)=>householdOwner(db,viewer)&&!!browser(viewer);
  operations.register({name:'runtime.workerJoinPending',write:false,windowOnly:true,doors:['http'],may,
    input:z.object({}).strict(),output:z.object({requests:z.array(z.object({
      request:z.uuid(),name:machineName,code:z.string(),expiresAt:z.string(),
    }))}),
    run() {
      return {requests:db.select({request:requests.id,name:requests.name,code:requests.code,expiresAt:requests.expiresAt})
        .from(requests).where(and(eq(requests.state,'pending'),gt(requests.expiresAt,new Date(clock.now()).toISOString())))
        .orderBy(requests.requestedAt).all()};
    },
  });
  operations.register({name:'runtime.workerJoinDecide',write:true,windowOnly:true,recheckPolicy:true,doors:['http'],may,
    input:z.object({request:z.uuid(),code:z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),decision:z.enum(['allow','block'])}).strict(),
    output:z.object({state:z.enum(['allowed','blocked']),box:z.string().nullable()}),
    run(ctx,input) {
      const proof=browser(ctx.viewer);
      if (!proof) throw new OperationError('denied','Use a signed-in owner browser');
      const result=decideWorkerAdmission(db,clock,proof.session,input.request,input.code,input.decision);
      ctx.changed('workerJoin',input.request);
      if (result.box) ctx.changed('boxes',result.box);
      return result;
    },
  });
}
