import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { installAttention } from './index.js';
import { importAttention } from './importer.js';
import { conversationId } from './conversations.js';
import { digestId } from './digests.js';
import { findingId } from './retention.js';
const dirs: string[] = [], closes: (() => Promise<void>)[] = [], sources: Database.Database[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const s of sources.splice(0)) s.close(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const sharing = () => ({ members: { alice: { owner:true,agents:['art','mark'] }, bob: { owner:true,agents:['art'] } }, projects: { loom: { members:['alice'], agents:['art'] } }, services:{} });
async function setup(install = false) {
  const dir = mkdtempSync(join(tmpdir(),'attention-import-')); dirs.push(dir);
  const app = await startLoom({ home:join(dir,'new'), clock:new FakeClock(), sharing, install: install ? a => installAttention(a.db,a.operations,a.live,sharing) : undefined }); closes.push(app.close);
  const path = join(dir,'old.db'), source = new Database(path); sources.push(source); source.pragma('journal_mode = WAL');
  source.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY,agent TEXT,venue TEXT,place TEXT,label TEXT,people_json TEXT,agents_json TEXT,started TEXT,last TEXT,last_seq INTEGER);
    CREATE TABLE conversation_turns(conversation TEXT,seq INTEGER,at TEXT,from_json TEXT,kind TEXT,run TEXT,latency_ms INTEGER,model TEXT,harness TEXT,outcome TEXT,writer TEXT,PRIMARY KEY(conversation,seq));
    CREATE TABLE conversation_days(conversation TEXT,day TEXT,counts_json TEXT,median_latency_ms INTEGER,outcomes_json TEXT,PRIMARY KEY(conversation,day));
    CREATE TABLE conversation_digests(id TEXT PRIMARY KEY,conversation TEXT,run TEXT,at TEXT,summary TEXT,asks_json TEXT,decisions_json TEXT,tasks_json TEXT,projects_json TEXT,needs_owner TEXT,needs_owner_href TEXT,needs_owner_json TEXT);
    CREATE TABLE conversation_needs_answers(digest TEXT PRIMARY KEY,conversation TEXT,verdict TEXT,by TEXT,at TEXT,reason TEXT);
    CREATE TABLE findings(id TEXT PRIMARY KEY,conversation TEXT,seq INTEGER,day TEXT,measure TEXT,score REAL,text TEXT,at TEXT,UNIQUE(conversation,day));
  `);
  const id = conversationId('art','session','fixture');
  source.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,'art','session','fixture','Desk','["alice"]','["mark"]','2026-01-01T00:00:00Z','2026-11-01T00:00:01Z',6);
  source.prepare('INSERT INTO conversation_days VALUES (?,?,?,?,?)').run(id,'2026-01-01','{"message":2,"reply":2}',125,'{"unknown":{"answered":2}}');
  source.prepare('INSERT INTO conversation_turns VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,5,'2026-11-01T00:00:00Z','{"kind":"person","slug":"alice"}','message',null,null,null,null,null,'runtime:shuttle');
  source.prepare('INSERT INTO conversation_turns VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,6,'2026-11-01T00:00:01Z','{"kind":"agent","id":"art"}','reply','r1',1000,'opus','claude-code','answered','agent:art');
  const digest = (run: string, at: string, ask: string | null = 'Continue?') => { const key=digestId(id,run); source.prepare('INSERT INTO conversation_digests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(key,id,run,at,`summary ${run}`,'["Authored ask"]','["Decision"]','["t-1"]','["loom"]',ask,null,null); return key; };
  const first = digest('r0','2026-10-01T00:00:00Z');
  const latest = digest('r1','2026-11-01T00:00:01Z');
  source.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?,?)').run(findingId(id,'2026-01-01'),id,2,'2026-01-01','helpfulness',4,'Useful.','2026-01-02T00:00:00Z');
  const scopes = { [id]: { member:'alice', project:'loom' } };
  const load = (table: string) => (app.db.prepare(`SELECT record FROM ${table} ORDER BY id`).all() as {record:string}[]).map(r => JSON.parse(r.record));
  return { app,path,source,id,digest,first,latest,scopes,load };
}
it('preserves ids, fields, held sequences, folded measures and inherited audience; repeats no-op',async () => {
  const f = await setup(); const before = f.source.serialize();
  const result=importAttention(f.app.db,[f.path],f.scopes);
  expect(result).toMatchObject({ok:true,imported:true,counts:{attention_conversations:1,attention_turns:2,attention_days:1,attention_digests:2,attention_asks:2,attention_findings:1}});
  expect(f.source.serialize()).toEqual(before);
  expect(f.load('attention_conversations')).toEqual([{id:f.id,agent:'art',venue:'session',place:'fixture',label:'Desk',people:['alice'],agents:['mark'],projects:['loom'],started:'2026-01-01T00:00:00.000Z',last:'2026-11-01T00:00:01.000Z',turns:6,member:'alice',project:'loom'}]);
  expect(f.load('attention_turns')[1]).toMatchObject({id:`${f.id}:6`,seq:6,latency_ms:1000,writer:{kind:'legacy',id:'agent:art'},model:'opus',harness:'claude-code',outcome:'answered'});
  expect(f.load('attention_days')[0]).toMatchObject({counts:{message:2,reply:2},median_latency_ms:125,outcomes:{unknown:{answered:2}}});
  expect(f.load('attention_findings')[0]).toMatchObject({id:findingId(f.id,'2026-01-01'),seq:2,score:4,text:'Useful.'});
  for(const table of ['attention_turns','attention_days','attention_digests','attention_asks','attention_findings']) for(const r of f.load(table)) expect(r).toMatchObject({agent:'art',member:'alice',project:'loom'});
  expect(f.load('attention_asks').find(a=>a.id===`${f.first}:1`)).toMatchObject({state:'resolved'});
  expect(f.load('attention_asks').find(a=>a.id===`${f.latest}:1`)).toMatchObject({state:'open',answers:'words'});
  expect(importAttention(f.app.db,[f.path],f.scopes)).toEqual({...result,imported:false});
  installAttention(f.app.db,f.app.operations,f.app.live,sharing);
  expect(f.app.operations.call('direct',{kind:'member',id:'bob'},'attention.conversation',{id:f.id})).toMatchObject({code:'denied'});
  const next = f.app.operations.call('direct',{kind:'member',id:'alice'},'attention.recordTurn',{agent:'art',...f.scopes[f.id],turn:{venue:'session',place:'fixture',at:'2026-11-02T00:00:00Z',kind:'message',from:{kind:'person',slug:'alice'}}},'next');
  expect(next).toMatchObject({ok:true,value:{seq:7}});
});
it.each(['done','dismissed','replied','yes','no','resolved'])('maps legacy %s without reply words and preserves answer provenance',async verdict => {
  const f=await setup();
  f.source.prepare('INSERT INTO conversation_needs_answers VALUES (?,?,?,?,?,?)').run(f.latest,f.id,verdict,'alice','2026-11-02T00:00:00Z',verdict==='resolved'?'task closed':null);
  importAttention(f.app.db,[f.path],f.scopes);
  const ask=f.load('attention_asks').find(a=>a.id===`${f.latest}:1`);
  if(verdict==='resolved') expect(ask).toMatchObject({state:'resolved',resolution:'task closed'});
  else expect(ask).toMatchObject({state:'answered',answer:{kind:verdict==='dismissed'?'dismiss':verdict,by:{kind:'member',id:'alice'},at:Date.parse('2026-11-02T00:00:00Z')}});
  expect(JSON.stringify(ask)).not.toContain('"text"');
  expect(f.load('attention_digests').find(d=>d.id===f.latest).legacyAnswer.verdict).toBe(verdict);
});
it('uses timestamp then rowid for latest; a null clears older asks and a stale same-run answer cannot close a rewrite',async () => {
  const f=await setup();
  f.source.prepare('INSERT INTO conversation_needs_answers VALUES (?,?,?,?,?,?)').run(f.latest,f.id,'yes','alice','2026-10-31T00:00:00Z',null);
  importAttention(f.app.db,[f.path],f.scopes);
  expect(f.load('attention_asks').find(a=>a.id===`${f.latest}:1`).state).toBe('open');
  expect(f.load('attention_digests').find(d=>d.id===f.latest).legacyAnswer.verdict).toBe('yes');
  const g=await setup(); g.digest('r2','2026-11-01T00:00:01Z',null); importAttention(g.app.db,[g.path],g.scopes);
  expect(g.load('attention_asks').every(a=>a.state==='resolved')).toBe(true);
});
it.each([false,true])('rolls back interruption including schema on previously installed=%s',async installed => {
  const f=await setup(installed); const before=f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'attention_%'").all();
  expect(()=>importAttention(f.app.db,[f.path],f.scopes,{interrupt:()=>{throw Error('power lost');}})).toThrow('power lost');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'attention_%'").all()).toEqual(before);
  if(installed) { expect(f.load('attention_conversations')).toEqual([]); expect(f.app.db.prepare('SELECT * FROM attention_import').all()).toEqual([]); }
  expect(importAttention(f.app.db,[f.path],f.scopes).imported).toBe(true);
});
it('rolls back ids, counts or content mismatch and can retry',async () => {
  const f=await setup();
  expect(()=>importAttention(f.app.db,[f.path],f.scopes,{interrupt:()=>{f.app.db.prepare("UPDATE attention_conversations SET record='{}'").run();}})).toThrow(/comparison failed/);
  expect(f.app.db.prepare("SELECT * FROM core_migrations WHERE piece='attention'").all()).toEqual([]);
  expect(importAttention(f.app.db,[f.path],f.scopes).imported).toBe(true);
});
it('refuses changed content, audiences, duplicate batch and nonempty destination',async () => {
  const f=await setup(); importAttention(f.app.db,[f.path],f.scopes);
  expect(()=>importAttention(f.app.db,[f.path],{[f.id]:{}})).toThrow(/different attention source/);
  f.source.prepare("UPDATE conversation_digests SET summary='changed' WHERE id=?").run(f.latest);
  expect(()=>importAttention(f.app.db,[f.path],f.scopes)).toThrow(/different attention source/);
  const g=await setup(true); g.app.db.prepare('INSERT INTO attention_statuses VALUES (?,?)').run('art','{}');
  expect(()=>importAttention(g.app.db,[g.path],g.scopes)).toThrow(/destination must be empty/);
  expect(()=>importAttention(g.app.db,[g.path,g.path],g.scopes)).toThrow(/duplicate/);
});
it('requires explicit audiences and rejects orphans, bad hashes and injected sender words before mutation',async () => {
  const f=await setup();
  expect(()=>importAttention(f.app.db,[f.path],{})).toThrow(/explicit audience/);
  f.source.prepare("UPDATE conversation_turns SET from_json='{" + '"kind":"person","slug":"alice","text":"delivered words"' + "}' WHERE seq=5").run();
  expect(()=>importAttention(f.app.db,[f.path],f.scopes)).toThrow();
  expect(f.app.db.prepare("SELECT * FROM core_migrations WHERE piece='attention'").all()).toEqual([]);
  f.source.prepare('DELETE FROM conversation_turns').run(); f.source.prepare('UPDATE conversations SET last_seq=4').run(); f.source.prepare("UPDATE findings SET conversation='cv-000000000000'").run();
  expect(()=>importAttention(f.app.db,[f.path],f.scopes)).toThrow(/orphan/);
});
it('reads a WAL-visible snapshot across all tables even when another connection commits mid-read',async () => {
  const f=await setup(); let ran=false;
  importAttention(f.app.db,[f.path],f.scopes,{afterSourceConversations:()=>{ran=true;f.source.prepare("UPDATE conversation_digests SET summary='later writer'").run();}});
  expect(ran).toBe(true); expect(f.load('attention_digests').map(d=>d.summary).sort()).toEqual(['summary r0','summary r1']);
  expect(()=>importAttention(f.app.db,[f.path],f.scopes)).toThrow(/different attention source/);
});
it('accepts older schemas without optional href/json, answers/reasons or findings',async () => {
  const f=await setup(); f.source.exec('DROP TABLE findings; DROP TABLE conversation_needs_answers; ALTER TABLE conversation_digests DROP COLUMN needs_owner_json; ALTER TABLE conversation_digests DROP COLUMN needs_owner_href;');
  expect(importAttention(f.app.db,[f.path],f.scopes)).toMatchObject({imported:true,counts:{attention_findings:0}});
});
it('imports a batch of agents atomically, independent of input order',async()=>{
  const f=await setup(),g=await setup();
  const other=conversationId('mark','session','fixture');
  g.source.exec('DELETE FROM conversation_digests; DELETE FROM conversation_turns; DELETE FROM conversation_days; DELETE FROM findings;');
  g.source.prepare('UPDATE conversations SET id=?,agent=?,last_seq=0').run(other,'mark');
  const scopes={...f.scopes,[other]:{member:'alice'}};
  const result=importAttention(f.app.db,[f.path,g.path],scopes);
  expect(result.counts.attention_conversations).toBe(2);
  expect(importAttention(f.app.db,[g.path,f.path],scopes)).toEqual({...result,imported:false});
});
it('retains stored structured questions, refs, answer modes, and pre-lint legacy wording',async()=>{
  const f=await setup(); const needs={ask:'Proceed with h-55?',why:'Historical wording',if_yes:'I continue.',if_no:'I stop.',answers:'yes-no',href:'https://example.org/change',refs:['a-01234567'],waits_on:{approval:'a-01234567'}};
  f.source.prepare('UPDATE conversation_digests SET needs_owner=?,needs_owner_json=? WHERE id=?').run(needs.ask,JSON.stringify(needs),f.latest);
  importAttention(f.app.db,[f.path],f.scopes);
  expect(f.load('attention_digests').find(d=>d.id===f.latest).needs_owner).toEqual(needs);
  expect(f.load('attention_asks').find(a=>a.id===`${f.latest}:1`)).toMatchObject({...needs,state:'open'});
});
it('rejects self-import even through a hardlink and keeps the source unmodified',async()=>{
  const f=await setup(); const before=f.source.serialize();
  const alias=f.path+'.alias'; linkSync(f.path,alias);
  expect(()=>importAttention(f.source,[alias],f.scopes)).toThrow(/source and destination must differ/);
  expect(f.source.serialize()).toEqual(before);
});
it('retains answers written before reason was added',async()=>{
  const f=await setup(); f.source.prepare('INSERT INTO conversation_needs_answers VALUES (?,?,?,?,?,?)').run(f.latest,f.id,'done','alice','2026-11-02T00:00:00Z',null);
  f.source.exec('ALTER TABLE conversation_needs_answers DROP COLUMN reason');
  importAttention(f.app.db,[f.path],f.scopes);
  expect(f.load('attention_asks').find(a=>a.id===`${f.latest}:1`)).toMatchObject({state:'answered',answer:{kind:'done'}});
});
it('preserves prototype-like model labels in folded outcomes',async()=>{
  const f=await setup();
  const outcomes=JSON.parse('{"__proto__":{"answered":1},"constructor":{"answered":1}}');
  f.source.prepare('UPDATE conversation_days SET outcomes_json=?').run(JSON.stringify(outcomes));
  importAttention(f.app.db,[f.path],f.scopes);
  expect(f.load('attention_days')[0].outcomes).toEqual(outcomes);
});
it.each([
  "UPDATE conversations SET id='cv-000000000000'",
  "UPDATE conversation_digests SET id='dg-000000000000' WHERE run='r1'",
  "UPDATE findings SET id='fd-000000000000'",
  "UPDATE conversation_days SET day='2026-11-01'",
  'UPDATE conversations SET last_seq=7',
  "UPDATE conversation_digests SET at='2026-02-30T00:00:00Z'",
  "UPDATE conversation_turns SET at='2026-02-30T00:00:00Z'",
  "UPDATE conversations SET started='2026-02-30T00:00:00Z'",
  "UPDATE findings SET at='2026-02-30T00:00:00Z'",
  "UPDATE conversation_digests SET needs_owner=NULL, needs_owner_json='{'",
])('rejects malformed source before any schema/record changes: %s',async sql=>{
  const f=await setup();f.source.exec(sql);
  expect(()=>importAttention(f.app.db,[f.path],f.scopes)).toThrow();
  expect(f.app.db.prepare("SELECT * FROM core_migrations WHERE piece='attention'").all()).toEqual([]);
});
it('repairs legacy lexical bounds from mixed timestamp precision and preserves original bounds',async()=>{
  const f=await setup();
  f.source.exec('DELETE FROM conversation_days; DELETE FROM findings;');
  f.source.prepare('UPDATE conversations SET started=?,last=?,last_seq=2').run('2026-11-01T00:00:00.100Z','2026-11-01T00:00:00Z');
  f.source.prepare('UPDATE conversation_turns SET seq=1,at=? WHERE seq=5').run('2026-11-01T00:00:00Z');
  f.source.prepare('UPDATE conversation_turns SET seq=2,at=? WHERE seq=6').run('2026-11-01T00:00:00.100Z');
  importAttention(f.app.db,[f.path],f.scopes);
  expect(f.load('attention_conversations')[0]).toMatchObject({started:'2026-11-01T00:00:00.000Z',last:'2026-11-01T00:00:00.100Z',legacyBounds:{started:'2026-11-01T00:00:00.100Z',last:'2026-11-01T00:00:00Z'}});
});
it('runtime digest reads preserve revision and chronological/rowid order after import',async()=>{
  const f=await setup(true);
  const tied=f.digest('r2','2026-11-01T00:00:01Z');
  importAttention(f.app.db,[f.path],f.scopes);
  const result=f.app.operations.call('direct',{kind:'member',id:'alice'},'attention.digests',{conversation:f.id});
  expect(result).toMatchObject({ok:true});if(!result.ok)throw Error('read refused');
  expect((result.value as {id:string;revision:number;order:number}[]).map(d=>[d.id,d.revision,d.order])).toEqual([[tied,1,3],[f.latest,1,2],[f.first,1,1]]);
});
