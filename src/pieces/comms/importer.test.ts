import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../foundation.js';
import { loadKey } from './crypto.js';
import { importComms } from './importer.js';
import { installComms } from './index.js';
import { messageView, type Message } from '../../../web/src/pieces/comms/message.js';
import { FakeClock } from '../../core/index.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function home(){const path=mkdtempSync(join(tmpdir(),'comms-import-'));cleanup.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
async function source(){
 const from=home(),key=await loadKey(from);const household=new Database(join(from,'household.db'));cleanup.push(()=>household.close());
 household.exec('CREATE TABLE comms_threads(id,agent,member,conversation,title,titled_by,project,pinned,archived,opened,last,read_seq,first_id,first_hash,stop,working_since); CREATE TABLE comms_deleted(id,member,agent,conversation,at)');
 household.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('th:old','art','jonathan','cv-old','Title','member','pond',0,null,'2026-11-12T01:00:00Z','2026-11-12T01:01:00Z',2,'first','old-hash',0,null);
 const db=new Database(join(from,'comms.db'));cleanup.push(()=>db.close());
 db.exec('CREATE TABLE comms_messages(thread,seq,at,kind,sender,id,hash,text,card_json,run,delivered,step); CREATE TABLE comms_asks(thread,ref,approval,raised,seen,words,answer_json)');
 const words=await key.seal('older private words'),step=await key.seal(JSON.stringify({body:'private output'}));
 db.prepare('INSERT INTO comms_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('th:old',1,'2026-11-12T01:00:00Z','message','jonathan','first','old-hash',words,null,null,1,null);
 db.prepare('INSERT INTO comms_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('th:old',2,'2026-11-12T01:01:00Z','card','art','step','hash',await key.seal('step label'),'{"tool":"shell","state":"done"}','run',null,step);
 db.prepare('INSERT INTO comms_asks VALUES (?,?,?,?,?,?,?)').run('th:old','a-one',null,'2026-11-12T01:02:00Z','2026-11-12T01:02:00Z',await key.seal('{"ask":"Private ask?"}'),null);
 return {from,key,db,words};
}
it('copies ciphertext byte-for-byte with the same key, preserves ids and read marks, is repeatable and refuses changed sources',async()=>{
 const s=await source(),to=home();copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));const app=createFoundation({home:to});cleanup.push(()=>app.close());
 const result=await importComms(app.db,s.from,to);expect(result).toMatchObject({imported:true,rekeyed:false,threads:1,messages:2,asks:1});
 const row=app.db.prepare('SELECT * FROM comms_messages WHERE seq=1').get() as {words:Buffer};expect(row.words).toEqual(s.words);
 const t=JSON.parse((app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record);expect(t).toMatchObject({id:'th:old',readSeq:2,nextSeq:4,firstHash:'old-hash'});
 const imported=app.db.prepare('SELECT hash,record FROM comms_messages ORDER BY seq').all() as {hash:string;record:string}[];expect(imported[0].hash).toBe('old-hash');expect(JSON.parse(imported[2].record).seen).toBe('2026-11-12T01:02:00Z');
 expect(await importComms(app.db,s.from,to)).toMatchObject({imported:false});
 s.db.prepare('UPDATE comms_messages SET sender=? WHERE seq=1').run('changed');await expect(importComms(app.db,s.from,to)).rejects.toThrow('different');
});
it('rekeys messages, asks and work details in memory when the key differs and never modifies old rows',async()=>{
 const s=await source(),to=home(),key=await loadKey(to),app=createFoundation({home:to});cleanup.push(()=>app.close());
 expect(await importComms(app.db,s.from,to)).toMatchObject({rekeyed:true});
 const rows=app.db.prepare('SELECT * FROM comms_messages ORDER BY seq').all() as {words:Buffer;record:string}[];
 expect(rows[0].words).not.toEqual(s.words);expect(await key.open(rows[0].words)).toBe('older private words');
 expect(await key.open(Buffer.from(JSON.parse(rows[1].record).stepCipher,'base64'))).toContain('private output');
 expect(await key.open(rows[2].words)).toContain('Private ask?');
 expect((s.db.prepare('SELECT text FROM comms_messages WHERE seq=1').get() as {text:Buffer}).text).toEqual(s.words);
});
it('rolls an interrupted or corrupt import back and can retry the untouched source',async()=>{
 const s=await source(),to=home();await loadKey(to);const app=createFoundation({home:to});cleanup.push(()=>app.close());
 await expect(importComms(app.db,s.from,to,{interrupt:()=>{throw new Error('power loss');}})).rejects.toThrow('power loss');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'comms_%'").all()).toEqual([]);
 await expect(importComms(app.db,s.from,to,{interrupt:()=>{app.db.prepare('UPDATE comms_threads SET record=?').run('{}');}})).rejects.toThrow('comparison');
 expect(await importComms(app.db,s.from,to)).toMatchObject({imported:true});
});
it('refuses a nonempty destination without changing it',async()=>{
 const s=await source(),to=home();await loadKey(to);const app=createFoundation({home:to});cleanup.push(()=>app.close());
 await importComms(app.db,s.from,to);app.db.prepare("DELETE FROM comms_meta WHERE key='source-checksum'").run();
 const before=app.db.prepare('SELECT * FROM comms_messages').all();await expect(importComms(app.db,s.from,to)).rejects.toThrow('empty');expect(app.db.prepare('SELECT * FROM comms_messages').all()).toEqual(before);
});
it('the real CLI refuses a held daemon lock before creating a key and its results never contain compared words',async()=>{
 const {migrateComms}=await import('../../cli/migrate-comms.js');const {acquireHttpLock}=await import('../../transport/http-lock.js');const {Readable}=await import('node:stream');const {existsSync}=await import('node:fs');
 const s=await source(),to=home(),release=acquireHttpLock(to);let output='',error='';const io={stdout:(v:string)=>{output+=v;},stderr:(v:string)=>{error+=v;},stdin:Readable.from([]),stdinIsTTY:false,env:{}};
 expect(await migrateComms(['--home',to,'--from',s.from],io)).toBe(1);expect(existsSync(join(to,'comms.key'))).toBe(false);release();
 expect(await migrateComms(['--home',to,'--from',s.from],io)).toBe(0);expect(output).toContain('checksum');expect(output+error).not.toContain('older private words');expect(output+error).not.toContain('private output');
});

for(const sameKey of [true,false])for(const pointer of ['ref:t-123456789','page:tasks/private-item'])it(`imports private attachment associations (${sameKey?'same key':'rekey'}, ${pointer.split(':')[0]})`,async()=>{
 const s=await source(),to=home();
 const household=new Database(join(s.from,'household.db'));
 try{household.exec('ALTER TABLE comms_threads ADD COLUMN about_key TEXT');household.prepare('UPDATE comms_threads SET about_key=?').run(pointer);}finally{household.close();}
 if(sameKey)copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));
 const key=await loadKey(to),clock=new FakeClock(Date.parse('2026-11-12T02:00:00Z'));
 const app=createFoundation({home:to,clock});cleanup.push(()=>app.close());
 await importComms(app.db,s.from,to);
 const stored=(app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record;
 expect(stored).not.toContain(pointer);
 expect(JSON.parse(stored)).not.toHaveProperty('about_key');
 expect(JSON.parse(stored).aboutHash).toBe(key.hash(`about\0${pointer}`));
 const comms=installComms({...app,clock,key,sharing:()=>({members:{jonathan:{agents:['art']},other:{agents:['art']}},projects:{},services:{}}),runtime:{deliver:async()=>{},end:async()=>{}},hold:async f=>f(),attention:{answer:()=>({ok:true,value:{}})}});
 cleanup.push(()=>{void comms.close();});
 const input={agent:'art',...(pointer.startsWith('ref:')?{ref:pointer.slice(4)}:{page:pointer.slice(5)})};
 expect(await app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.about',input,undefined,true)).toMatchObject({ok:true,value:{threads:[{id:'th:old',title:'Title'}]}});
 expect(await app.operations.callAsync('socket',{kind:'member',id:'other'},'comms.about',input,undefined,true)).toMatchObject({ok:true,value:{threads:[]}});
 expect(await importComms(app.db,s.from,to)).toMatchObject({imported:false});
});

for(const sameKey of [true,false])it(`seals imported work and answer metadata and expires it with words (${sameKey?'same key':'rekey'})`,async()=>{
 const s=await source(),to=home();
 if(sameKey)copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));
 const key=await loadKey(to),clock=new FakeClock(Date.parse('2026-11-12T02:00:00Z'));
 const app=createFoundation({home:to,clock});cleanup.push(()=>app.close());
 s.db.prepare('UPDATE comms_messages SET card_json=?,run=? WHERE seq=2').run(JSON.stringify({tool:'private tool',state:'done',label:'private card'}),'private run');
 s.db.prepare('UPDATE comms_asks SET answer_json=?').run(JSON.stringify({text:'private answer'}));
 await importComms(app.db,s.from,to);
 const stored=app.db.prepare('SELECT * FROM comms_messages ORDER BY seq').all() as {words:Buffer;record:string}[];
 const serialized=JSON.stringify(stored);
 for(const secret of ['private tool','private card','private run','private answer','private output'])expect(serialized).not.toContain(secret);
 for(let n=0;n<2;n++){
  const old=s.db.prepare('SELECT text,step FROM comms_messages WHERE seq=?').get(n+1) as {text:Buffer;step:Buffer|null};
  if(sameKey){expect(stored[n].words).toEqual(old.text);if(old.step)expect(Buffer.from(JSON.parse(stored[n].record).stepCipher,'base64')).toEqual(old.step);}
 }
 const comms=installComms({...app,clock,key,sharing:()=>({members:{jonathan:{agents:['art']}},projects:{},services:{}}),runtime:{deliver:async()=>{},end:async()=>{}},hold:async f=>f(),attention:{answer:()=>({ok:true,value:{}})}});
 cleanup.push(()=>{void comms.close();});
 const messages=()=>app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.messages',{thread:'th:old'},undefined,true);
 expect(await app.operations.callAsync('socket',{kind:'member',id:'other'},'comms.messages',{thread:'th:old'},undefined,true)).toMatchObject({code:'denied'});
 const result=await messages();expect(result.ok).toBe(true);
 if(!result.ok)throw new Error('read failed');
 expect((result.value as unknown[])[1]).toMatchObject({text:'step label',card:{tool:'private tool',label:'private card'},run:'private run',step:{body:'private output'}});
 expect((result.value as unknown[])[2]).toMatchObject({ask:{ask:'Private ask?'},answer:{text:'private answer'}});
 expect(JSON.stringify(result)).not.toContain('Cipher');
 const views=(result.value as Message[]).map(messageView);
 expect(views[1]).toMatchObject({text:'step label',tool:'private tool',state:'done',step:{body:'private output'}});
 expect(views[2].ask).toMatchObject({question:'Private ask?',answered:true,canAnswer:false});
 clock.advance(14*86400_000);
 const expiredResult=await messages();
 if(!expiredResult.ok)throw new Error('expired read failed');
 for(const message of expiredResult.value as Message[])expect(messageView(message)).toEqual({text:null,tool:undefined,state:undefined,step:undefined,ask:undefined});
 const expired=JSON.stringify(expiredResult);
 for(const secret of ['private tool','private card','private run','private answer','private output','Private ask?','step label'])expect(expired).not.toContain(secret);
 for(const row of app.db.prepare('SELECT words,record FROM comms_messages').all() as {words:Buffer|null;record:string}[]){expect(row.words).toBeNull();expect(row.record).not.toContain('Cipher');}
});

for(const sameKey of [true,false])it(`preserves conversation steps without plaintext work metadata (${sameKey?'same key':'rekey'})`,async()=>{
 const s=await source(),to=home();
 if(sameKey)copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));
 const key=await loadKey(to),clock=new FakeClock(Date.parse('2026-11-12T02:00:00Z'));
 const app=createFoundation({home:to,clock});cleanup.push(()=>app.close());
 s.db.exec('CREATE TABLE conversation_steps(seq INTEGER PRIMARY KEY,conversation,run,id,at,tool,state,words,UNIQUE(conversation,run,id))');
 const words=await s.key.seal('private bridge step');
 s.db.prepare('INSERT INTO conversation_steps VALUES (?,?,?,?,?,?,?,?)').run(17,'cv-bridge','private-run','step-1','2026-11-12T01:03:00Z','private-tool','done',words);
 s.db.prepare('INSERT INTO conversation_steps VALUES (?,?,?,?,?,?,?,?)').run(23,'cv-other','private-run','step-1','2026-11-12T01:04:00Z','private-tool','failed',null);
 await expect(importComms(app.db,s.from,to,{interrupt:()=>{throw new Error('power loss');}})).rejects.toThrow('power loss');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'comms_%'").all()).toEqual([]);
 await expect(importComms(app.db,s.from,to,{interrupt:()=>{app.db.prepare('UPDATE comms_conversation_steps SET conversation=? WHERE seq=17').run('replacement');}})).rejects.toThrow('comparison');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'comms_%'").all()).toEqual([]);
 expect(await importComms(app.db,s.from,to)).toMatchObject({imported:true,steps:2});
 const rows=app.db.prepare('SELECT * FROM comms_conversation_steps ORDER BY seq').all() as {seq:number;conversation:string;at:number;words:Buffer|null;record:Buffer|null}[];
 expect(rows.map(r=>[r.seq,r.conversation,r.at])).toEqual([[17,'cv-bridge',Date.parse('2026-11-12T01:03:00Z')],[23,'cv-other',Date.parse('2026-11-12T01:04:00Z')]]);
 expect(await key.open(rows[0].words!)).toBe('private bridge step');
 expect(JSON.parse(await key.open(rows[0].record!))).toEqual({run:'private-run',id:'step-1',tool:'private-tool',state:'done'});
 if(sameKey)expect(rows[0].words).toEqual(words);else expect(rows[0].words).not.toEqual(words);
 expect(rows[1].words).toBeNull();expect(rows[1].record).toBeNull();
 for(const secret of ['private bridge step','private-run','private-tool','step-1'])expect(JSON.stringify(rows)).not.toContain(secret);
 expect((s.db.prepare('SELECT words FROM conversation_steps WHERE seq=17').get() as {words:Buffer}).words).toEqual(words);
 expect(await importComms(app.db,s.from,to)).toMatchObject({imported:false,steps:2});
 s.db.prepare("UPDATE conversation_steps SET state='failed' WHERE seq=17").run();
 await expect(importComms(app.db,s.from,to)).rejects.toThrow('different');
 const comms=installComms({...app,clock,key,days:1,sharing:()=>({members:{jonathan:{owner:false,agents:['art']}},projects:{},services:{}}),conversation:id=>id==='cv-bridge'?{agent:'art',venue:'discord',version:'source-1'}:undefined,runtime:{deliver:async()=>{},end:async()=>{}},hold:async f=>f(),attention:{answer:()=>({ok:true,value:{}})}});
 cleanup.push(()=>{void comms.close();});
 const page=await app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.conversationSteps',{conversation:'cv-bridge'},undefined,true);
 expect(page).toMatchObject({ok:true,value:{steps:[{seq:17,conversation:'cv-bridge',text:'private bridge step',run:'private-run',tool:'private-tool',state:'done'}]}});
 clock.advance(Date.parse('2026-11-13T01:03:00Z')-clock.now()-1);
 expect((app.db.prepare('SELECT words FROM comms_conversation_steps WHERE seq=17').get() as {words:Buffer|null}).words).not.toBeNull();
 clock.advance(1);
 expect(app.db.prepare('SELECT words,record FROM comms_conversation_steps WHERE seq=17').get()).toEqual({words:null,record:null});
});


it('uses the supplied opener for both completed WAL backups without source mutations',async()=>{
 const s=await source(),snapshot=home(),to=home();
 const household=new Database(join(s.from,'household.db'));
 try {
  s.db.pragma('journal_mode = WAL');household.pragma('journal_mode = WAL');
  await s.db.backup(join(snapshot,'comms.db'));await household.backup(join(snapshot,'household.db'));
 } finally {household.close();}
 copyFileSync(join(s.from,'comms.key'),join(snapshot,'comms.key'));
 copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));
 const before=Object.fromEntries(readdirSync(snapshot).map(name=>[name,readFileSync(join(snapshot,name))]));
 expect(before['comms.db'][18]).toBe(2);expect(before['household.db'][18]).toBe(2);
 const {openSnapshotSqlite}=await import('../../cli/migration-sqlite.js');
 const opened:{path:string;db:Database.Database}[]=[];
 const open=(path:string)=>{const db=openSnapshotSqlite(path);opened.push({path,db});return db;};
 const app=createFoundation({home:to});cleanup.push(()=>app.close());
 expect(await importComms(app.db,snapshot,to,{},open)).toMatchObject({imported:true,threads:1,messages:2,asks:1});
 expect(opened.map(o=>o.path)).toEqual([join(snapshot,'comms.db'),join(snapshot,'household.db')]);
 expect(opened.every(o=>!o.db.open)).toBe(true);
 expect((app.db.prepare('SELECT words FROM comms_messages WHERE seq=1').get() as {words:Buffer}).words).toEqual(s.words);
 expect(Object.fromEntries(readdirSync(snapshot).map(name=>[name,readFileSync(join(snapshot,name))]))).toEqual(before);
});

it('closes supplied source handles on open and read failures and never falls back',async()=>{
 const s=await source(),to=home();copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));
 const app=createFoundation({home:to});cleanup.push(()=>app.close());
 for(const failOpen of [true,false]) {
  const opened:Database.Database[]=[];const calls:string[]=[];
  const open=(path:string)=>{
   calls.push(path);
   if(calls.length===2&&failOpen)throw Error('snapshot open failed');
   const db=new Database(path,{readonly:true,fileMustExist:true});opened.push(db);
   if(calls.length===2&&!failOpen)vi.spyOn(db,'prepare').mockImplementation(()=>{throw Error('snapshot read failed');});
   return db;
  };
  await expect(importComms(app.db,s.from,to,{},open)).rejects.toThrow();
  expect(calls).toEqual([join(s.from,'comms.db'),join(s.from,'household.db')]);
  expect(opened.every(db=>!db.open)).toBe(true);
  expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'comms_%'").all()).toEqual([]);
 }
});


it('keeps the default reader read-only and sees committed rows in live WAL',async()=>{
 const s=await source(),to=home();copyFileSync(join(s.from,'comms.key'),join(to,'comms.key'));
 const household=new Database(join(s.from,'household.db'));
 cleanup.push(()=>household.close());
 s.db.pragma('journal_mode = WAL');household.pragma('journal_mode = WAL');
 s.db.prepare('UPDATE comms_messages SET sender=? WHERE seq=1').run('wal-member');
 household.prepare('UPDATE comms_threads SET title=?').run('WAL title');
 expect(readFileSync(join(s.from,'comms.db-wal')).length).toBeGreaterThan(0);
 expect(readFileSync(join(s.from,'household.db-wal')).length).toBeGreaterThan(0);
 const seen=new Set<string>(),prepare=Database.prototype.prepare;
 const spy=vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,...args:Parameters<Database.Database['prepare']>){
  if(this.name===join(s.from,'comms.db')||this.name===join(s.from,'household.db')) {
   expect(this.readonly).toBe(true);seen.add(this.name);
   const table=this.name.endsWith('/comms.db')?'comms_messages':'comms_threads';
   expect(()=>prepare.call(this,`DELETE FROM ${table}`).run()).toThrow(/readonly/);
  }
  return prepare.apply(this,args);
 });
 try {
  const app=createFoundation({home:to});cleanup.push(()=>app.close());
  expect(await importComms(app.db,s.from,to)).toMatchObject({imported:true});
  expect(seen).toEqual(new Set([join(s.from,'comms.db'),join(s.from,'household.db')]));
  expect(JSON.parse((app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record).title).toBe('WAL title');
  expect(app.db.prepare('SELECT sender FROM comms_messages WHERE seq=1').get()).toEqual({sender:'wal-member'});
 } finally {spy.mockRestore();}
});
