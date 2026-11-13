import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import type { Comms } from './role.js';
import { installComms } from './index.js';
import { loadKey, type WordsKey } from './crypto.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const member: Viewer = { kind: 'member', id: 'jonathan' };
async function setup(wrap?: (key: WordsKey) => WordsKey, configured = true) {
 const home = mkdtempSync(join(tmpdir(), 'comms-steps-'));
 const clock = new FakeClock(), base = await loadKey(home);
 let sharing: Sharing = { members: { jonathan: { owner: false, agents: ['art'] }, owner: { owner: true, agents: [] }, other: { owner: false, agents: [] } }, projects: {}, services: {} };
 const conversations = new Map([['cv-public', { agent: 'art', venue: 'discord', version: 'original' }]]);
 const key = wrap?.(base) ?? base;
 let role: Comms;
 let close: () => Promise<void> = async () => {};
 const app = await startLoom({ home, clock, authenticate: req => ({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']==='yes',valid:()=>true}), install: a => {
  const comms = installComms({ ...a, clock, key, days: 1, sharing: () => sharing,
   runtime: { deliver: async () => {}, end: async () => {} }, hold: async f => f(), attention: { answer: () => ({ ok: true, value: {} }) },
   ...{ conversation: configured ? (id: string) => conversations.get(id) : undefined },
  }); role = comms; close = () => comms.close();
 } });
 cleanups.push(async () => { await close(); await app.close(); rmSync(home, { recursive: true, force: true }); });
 const seed = async (seq: number, conversation = 'cv-public', at = clock.now()) => {
  app.db.prepare('INSERT INTO comms_conversation_steps VALUES (?,?,?,?,?)').run(seq, conversation, at,
   await base.seal(`private label ${seq}`), await base.seal(JSON.stringify({ run: 'private-run', id: `card-${seq}`, tool: 'Shell', state: 'done', body: 'must never be exposed' })));
 };
 const read = (input: unknown = { conversation: 'cv-public' }, viewer = member, window = true, valid = () => true) => app.operations.callAsync('socket', viewer, 'comms.conversationSteps', input, undefined, window, valid);
 return { app, clock, conversations, base, read, seed, writer: (binding: Parameters<Comms['conversationWriter']>[0]) => role.conversationWriter(binding), close: () => close(), revoke: () => { sharing = { ...sharing, members: { ...sharing.members, jonathan: { owner: false, agents: [] } } }; } };
}

it('reads retained encrypted conversation labels in pages of one hundred without persisting words', async () => {
 const s = await setup();
 for (let seq = 1; seq <= 103; seq++) await s.seed(seq);
 const first = await s.read();
 expect(first.ok).toBe(true);
 const steps = (first as { ok: true; value: { steps: { seq: number; text: string }[] } }).value.steps;
 expect(steps).toHaveLength(100); expect(steps[0]).toMatchObject({ seq: 4, text: 'private label 4', run: 'private-run', tool: 'Shell', state: 'done', keepUntil: s.clock.now() + 86400_000 });
 expect(steps[99].seq).toBe(103);
 const live=await liveSteps(s);expect(await live.next()).toMatchObject({records:[{id:'cv-public',steps}]});
 expect(await s.read({ conversation: 'cv-public', before: 4 })).toMatchObject({ ok: true, value: { steps: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] } });
 expect(JSON.stringify(first)).not.toContain('must never be exposed');
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_conversation_steps').all())).not.toContain('private');
 expect(s.app.db.prepare("SELECT 1 FROM core_operations WHERE name='comms.conversationSteps'").get()).toBeUndefined();
});

it('denies other members, tokens, other doors and missing conversation metadata before decrypting', async () => {
 let opens = 0;
 const s = await setup(k => ({ ...k, open: async words => { opens++; return k.open(words); } }));
 await s.seed(1);
 for (const viewer of [{ kind: 'member', id: 'other' }, { kind: 'agent', id: 'art' }, { kind: 'service', id: 'runtime' }, { kind: 'runner', id: 'box' }] as Viewer[])
  expect(await s.read(undefined, viewer)).toMatchObject({ ok: false, code: 'denied' });
 expect(await s.read(undefined, member, false)).toMatchObject({ ok: false, code: 'denied' });
 for (const door of ['http', 'direct', 'mcp'] as const)
  expect(await s.app.operations.callAsync(door, member, 'comms.conversationSteps', { conversation: 'cv-public' }, undefined, true)).toMatchObject({ ok: false, code: 'denied' });
 expect(await s.read({ conversation: 'missing' })).toMatchObject({ ok: false, code: 'denied' });
 const unbound = await setup(undefined, false); await unbound.seed(1);
 expect(await unbound.read()).toMatchObject({ ok: false, code: 'denied' });
 expect(opens).toBe(0);
 // Household owners retain the ordinary non-private conversation viewer gate.
 expect(await s.read(undefined, { kind: 'member', id: 'owner' })).toMatchObject({ ok: true });
});

for (const hidden of ['loom', 'comms', 'spawn', 'thread', 'deleted'] as const) it(`denies a private conversation even to household owners (${hidden})`, async () => {
 let opens = 0;
 const s = await setup(k => ({ ...k, open: async words => { opens++; return k.open(words); } })); await s.seed(1);
 if (hidden === 'loom' || hidden === 'comms' || hidden === 'spawn') s.conversations.get('cv-public')!.venue = hidden;
 else if (hidden === 'deleted') s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('private', 'other', 'art', 'cv-public', s.clock.now());
 else s.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('private', 'other', 'art', null, JSON.stringify({ conversation: 'cv-public' }));
 expect(await s.read()).toMatchObject({ ok: false, code: 'denied' });
 expect(await s.read(undefined, { kind: 'member', id: 'owner' })).toMatchObject({ ok: false, code: 'denied' });
 expect(opens).toBe(0);
});

for (const boundary of ['ownership', 'deleted', 'replaced', 'private', 'row', 'session', 'closed'] as const)
 it(`rejects a conversation page changed during decryption (${boundary})`, async () => {
  let release = () => {}, started = () => {}, valid = true;
  const waiting = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  const s = await setup(k => ({ ...k, open: async words => { expect(s.app.db.inTransaction).toBe(false); started(); await waiting; return k.open(words); } }));
  await s.seed(1);
  const result = s.read(undefined, member, true, () => valid); await began;
  if (boundary === 'ownership') s.revoke();
  if (boundary === 'deleted') s.conversations.delete('cv-public');
  if (boundary === 'replaced') s.conversations.get('cv-public')!.version = 'replacement';
  if (boundary === 'private') s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('private', 'other', 'art', 'cv-public', s.clock.now());
  if (boundary === 'row') s.app.db.prepare('UPDATE comms_conversation_steps SET record=? WHERE seq=1').run(await s.base.seal(JSON.stringify({ run: 'replacement' })));
  if (boundary === 'session') valid = false;
  if (boundary === 'closed') await s.close();
  release();
  const answer = await result;
  expect(answer).toMatchObject({ ok: false, code: boundary === 'row' ? 'conflict' : 'denied' });
  expect(JSON.stringify(answer)).not.toContain('private');
 });

it('strips every private field at the exact deadline after a later row decrypts, without relying on a sweep', async () => {
 let opens = 0, release = () => {}, started = () => {};
 const waiting = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
 const s = await setup(k => ({ ...k, open: async words => { if (++opens === 2) { started(); await waiting; } return k.open(words); } }));
 const now = s.clock.now(); await s.seed(1); await s.seed(2, 'cv-public', now + 1000);
 const page = s.read(); await began;
 s.clock.now = () => now + 86400_000; release();
 const answer = await page;
 expect(answer).toMatchObject({ ok: true, value: { steps: [
  { seq: 1, text: null }, { seq: 2, text: 'private label 2' },
 ] } });
 const steps = (answer as { ok: true; value: { steps: unknown[] } }).value.steps;
 expect(steps[0]).toEqual({ seq: 1, conversation: 'cv-public', at: now, keepUntil: now + 86400_000, text: null });
 // A fresh page excludes expired rows even while their ciphertext is still present.
 expect(s.app.db.prepare('SELECT words IS NOT NULL AS kept FROM comms_conversation_steps WHERE seq=1').get()).toEqual({ kept: 1 });
 expect(await s.read()).toMatchObject({ ok: true, value: { steps: [{ seq: 2 }] } });
});

it('returns routing facts for already swept words, bounds input, and hides crypto diagnostics', async () => {
 const s = await setup(); await s.seed(1); await s.seed(2, 'another-conversation');
 s.app.db.prepare('UPDATE comms_conversation_steps SET words=NULL,record=NULL WHERE seq=1').run();
 expect(await s.read()).toEqual({ ok: true, value: { steps: [{ seq: 1, conversation: 'cv-public', at: s.clock.now(), keepUntil: s.clock.now() + 86400_000, text: null }] } });
 for (const before of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) expect(await s.read({ conversation: 'cv-public', before })).toMatchObject({ ok: false, code: 'invalid' });
 expect(await s.read({ conversation: 'cv-public', limit: 1000 })).toMatchObject({ ok: false, code: 'invalid' });
 const broken = await setup(k => ({ ...k, open: async () => { throw new Error('private crypto diagnostics'); } })); await broken.seed(1);
 expect(await broken.read()).toEqual({ ok: false, code: 'unavailable', message: 'Operation could not complete' });
});

it('never projects body text cards from a non-thread step envelope', async () => {
 const s = await setup(); await s.seed(1);
 s.app.db.prepare('UPDATE comms_conversation_steps SET record=?').run(await s.base.seal(JSON.stringify({ run: 'private-run', id: 'body', tool: 'text', state: 'done' })));
 expect(await s.read()).toEqual({ ok: true, value: { steps: [{ seq: 1, conversation: 'cv-public', at: s.clock.now(), keepUntil: s.clock.now() + 86400_000, text: null }] } });
});

it('writes encrypted labels with stable run/card identity and preserves the original deadline', async () => {
 const s = await setup();
 const writer = s.writer({ agent: 'art', conversation: 'cv-public', run: 'new-run', startedAt: s.clock.now(), valid: () => true });
 const card = { id: 'card', tool: 'Shell', summary: 'private new label', state: 'running' as const };
 expect(await writer.write([card])).toEqual({ added: 1, updated: 0 });
 const original = s.app.db.prepare('SELECT seq,at FROM comms_conversation_steps').get();
 s.clock.advance(1000);
 expect(await writer.write([{ ...card, summary: 'private updated label', state: 'done' }])).toEqual({ added: 0, updated: 1 });
 expect(s.app.db.prepare('SELECT seq,at FROM comms_conversation_steps').get()).toEqual(original);
 expect(await s.read()).toMatchObject({ ok: true, value: { steps: [{ run: 'new-run', id: 'card', state: 'done', text: 'private updated label' }] } });
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_conversation_steps').all())).not.toMatch(/private|new-run|Shell/);
 expect(await writer.write([{ ...card, tool: 'text' }])).toEqual({ added: 0, updated: 0 });
});

for (const boundary of ['deleted', 'replaced', 'private', 'row', 'session', 'closed', 'deadline'] as const)
 it(`rejects activity changed while encryption is suspended (${boundary})`, async () => {
  let release = () => {}, started = () => {}, valid = true, block = false;
  const waiting = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  const s = await setup(k => ({ ...k, seal: async words => {
   expect(s.app.db.inTransaction).toBe(false);
   if (block) { started(); await waiting; } return k.seal(words);
  }, open: async words => { expect(s.app.db.inTransaction).toBe(false); return k.open(words); } }));
  const start = s.clock.now(); await s.seed(1);
  const writer = s.writer({agent:'art',conversation:'cv-public',run:'new-run',startedAt:start,valid:()=>valid});
  block = true;
  const write = writer.write([{id:'new-card',tool:'Shell',summary:'private activity',state:'done'}]);
  const rejected = expect(write).rejects.toMatchObject({code: boundary === 'row' ? 'conflict' : 'denied'});
  await began;
  if (boundary === 'deleted') s.conversations.delete('cv-public');
  if (boundary === 'replaced') s.conversations.get('cv-public')!.version = 'recreated';
  if (boundary === 'private') s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('private','other','art','cv-public',start);
  if (boundary === 'row') s.app.db.prepare('UPDATE comms_conversation_steps SET at=at+1').run();
  if (boundary === 'session') valid = false;
  if (boundary === 'closed') await s.close();
  if (boundary === 'deadline') s.clock.now = () => start + 86400_000;
  release(); await rejected;
  expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_conversation_steps').get()).toEqual({n:1});
 });

it('binds activity to its agent and house, snapshots capabilities and rejects invalid cards before crypto', async () => {
 let seals = 0;
 const s = await setup(k => ({...k,seal:async words=>{seals++;return k.seal(words);}}));
 const binding = {agent:'art',conversation:'cv-public',run:'run',startedAt:s.clock.now(),valid:()=>true,houseConversations:['cv-public']};
 const cards = [{id:'card',tool:'Shell',summary:'label',state:'done' as const}];
 for (const change of [{agent:'other'}, {houseConversations:[]}, {valid:()=>false}, {startedAt:s.clock.now()+1}, {run:''}])
  await expect(s.writer({...binding,...change}).write(cards)).rejects.toMatchObject({code:'denied'});
 for (const venue of ['loom','comms','spawn']) {
  s.conversations.get('cv-public')!.venue=venue;
  await expect(s.writer(binding).write(cards)).rejects.toMatchObject({code:'denied'});
 }
 s.conversations.get('cv-public')!.venue='discord';
 const writer=s.writer(binding);binding.agent='other';binding.houseConversations.length=0;
 for (const bad of [[],[...cards,...cards],[{...cards[0],summary:'bad\nlabel'}],[{...cards[0],body:'private body'}],Array(51).fill(cards[0])])
  await expect(writer.write(bad)).rejects.toThrow();
 expect(seals).toBe(0);
 expect(await writer.write(cards)).toEqual({added:1,updated:0});
 expect(s.app.operations.offered('mcp').some(o=>o.name.includes('conversationWriter'))).toBe(false);
});

it('caps each conversation at one thousand while preserving other conversations and global sequence order', async () => {
 const s=await setup();await s.seed(1);await s.seed(2,'another-conversation');
 s.app.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM numbers WHERE n<1002)
 INSERT INTO comms_conversation_steps SELECT n,'cv-public',at,words,record FROM numbers,comms_conversation_steps WHERE seq=1`).run();
 const writer=s.writer({agent:'art',conversation:'cv-public',run:'new-run',startedAt:s.clock.now(),valid:()=>true});
 expect(await writer.write([{id:'new-card',tool:'Shell',summary:'new label',state:'running'}])).toEqual({added:1,updated:0});
 expect(s.app.db.prepare("SELECT count(*) AS n,min(seq) AS first,max(seq) AS last FROM comms_conversation_steps WHERE conversation='cv-public'").get()).toEqual({n:1000,first:4,last:1003});
 expect(s.app.db.prepare("SELECT seq FROM comms_conversation_steps WHERE conversation='another-conversation'").get()).toEqual({seq:2});
});

it('keeps runs distinct and cannot restore swept activity or extend its original retention', async () => {
 const s=await setup(),start=s.clock.now();
 const binding={agent:'art',conversation:'cv-public',run:'first-run',startedAt:start,valid:()=>true};
 const cards=[{id:'card',tool:'Shell',summary:'private label',state:'running' as const}];
 const writer=s.writer(binding);await writer.write(cards);
 await s.writer({...binding,run:'second-run'}).write(cards);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_conversation_steps').get()).toEqual({n:2});
 s.clock.advance(86400_000);
 expect(s.app.db.prepare('SELECT words,record FROM comms_conversation_steps').all()).toEqual([{words:null,record:null},{words:null,record:null}]);
 await expect(writer.write(cards)).rejects.toMatchObject({code:'denied'});
 expect(await s.read()).toEqual({ok:true,value:{steps:[]}});
});

it('never lets an existing writer follow deletion and recreation between calls', async () => {
 const s=await setup();
 const writer=s.writer({agent:'art',conversation:'cv-public',run:'run',startedAt:s.clock.now(),valid:()=>true});
 const cards=[{id:'card',tool:'Shell',summary:'label',state:'done' as const}];
 await writer.write(cards);
 s.conversations.set('cv-public',{agent:'art',venue:'discord',version:'recreated'});
 await expect(writer.write(cards)).rejects.toMatchObject({code:'denied'});
});

it('commits no partial batch when encryption fails and fences concurrent updates', async () => {
 let fail=false,block=false,release=()=>{},started=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup(k=>({...k,seal:async words=>{
  if(fail&&words==='fail label')throw new Error('crypto unavailable');
  if(block&&words==='paused label'){started();await waiting;}
  return k.seal(words);
 }}));
 const writer=s.writer({agent:'art',conversation:'cv-public',run:'run',startedAt:s.clock.now(),valid:()=>true});
 const card={id:'card',tool:'Shell',summary:'label',state:'running' as const};
 fail=true;
 await expect(writer.write([card,{...card,id:'failed',summary:'fail label'}])).rejects.toThrow();
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_conversation_steps').get()).toEqual({n:0});
 fail=false;await writer.write([card]);block=true;
 const paused=writer.write([{...card,summary:'paused label'}]);
 const rejected=expect(paused).rejects.toMatchObject({code:'conflict'});await began;
 await writer.write([{...card,summary:'winning label',state:'done'}]);release();await rejected;
 expect(await s.read()).toMatchObject({ok:true,value:{steps:[{text:'winning label',state:'done'}]}});
});

async function liveSteps(s: Awaited<ReturnType<typeof setup>>, scope = 'cv-public', member = 'jonathan', window = true) {
 const ws = new WebSocket(s.app.url.replace('http:', 'ws:') + '/live', {headers:{'x-member':member,'x-window':window?'yes':'no'}});
 const queue: unknown[] = [], waiting: ((v: unknown)=>void)[] = [];
 ws.on('message', data => {const value=JSON.parse(data.toString());const next=waiting.shift();if(next)next(value);else queue.push(value);});
 await once(ws,'open');cleanups.push(async()=>{ws.terminate();});
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<unknown>(r=>waiting.push(r));
 ws.send(JSON.stringify({kind:'subscribe',type:'conversationSteps',scope}));
 return {ws,next};
}
it('streams bounded conversation labels, stable updates and exact expiry without leaking ciphertext', async()=>{
 const s=await setup(),c=await liveSteps(s);
 expect(await c.next()).toEqual({kind:'set',type:'conversationSteps',scope:'cv-public',records:[{id:'cv-public',steps:[]}]});
 const writer=s.writer({agent:'art',conversation:'cv-public',run:'run',startedAt:s.clock.now(),valid:()=>true});
 const card={id:'card',tool:'Shell',summary:'private live label',state:'running' as const};
 await writer.write([card]);
 expect(await c.next()).toMatchObject({records:[{id:'cv-public',steps:[{seq:1,text:'private live label',state:'running'}]}]});
 await writer.write([{...card,summary:'updated live label',state:'done'}]);
 const updated=await c.next();expect(updated).toMatchObject({records:[{steps:[{seq:1,text:'updated live label',state:'done'}]}]});
 expect(JSON.stringify(updated)).not.toMatch(/"(?:words|record|snapshot|Buffer)"/);
 s.clock.advance(86400_000);
 expect(await c.next()).toMatchObject({records:[{id:'cv-public',steps:[]}]});
});
it('denies bearer windows and removes streamed labels on ownership and conversation privacy changes',async()=>{
 const s=await setup();await s.seed(1);
 const token=await liveSteps(s,'cv-public','jonathan',false);
 expect(await token.next()).toMatchObject({ok:false,code:'denied'});
 const other=await liveSteps(s,'cv-public','other');expect(await other.next()).toMatchObject({records:[]});
 const missing=await liveSteps(s,'missing');expect(await missing.next()).toMatchObject({records:[]});
 const c=await liveSteps(s);expect(await c.next()).toMatchObject({records:[{steps:[{text:'private label 1'}]}]});
 s.revoke();s.app.live.changed([{type:'core.access',id:'sharing'}]);
 expect(await c.next()).toMatchObject({records:[]});
 const owner=await liveSteps(s,'cv-public','owner');expect(await owner.next()).toMatchObject({records:[{steps:[{text:'private label 1'}]}]});
 s.conversations.get('cv-public')!.venue='spawn';s.app.live.changed([{type:'conversation',id:'cv-public'}]);
 expect(await owner.next()).toMatchObject({records:[]});
});
for(const boundary of ['row','replacement','privacy','deadline'] as const)it(`rechecks streamed labels after suspended crypto (${boundary})`,async()=>{
 let block=true,release=()=>{},started=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup(k=>({...k,open:async words=>{expect(s.app.db.inTransaction).toBe(false);if(block){started();await waiting;}return k.open(words);}}));
 await s.seed(1);const at=s.clock.now(),c=await liveSteps(s);await began;
 if(boundary==='row')s.app.db.prepare('UPDATE comms_conversation_steps SET words=? WHERE seq=1').run(await s.base.seal('replacement label'));
 if(boundary==='replacement'){s.conversations.get('cv-public')!.version='new';s.app.db.prepare('DELETE FROM comms_conversation_steps').run();}
 if(boundary==='privacy')s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('private','other','art','cv-public',at);
 if(boundary==='deadline')s.clock.now=()=>at+86400_000;
 block=false;release();const result=await c.next();
 if(boundary==='row')expect(result).toMatchObject({records:[{steps:[{text:'replacement label'}]}]});
 else if(boundary==='privacy')expect(result).toMatchObject({records:[]});
 else expect(result).toMatchObject({records:[{steps:[]}]});
 expect(JSON.stringify(result)).not.toContain('private label 1');
});

it('never decrypts private Live subscriptions and closes with generic diagnostics on crypto failure',async()=>{
 let opens=0,broken=false;
 const s=await setup(k=>({...k,open:async words=>{opens++;if(broken)throw new Error('private crypto diagnostics');return k.open(words);}}));
 await s.seed(1);s.conversations.get('cv-public')!.venue='loom';
 const hidden=await liveSteps(s,'cv-public','owner');expect(await hidden.next()).toMatchObject({records:[]});expect(opens).toBe(0);
 s.conversations.get('cv-public')!.venue='discord';broken=true;
 const c=await liveSteps(s);expect(await c.next()).toEqual({ok:false,code:'unavailable',message:'Subscription could not load'});
});
