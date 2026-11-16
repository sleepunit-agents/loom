import { commsQuery } from '../web/src/pieces/comms/shared-query.js';
import { inboxQuery } from '../web/src/pieces/attention/inbox-query.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { generateX25519Identity } from 'age-encryption';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, conversations, household, inbox, inboxRefs, inboxReads, memberAgents, members, messages, operationResults, threads, tokens, sessions, turns } from './core/data/schema.js';
import { DataLive } from './core/data/live.js';
import { DataWrites } from './core/data/writes.js';
import { sharedRoot } from './shared-root.js';
import { GraphQLScalarType } from 'graphql/index.js';
import { wordsKey } from './pieces/comms/crypto.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(fields?: Parameters<typeof sharedRoot>[0]['fields'],initialTime=Date.parse('2026-11-14T18:00:00Z')) {
  const statements:string[]=[];
  const client = new Database(':memory:',{verbose:s=>{if(/^select\b/i.test(s)&&/InboxQueries|readInboxSet|readInboxVolume|CommsQueries|readCommsPage|readCommsSet/.test(new Error().stack??''))statements.push(s);}}); cleanup.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(initialTime), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  for (const [id, role] of [['alice','member'],['bob','member'],['owner','owner']] as const) db.insert(members).values({ id, role, joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const credentials = Object.fromEntries(['alice','bob','owner'].map((member, n) => {
    const token = String(n+1).repeat(64), cookie = String(n+4).repeat(64);
    db.insert(tokens).values({ fingerprint: hash(token), label: member, kind: 'owner', member, createdAt: now() }).run();
    db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: now(), seenAt: now(), provedAt: now() }).run();
    return [member, { token, cookie }];
  }));
  let seal: (() => Promise<void>) | undefined, open: (() => Promise<void>) | undefined;
  const key = wordsKey(await generateX25519Identity());
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, fields, originAllowed: () => true, commsKey: { ...key, async seal(words) { await seal?.(); return key.seal(words); }, async open(blob) { await open?.(); return key.open(blob); } }, reportError: error => errors.push(error) });
  cleanup.push(() => root.close());
  const post = (name: string, input: object, id: string, person = 'alice', bearer = false) => root.http.request(`/api/${name.replace('.','/')}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${credentials[person].token}` } : { cookie: `loom_ui=${credentials[person].cookie}` }) }, body: JSON.stringify({ input, id }),
  });
  const query = async (source: string, person = 'alice',variables:Record<string,unknown>={}) => {
    const response = await root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `loom_ui=${credentials[person].cookie}` }, body: JSON.stringify({ query: source,variables }) });
    return { response, body: await response.json() as { data?: Record<string, unknown>; errors?: unknown[] } };
  };
  return { client, db, clock, root, errors, credentials, post, query, statements, gate: (fn: () => Promise<void>) => { seal = fn; }, openGate: (fn: () => Promise<void>) => { open = fn; } };
}
it('mounts actual shared private reads and cookie writes with metadata-only receipts and current ownership', async () => {
  const f = await fixture();
  expect(await (await f.post('comms.open', { thread: 'th:pump', agent: 'art', title: 'Pump' }, 'open')).json()).toMatchObject({ ok: true, value: { thread: 'th:pump' } });
  const input = { thread: 'th:pump', clientId: 'message-1', words: 'PRIVATE PERSON MESSAGE' };
  const sent = await (await f.post('comms.send', input, 'send')).json(); expect(sent).toMatchObject({ ok: true });
  expect(await (await f.post('comms.send', input, 'send')).json()).toEqual(sent);
  const query = '{homeComms{member agents} commsThreads{id} commsMessages(thread:"th:pump"){seq words wordsKeepUntil} inboxFolders{needs alerts all} recentConversations(agent:"art"){id agent label lastAnswer{words}}}';
  const read = await f.query(query); expect(read.body.errors).toBeUndefined(); expect(JSON.stringify(read.body.data)).toContain('PRIVATE PERSON MESSAGE');
  expect(read.body.data?.recentConversations).toEqual([{id:expect.any(String),agent:'art',label:'Pump',lastAnswer:null}]);
  expect((await f.query(query,'bob')).body.data?.commsThreads).toEqual([]);
  expect((await f.query('{commsThread(id:"th:pump"){id}}','owner')).body.data?.commsThread).toEqual({ id: 'th:pump' });
  expect((await f.post('comms.send', { ...input, clientId:'owner' }, 'owner-send','owner')).status).toBe(403);
  expect((await f.post('comms.open',{thread:'th:bob',agent:'art',title:'Bob'},'bob-open','bob')).status).toBe(403);
  expect((await f.post('comms.change',{thread:'th:pump',change:'rename',title:'Owner changed it'},'owner-change','owner')).status).toBe(403);
  expect(f.db.select().from(threads).all()).toMatchObject([{id:'th:pump',title:'Pump'}]);
  for (const id of ['bob-open','owner-change']) expect(f.db.select().from(operationResults).where(eq(operationResults.id,id)).all()).toEqual([]);
  expect((await f.post('comms.send', { ...input, clientId:'bearer' }, 'bearer','alice',true)).status).toBe(403);
  f.root.writes.run(() => f.db.insert(memberAgents).values({member:'bob',agent:'art'}).run());
  const hidden = await f.query(`{commsThread(id:"th:pump"){id title} commsMessages(thread:"th:pump"){seq words} inboxItem(id:"${sent.value.item}"){body{words}}}`,'bob');
  expect(hidden.body.errors).toBeUndefined(); expect(hidden.body.data).toEqual({commsThread:null,commsMessages:[],inboxItem:null});

  expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain('PRIVATE PERSON MESSAGE');
  expect(JSON.stringify(f.db.select().from(operationResults).all())).not.toContain('PRIVATE PERSON MESSAGE');
  expect(f.db.select().from(messages).all()).toHaveLength(1);
  f.root.writes.run(() => f.db.delete(memberAgents).run());
  expect((await f.post('comms.send', input, 'send')).status).toBe(403);
  expect((await f.query(query)).body.data?.homeComms).toEqual({ member: 'alice', agents: [] });
  expect(f.errors).toEqual([]);
});
it('answers the same private Inbox item through real HTTP and denies other people or stale sessions', async () => {
  const f = await fixture(), comms = f.root.services.comms!;
  const thread = comms.threads.open({ member:'alice',agent:'art',title:'Pump' });
  const question = await comms.ask(thread.id,'art','ask',{words:'PRIVATE QUESTION',answers:'words'});
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE ANSWER'},'other','bob')).status).toBe(403);
  expect((await f.post('inbox.read',{item:question.inboxItem!},'other-read','bob')).status).toBe(403);
  expect(f.client.prepare('SELECT count(*) AS n FROM inbox_reads').get()).toEqual({n:0});
  expect(f.db.select().from(operationResults).where(eq(operationResults.id,'other-read')).all()).toEqual([]);
  const visibleOwner = await f.query(`{inboxItem(id:"${question.inboxItem}"){body{words}}}`,'owner');
  expect((await f.query(`{inboxItem(id:"${question.inboxItem}"){canAnswer}}`,'owner')).body.data?.inboxItem).toEqual({canAnswer:false});
  expect((await f.query(`{inboxItem(id:"${question.inboxItem}"){canAnswer}}`)).body.data?.inboxItem).toEqual({canAnswer:true});
  expect(visibleOwner.body.errors).toBeUndefined(); expect(visibleOwner.body.data?.inboxItem).toEqual({body:{words:'PRIVATE QUESTION'}});
  expect((await f.post('inbox.read',{item:question.inboxItem!},'owner-read','owner')).status).toBe(200);
  expect(f.client.prepare('SELECT member FROM inbox_reads').all()).toEqual([{member:'owner'}]);
  expect((await f.query(`{inboxItem(id:"${question.inboxItem}"){read}}`)).body.data?.inboxItem).toEqual({read:false});
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'OWNER ANSWER'},'owner-answer','owner')).status).toBe(403);
  expect(f.db.select().from(operationResults).where(eq(operationResults.id,'owner-answer')).all()).toEqual([]);
  const plain = f.root.services.conversations.send({toKind:'person',to:'alice',source:'discord',sourceId:'plain-owner-test',fromKind:'agent',fromId:'art',member:'alice',agent:'art',words:'PUBLIC SOURCE QUESTION',answers:'yes-no'});
  expect((await f.query(`{inboxItem(id:"${plain.id}"){body{words}}}`,'owner')).body.data?.inboxItem).toEqual({body:{words:'PUBLIC SOURCE QUESTION'}});
  expect((await f.post('inbox.answer',{item:plain.id,answer:'yes'},'owner-plain-answer','owner')).status).toBe(403);
  expect(f.db.select().from(inbox).where(eq(inbox.id,plain.id)).get()?.state).toBe('waiting');
  expect(f.db.select().from(operationResults).where(eq(operationResults.id,'owner-plain-answer')).all()).toEqual([]);
  expect((await f.post('inbox.read',{item:question.inboxItem!},'read')).status).toBe(200);
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE ANSWER'},'answer')).status).toBe(200);
  const read = await f.query(`{inboxItem(id:"${question.inboxItem}"){read state body{words} answerText bodyKeepUntil answerKeepUntil}}`);
  expect(read.body.errors).toBeUndefined(); expect(read.body.data?.inboxItem).toMatchObject({read:true,state:'answered',body:{words:'PRIVATE QUESTION'},answerText:'PRIVATE ANSWER'});
  const durable = JSON.stringify([f.db.select().from(inbox).all(),f.db.select().from(operationResults).all()]);
  expect(durable).not.toContain('PRIVATE QUESTION'); expect(durable).not.toContain('PRIVATE ANSWER');
  f.root.writes.run(() => f.db.delete(sessions).where(eq(sessions.id,hash(f.credentials.alice.cookie))).run());
  expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE ANSWER'},'answer')).status).toBe(401);
});
it('rechecks current ownership after private encryption yields and commits no stale effect or receipt', async () => {
  const f = await fixture();
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'New conversation'},'open')).status).toBe(200);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.gate(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  const pending = f.post('comms.send',{thread:'th:pump',clientId:'message',words:'PRIVATE DELAYED'},'send');
  await waiting; f.root.writes.run(() => f.db.delete(memberAgents).run()); release();
  expect((await pending).status).toBe(403); expect(f.db.select().from(messages).all()).toEqual([]);
  expect(f.db.select().from(operationResults).where(eq(operationResults.id,'send')).all()).toEqual([]);
});
it('owns household-shortened expiry and daily history rollup, and removes its timer on close', async () => {
  const f = await fixture(undefined,Date.parse('2026-11-14T23:59:59Z'));
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'New conversation'},'open')).status).toBe(200);
  expect((await f.post('comms.send',{thread:'th:pump',clientId:'message',words:'PRIVATE EXPIRING'},'send')).status).toBe(200);
  f.root.writes.run(()=>{const at=new Date(f.clock.now()-2*86400000).toISOString();f.db.update(messages).set({at}).run();f.db.update(turns).set({at}).run();});
  expect(f.db.select().from(messages).get()?.words).not.toBeNull();
  f.root.writes.run(() => f.db.insert(household).values({commsDays:1}).run());
  f.clock.advance(0); expect(f.db.select().from(messages).get()?.words).toBeNull();
  // Age the retained metadata rather than running unrelated 30-second Runtime
  // sweeps for ninety virtual days. The actual next-midnight callback rolls up.
  f.root.writes.run(()=>{const at=new Date(f.clock.now()-91*86400000).toISOString();f.db.update(messages).set({at}).run();f.db.update(turns).set({at}).run();});
  f.clock.advance(1000);
  expect(f.db.select().from(turns).all()).toEqual([]);
  expect(f.client.prepare('SELECT messages FROM conversation_days').get()).toEqual({messages:1});
  await f.root.close(); f.client.close(); expect(() => f.clock.advance(100*86400000)).not.toThrow();
});

it('schedules ciphertext removal at a stored deadline between daily sweeps', async () => {
  const f = await fixture();
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'Pump'},'open')).status).toBe(200);
  expect((await f.post('comms.send',{thread:'th:pump',clientId:'one',words:'PRIVATE EARLY DEADLINE'},'send')).status).toBe(200);
  f.root.writes.run(() => f.db.update(messages).set({keepUntil:'2026-11-14T18:00:01Z'}).run());
  f.clock.advance(999); expect(f.db.select().from(messages).get()?.words).not.toBeNull();
  f.clock.advance(1); expect(f.db.select().from(messages).get()?.words).toBeNull();
});
it('unsubscribes and cancels the lifecycle timer before downstream query shutdown', async () => {
  const events: string[] = [], activeTimers = new Set<symbol>();
  const at = FakeClock.prototype.at, observe = DataWrites.prototype.observe, close = DataLive.prototype.close;
  vi.spyOn(FakeClock.prototype,'at').mockImplementation(function (this: FakeClock, time, fn) {
    const key = Symbol(); activeTimers.add(key);
    const cancel = at.call(this,time,()=>{activeTimers.delete(key);fn();});
    return () => { activeTimers.delete(key); events.push('timer-cancel'); cancel(); };
  });
  let activeObservers = 0;
  vi.spyOn(DataWrites.prototype,'observe').mockImplementation(function (this: DataWrites, callback) {
    activeObservers++; const stop = observe.call(this,callback);
    return () => { activeObservers--; events.push('observer-stop'); stop(); };
  });
  vi.spyOn(DataLive.prototype,'close').mockImplementation(function (this: DataLive) { events.push('data-close'); return close.call(this); });
  const f = await fixture(); expect(activeObservers).toBeGreaterThan(0); expect(activeTimers.size).toBeGreaterThan(0);
  await f.root.close();
  expect(activeObservers).toBe(0); expect(activeTimers.size).toBe(0);
  expect(events.indexOf('observer-stop')).toBeLessThan(events.indexOf('data-close'));
  expect(events.indexOf('timer-cancel')).toBeLessThan(events.indexOf('data-close'));
});

it('withholds private metadata when read authority changes while a sibling decrypt yields', async () => {
  const f=await fixture();
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'PRIVATE THREAD LABEL'},'open')).status).toBe(200);
  expect((await f.post('comms.send',{thread:'th:pump',clientId:'one',words:'PRIVATE WORDS'},'send')).status).toBe(200);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.openGate(()=>{entered();return new Promise<void>(resolve=>{release=resolve;});});
  const pending=f.query('{commsThread(id:"th:pump"){title} commsMessages(thread:"th:pump"){words}}','owner');
  await started; f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run()); release();
  const read=await pending;
  expect(read.response.status).toBe(503); expect(JSON.stringify(read.body)).not.toContain('PRIVATE THREAD LABEL'); expect(JSON.stringify(read.body)).not.toContain('PRIVATE WORDS');
  const retry=await f.query('{commsThread(id:"th:pump"){title} commsMessages(thread:"th:pump"){words}}','owner');
  expect(retry.response.status).toBe(200); expect(retry.body.data).toEqual({commsThread:null,commsMessages:[]});
});

it.each(['comms','inbox','answer','summary','search'].flatMap(kind => ['stored','household'].map(bound => ({kind,bound}))))('withholds $kind wording at the $bound deadline before the expiry timer runs', async ({kind,bound}) => {
  const now=Date.parse('2026-11-14T18:00:00Z');let time=now,advanced=false;
  const clockStep=new GraphQLScalarType({name:'DeadlineClockStep',serialize:()=>({toJSON(){advanced=true;time=now+1000;return 'public';}})});
  const f=await fixture({lateClock:{type:clockStep,resolve:()=>true}});
  vi.spyOn(f.clock,'now').mockImplementation(()=>time);
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'Pump'},'open')).status).toBe(200);
  const comms=f.root.services.comms!;
  const question=await comms.ask('th:pump','art','ask',{words:'PRIVATE FINAL WORDS',answers:'words'});
  if(kind==='answer') expect((await f.post('inbox.answer',{item:question.inboxItem!,answer:'words',words:'PRIVATE FINAL WORDS'},'answer')).status).toBe(200);
  if(kind==='summary') await comms.send({thread:'th:pump',kind:'reply',sender:'art',words:'PRIVATE FINAL WORDS'});
  f.root.writes.run(()=>{
    if(bound==='household') { f.db.insert(household).values({commsDays:1}).run(); f.db.update(messages).set({at:'2026-11-13T18:00:01Z',keepUntil:'2026-11-28T18:00:00Z'}).run(); }
    else f.db.update(messages).set({keepUntil:'2026-11-14T18:00:01Z'}).run();
  });
  const source=kind==='comms'?'{commsMessages(thread:"th:pump"){words}}'
    :kind==='summary'?'{recentConversations(agent:"art"){lastAnswer{words}}}'
    :kind==='search'?'{inboxItems(search:"PRIVATE FINAL WORDS"){id}}'
    :`{inboxItem(id:"${question.inboxItem}"){${kind==='answer'?'answerText':'body{words}'}}}`;
  const read=await f.query(source.slice(0,-1)+' lateClock}');expect(advanced).toBe(true);expect(read.response.status).toBe(503);
  expect(JSON.stringify(read.body)).not.toContain('PRIVATE FINAL WORDS');
  expect(f.db.select().from(messages).get()?.words).not.toBeNull();
  const retry=await f.query(source);expect(retry.response.status).toBe(200);expect(JSON.stringify(retry.body)).not.toContain('PRIVATE FINAL WORDS');
});

it('withdraws a returned but unread HTTP response after the owner loses read access', async () => {
  const f=await fixture();
  expect((await f.post('comms.open',{thread:'th:pump',agent:'art',title:'PRIVATE BUFFERED LABEL'},'open')).status).toBe(200);
  const response=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:`loom_ui=${f.credentials.owner.cookie}`},body:JSON.stringify({query:'{commsThread(id:"th:pump"){title}}'})});
  expect(response.status).toBe(200);
  f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
  await expect(response.text()).rejects.toThrow('Data access ended');
});
it('withdraws a returned but unread HTTP word response at its deadline without a data commit', async () => {
  const f=await fixture(),now=f.clock.now();let time=now;
  vi.spyOn(f.clock,'now').mockImplementation(()=>time);
  const comms=f.root.services.comms!,thread=comms.threads.open({member:'alice',agent:'art',title:'Pump'});
  await comms.send({thread:thread.id,kind:'reply',sender:'art',words:'PRIVATE BUFFERED WORDS'});
  f.root.writes.run(()=>f.db.update(messages).set({keepUntil:'2026-11-14T18:00:01Z'}).run());
  const response=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:`loom_ui=${f.credentials.alice.cookie}`},body:JSON.stringify({query:`{commsMessages(thread:"${thread.id}"){words}}`})});
  expect(response.status).toBe(200);time=now+1000;
  await expect(response.text()).rejects.toThrow('Data access ended');
});

it('publishes the existing Tempo volume capability independently of answer ownership',async()=>{
 const f=await fixture();
 const row=f.root.services.comms!.threads.conversations.send({toKind:'person',to:'alice',source:'approval',fromKind:'agent',agent:'art',member:'alice',words:'Timing request',answers:'yes-no'});
 const query=`{inboxItem(id:"${row.id}"){id canAnswer canSetVolume volume quietUntil}}`;
 expect((await f.query(query)).body).toMatchObject({data:{inboxItem:{canAnswer:false,canSetVolume:true,volume:'full',quietUntil:null}}});
 expect((await f.query(query,'owner')).body).toMatchObject({data:{inboxItem:{canSetVolume:true}}});
 expect((await f.query(query,'bob')).body.data?.inboxItem).toBeNull();
 expect((await f.post('inbox.volume',{item:row.id,volume:'mute'},'mute')).status).toBe(200);
 expect((await f.query(query)).body).toMatchObject({data:{inboxItem:{volume:'mute',quietUntil:'2026-11-21T18:00:00.000Z'}}});
 expect((await f.post('inbox.volume',{item:row.id,volume:'full'},'unauthorized','bob')).status).toBe(403);
 f.root.writes.run(()=>f.db.delete(sessions).run());
 expect((await f.query(query)).response.status).toBe(401);
});

it('filters conversation questions inside the current recipient mailbox before paging',async()=>{
 const f=await fixture(),mail=f.root.services.conversations;
 const a=mail.open({agent:'art',member:'alice',venue:'loom',place:'one',label:'One'}),b=mail.open({agent:'art',member:'alice',venue:'loom',place:'two',label:'Two'});
 const own=mail.send({conversation:a.id,toKind:'person',to:'alice',source:'approval',fromKind:'agent',words:'Own question'});
 const other=mail.send({conversation:a.id,toKind:'person',to:'owner',source:'approval',fromKind:'agent',words:'Other recipient'});
 mail.send({conversation:b.id,toKind:'person',to:'alice',source:'approval',fromKind:'agent',words:'Different thread'});
 const query=`{inboxItems(conversation:"${a.id}",source:"approval",limit:1){id}}`;
 expect((await f.query(query)).body).toMatchObject({data:{inboxItems:[{id:own.id}]}});
 expect((await f.query(query,'owner')).body).toMatchObject({data:{inboxItems:[{id:other.id}]}});
 expect((await f.query(query,'bob')).body).toMatchObject({data:{inboxItems:[]}});
});

it.each(['dim','mute'] as const)('real ordinary and encrypted answers lift dim but preserve mute (%s), while reading changes neither',async(level)=>{
 const f=await fixture();
 for(const privateQuestion of [false,true]){
  let id:string;
  if(privateQuestion){
   const thread=f.root.services.comms!.threads.open({member:'alice',agent:'art',title:'Private volume'});
   id=(await f.root.services.comms!.ask(thread.id,'art','private-volume',{words:'PRIVATE QUESTION',answers:'words'})).inboxItem!;
  }else id=f.root.services.conversations.send({toKind:'person',to:'alice',source:'thread',fromKind:'agent',member:'alice',words:'Ordinary question',answers:'words'}).id;
  f.root.services.tempo.volume.set({kind:'person',id:'alice'},id,level);
  const quiet=f.root.services.conversations.item(id).quietUntil;
  expect((await f.post('inbox.read',{item:id},'read-'+privateQuestion)).status).toBe(200);
  await f.query(`{inboxItem(id:"${id}"){body{words}}}`);
  expect(f.root.services.conversations.item(id)).toMatchObject({volume:level,quietUntil:quiet});
  expect((await f.post('inbox.answer',{item:id,answer:'words',words:privateQuestion?'PRIVATE ANSWER':'Ordinary answer'},'answer-'+privateQuestion)).status).toBe(200);
  expect(f.root.services.conversations.item(id)).toMatchObject({state:'answered',volume:level==='dim'?'full':'mute',quietUntil:level==='dim'?null:quiet});
 }
 expect(JSON.stringify(f.db.select().from(inbox).all())).not.toContain('PRIVATE');
});


it('bounds SQL for the full actual Inbox selection with two and ten private questions',async()=>{
  const f=await fixture(),comms=f.root.services.comms!;
  const thread=comms.threads.open({id:'th:growth',member:'alice',agent:'art',title:'Private growth fixture'});
  const variables={folder:'all',search:'',agent:null,offset:0,id:'',hasItem:false,onlyErrors:false};
  const read=async()=>{
    f.statements.length=0;
    const result=await f.query(inboxQuery,'alice',variables);
    expect(result.body.errors).toBeUndefined();
    expect(result.response.status).toBe(200);
    return {rows:result.body.data!.inboxItems as {body:{words:string}|null;refs:string[];read:boolean}[],count:f.statements.length};
  };
  let small=0,smallSearch=0,selected="";
  for(let n=0;n<10;n++){
    const ask=await comms.ask(thread.id,'art','growth-'+n,{words:'PRIVATE QUESTION '+n,answers:'words'});selected=ask.inboxItem!;
    f.db.insert(inboxRefs).values([{item:ask.inboxItem!,ref:'z-ref'},{item:ask.inboxItem!,ref:'a-ref'}]).run();
    f.db.insert(inboxReads).values({item:ask.inboxItem!,member:'alice',readAt:new Date(f.clock.now()).toISOString()}).run();
    if(n===1){const result=await read();expect(result.rows).toHaveLength(2);small=result.count;f.statements.length=0;const search=await f.query(inboxQuery,'alice',{...variables,search:'PRIVATE QUESTION'});expect(search.body.errors).toBeUndefined();expect(search.body.data!.inboxItems).toHaveLength(2);expect(JSON.stringify(search.body.data!.inboxItems)).toContain('PRIVATE QUESTION');smallSearch=f.statements.length;}
  }
  const large=await read();expect(large.rows).toHaveLength(10);
  expect(large.count).toBe(small);
  expect(large.count).toBe(18);
  expect(large.rows.every(row=>row.body?.words.startsWith('PRIVATE QUESTION'))).toBe(true);
  for(const row of large.rows){expect(row.refs).toEqual(['a-ref','z-ref']);expect(row.read).toBe(true);}
  f.statements.length=0;const search=await f.query(inboxQuery,'alice',{...variables,search:'PRIVATE QUESTION'});expect(search.body.errors).toBeUndefined();expect(f.statements.length).toBe(smallSearch);expect(search.body.data!.inboxItems).toHaveLength(10);expect((search.body.data!.inboxItems as {body:{words:string}}[]).every(row=>row.body.words.startsWith('PRIVATE QUESTION'))).toBe(true);
  const direct=await f.query(inboxQuery,'alice',{...variables,hasItem:true,id:selected});expect(direct.body.errors).toBeUndefined();expect(direct.body.data!.inboxItem).toMatchObject({body:{words:'PRIVATE QUESTION 9'}});
  let changed=false;
  f.openGate(async()=>{if(!changed){changed=true;f.root.writes.run(()=>f.db.update(inbox).set({member:'bob'}).where(eq(inbox.thread,thread.id)).run());}});
  const revoked=await f.query(inboxQuery,'alice',variables);
  expect(JSON.stringify(revoked.body)).not.toContain('PRIVATE QUESTION');
});


it('bounds SQL for the full actual Comms selection with two and ten retained messages',async()=>{
  const f=await fixture(),comms=f.root.services.comms!;
  const thread=comms.threads.open({id:'th:message-growth',member:'alice',agent:'art',title:'Private message growth'});
  const variables={archived:false,search:'',offset:0,id:thread.id,selected:true,before:null};
  const read=async()=>{
    f.statements.length=0;
    const result=await f.query(commsQuery,'alice',variables);
    expect(result.body.errors).toBeUndefined();expect(result.response.status).toBe(200);
    return {rows:result.body.data!.commsMessages as {words:string}[],count:f.statements.length};
  };
  let small=0;
  for(let n=0;n<10;n++){
    await comms.send({thread:thread.id,sender:'art',kind:'reply',words:'PRIVATE MESSAGE '+n});
    if(n===1){const result=await read();expect(result.rows).toHaveLength(2);small=result.count;}
  }
  const large=await read();expect(large.rows).toHaveLength(10);
  expect(large.count).toBe(small);expect(large.count).toBe(14);
  expect(large.rows.map(row=>row.words)).toEqual(Array.from({length:10},(_,n)=>'PRIVATE MESSAGE '+n));
  let changed=false;
  f.openGate(async()=>{if(!changed){changed=true;f.root.writes.run(()=>f.db.update(conversations).set({member:'bob'}).where(eq(conversations.id,thread.conversation)).run());}});
  const revoked=await f.query(commsQuery,'alice',variables);
  expect(JSON.stringify(revoked.body)).not.toContain('PRIVATE MESSAGE');
});
