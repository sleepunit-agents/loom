import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { loadKey } from '../pieces/comms/crypto.js';
import * as commsImporter from '../pieces/comms/importer.js';
import * as foundation from '../core/app.js';
import { createSnapshot } from './migration-snapshot.js';
import { prepareMigrationPlan } from './migration-plan.js';
import { runMigrationAll } from './migration-all.js';
import { verifyMigration } from './migration-verify.js';
import { run } from './migrate.js';
const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const bytes=(path:string):unknown=>Object.fromEntries(readdirSync(path).sort().map(name=>{
 const p=join(path,name);return [name,statSync(p).isDirectory()?bytes(p):readFileSync(p).toString('base64')];
}));
async function fixture(layout='',snapshot=true){
 const dir=mkdtempSync(join(tmpdir(),'migration-comms-'));dirs.push(dir);
 const old=join(dir,'old'),source=join(old,layout),root=join(dir,'snapshot'),home=join(dir,'new');mkdirSync(source,{recursive:true});
 writeFileSync(join(old,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
 const key=await loadKey(source);writeFileSync(join(source,'comms.salt'),Buffer.alloc(32,7),{mode:0o600});
 const household=new Database(join(source,'household.db')),comms=new Database(join(source,'comms.db'));
 household.pragma('journal_mode=WAL');comms.pragma('journal_mode=WAL');
 try{
 household.exec('CREATE TABLE comms_threads(id,agent,member,conversation,title,titled_by,project,pinned,archived,opened,last,read_seq,first_id,first_hash,stop,working_since,about_key); CREATE TABLE comms_deleted(id,member,agent,conversation,at)');
 household.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('th:one','art','jonathan','cv-one','Title','member',null,1,null,1000,2000,2,'first','hash',0,null,'page:PRIVATE_ASSOCIATION');
 household.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted','jonathan','art','cv-deleted',900);
 comms.exec('CREATE TABLE comms_messages(thread,seq,at,kind,sender,id,hash,text,card_json,run,delivered,step); CREATE TABLE comms_asks(thread,ref,approval,raised,seen,words,answer_json); CREATE TABLE conversation_steps(seq,conversation,at,run,id,tool,state,words)');
 comms.prepare('INSERT INTO comms_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('th:one',2,2000,'message','jonathan','first','hash',await key.seal('PRIVATE_WORDS'),'{"label":"PRIVATE_CARD"}','PRIVATE_RUN',1,await key.seal('PRIVATE_STEP'));
 comms.prepare('INSERT INTO comms_asks VALUES (?,?,?,?,?,?,?)').run('th:one','ask-one','approval-one',3000,null,await key.seal('PRIVATE_ASK'),'{"text":"PRIVATE_ANSWER"}');
 comms.prepare('INSERT INTO conversation_steps VALUES (?,?,?,?,?,?,?,?)').run(17,'cv-bridge',4000,'PRIVATE_RUN','step-id','PRIVATE_TOOL','done',await key.seal('PRIVATE_BRIDGE'));
 comms.prepare('INSERT INTO conversation_steps VALUES (?,?,?,?,?,?,?,?)').run(23,'cv-expired',5000,'expired-run','expired-id','expired-tool','done',null);
 if(snapshot)await createSnapshot(old,root);
 }finally{comms.close();household.close();}
 return {dir,old,source,root,home,key,plan:snapshot?prepareMigrationPlan(root).plan:undefined};
}
for(const layout of ['', 'private/comms'])it(`collects every Comms input and independently verifies ${layout||'root'} WAL backups`,async()=>{
 const f=await fixture(layout),prefix=`home/${layout?layout+'/':''}`;
 expect(f.plan!.importers.comms).toEqual({paths:['comms.db','household.db','comms.key','comms.salt'].map(n=>prefix+n),options:{}});
 const before=bytes(f.root),sourceKey=readFileSync(join(f.source,'comms.key'));
 expect(readFileSync(join(f.root,prefix,'comms.db'))[18]).toBe(2);
 expect(await runMigrationAll(f.root,f.home)).toMatchObject({status:'complete',pieces:[{name:'household'},{name:'comms'}]});
 expect(readFileSync(join(f.home,'comms.key'))).toEqual(sourceKey);
 expect(statSync(join(f.home,'comms.key')).mode&0o777).toBe(0o600);
 const imported=bytes(f.home);
 vi.spyOn(commsImporter,'importComms').mockImplementation(()=>{throw Error('verifier invoked importer');});
 vi.spyOn(foundation,'createFoundation').mockImplementation(()=>{throw Error('verifier opened foundation');});
 expect(await verifyMigration(f.root,f.home)).toMatchObject({status:'verified',pieces:['household','comms'],differences:[]});
 expect(bytes(f.root)).toEqual(before);expect(bytes(f.home)).toEqual(imported);
});
it('refuses edited plans that omit any input, add hooks, omit Comms or substitute other files before destination creation',async()=>{
 const f=await fixture();
 for(const kind of ['omit','paths','salt','hook','replace','duplicate']){
  const plan=structuredClone(f.plan!);
  if(kind==='omit')delete plan.importers.comms;
  if(kind==='paths')plan.importers.comms.paths.splice(1,1);
  if(kind==='salt')plan.importers.comms.paths.pop();
  if(kind==='hook')plan.importers.comms.options={interrupt:'private'};
  if(kind==='replace')plan.importers.comms.paths[0]='home/household.json';
  if(kind==='duplicate')plan.importers.comms.paths.push(plan.importers.comms.paths[0]);
  await expect(runMigrationAll(f.root,f.home,plan)).rejects.toThrow();expect(existsSync(f.home)).toBe(false);
 }
});
for(const missing of ['household.db','comms.key','comms.db'])it(`refuses a Comms store missing ${missing}`,async()=>{
 const f=await fixture('',false);rmSync(join(f.source,missing));await createSnapshot(f.old,f.root);
 expect(()=>prepareMigrationPlan(f.root)).toThrow('Incomplete Comms');
});
it('refuses multiple Comms identities rather than selecting a store and dropping the rest',async()=>{
 const f=await fixture('',false);mkdirSync(join(f.old,'second'));const second=new Database(join(f.old,'second/comms.db'));second.exec('CREATE TABLE marker(id)');second.close();
 await createSnapshot(f.old,f.root);expect(()=>prepareMigrationPlan(f.root)).toThrow('Multiple Comms');
});
for(const change of ['thread','message','ask','step','expired','deleted','salt','checksum','extra','private','cipher'])it(`detects same-count ${change} corruption without returning private data`,async()=>{
 const f=await fixture();await runMigrationAll(f.root,f.home);
 const db=new Database(join(f.home,'loom.db'));
 try{
 if(change==='thread')db.exec("UPDATE comms_threads SET member='other'");
 if(change==='message')db.exec('UPDATE comms_messages SET seq=7 WHERE seq=2');
 if(change==='ask')db.exec("UPDATE comms_messages SET id='other' WHERE kind='ask'");
 if(change==='step')db.exec("UPDATE comms_conversation_steps SET conversation='other' WHERE seq=17");
 if(change==='expired')db.prepare('UPDATE comms_conversation_steps SET record=? WHERE seq=23').run(await f.key.seal('{}'));
 if(change==='deleted')db.exec('UPDATE comms_deleted SET at=901');
 if(change==='salt')db.exec("UPDATE comms_meta SET value='other' WHERE key='legacy-salt'");
 if(change==='checksum')db.exec("UPDATE comms_meta SET value='other' WHERE key='source-checksum'");
 if(change==='extra')db.exec("INSERT INTO comms_meta VALUES ('extra','private')");
 if(change==='cipher')db.prepare('UPDATE comms_messages SET words=? WHERE seq=2').run(await f.key.seal('PRIVATE_WORDS'));
 if(change==='private'){
 const row=db.prepare('SELECT record FROM comms_messages WHERE seq=2').get() as {record:string};const record=JSON.parse(row.record);
 record.privateCipher=(await f.key.seal('{"card":{"label":"PRIVATE_WRONG"},"run":"PRIVATE_RUN"}')).toString('base64');
 db.prepare('UPDATE comms_messages SET record=? WHERE seq=2').run(JSON.stringify(record));
 }
 }finally{db.close();}
 const before=bytes(f.home),report=await verifyMigration(f.root,f.home);
 expect(report.status).toBe('different');expect(report.differences.length).toBeGreaterThan(0);
 expect(JSON.stringify(report)).not.toContain('PRIVATE_');expect(bytes(f.home)).toEqual(before);
});
it('compares randomized metadata by semantics, while preserving original ciphertext exactly',async()=>{
 const f=await fixture();await runMigrationAll(f.root,f.home);
 const db=new Database(join(f.home,'loom.db'));
 try{
 const row=db.prepare('SELECT record FROM comms_messages WHERE seq=2').get() as {record:string};const record=JSON.parse(row.record);
 record.privateCipher=(await f.key.seal(await f.key.open(Buffer.from(record.privateCipher,'base64')))).toString('base64');
 db.prepare('UPDATE comms_messages SET record=? WHERE seq=2').run(JSON.stringify(record));
 }finally{db.close();}
 expect((await verifyMigration(f.root,f.home)).status).toBe('verified');
});
for(const layout of ['', 'private/comms'])it(`resumes committed Comms without a coordinator completion mark and recovers only its ${layout||'root'} source key`,async()=>{
 const f=await fixture(layout);
 await expect(runMigrationAll(f.root,f.home,undefined,{afterPiece:name=>{if(name==='comms')throw Error('death');}})).rejects.toThrow('death');
 expect(JSON.parse(readFileSync(join(f.home,'.migration-all.json'),'utf8')).completed).toEqual(['household']);
 expect((await verifyMigration(f.root,f.home)).status).toBe('different');
 const key=join(f.home,'comms.key'),temp=join(f.home,`.comms.key-import-${randomUUID()}`);linkSync(key,temp);
 expect((await runMigrationAll(f.root,f.home)).status).toBe('complete');expect(existsSync(temp)).toBe(false);
 expect(statSync(key).nlink).toBe(1);expect((await verifyMigration(f.root,f.home)).status).toBe('verified');
});
it('does not reveal corrupt private data through the public CLI',async()=>{
 const f=await fixture();await runMigrationAll(f.root,f.home);
 const db=new Database(join(f.home,'loom.db'));db.exec("UPDATE comms_messages SET record='PRIVATE_CORRUPT'");db.close();
 const io={stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
 expect(await run(['verify','--snapshot',f.root,'--home',f.home],io)).toBe(3);
 expect(io.stdout.mock.calls.flat().join('')+io.stderr.mock.calls.flat().join('')).not.toContain('PRIVATE_');
});

it('accepts absent optional salt/tables and refuses malformed required schemas before opening a destination',async()=>{
 const f=await fixture('',false);rmSync(join(f.source,'comms.salt'));
 const db=new Database(join(f.source,'comms.db'));db.exec('DROP TABLE comms_asks; DROP TABLE conversation_steps');db.close();
 await createSnapshot(f.old,f.root);expect(prepareMigrationPlan(f.root).plan.importers.comms.paths).toHaveLength(3);
 expect((await runMigrationAll(f.root,f.home)).status).toBe('complete');expect((await verifyMigration(f.root,f.home)).status).toBe('verified');
 const broken=await fixture('',false);const b=new Database(join(broken.source,'comms.db'));b.exec('ALTER TABLE comms_messages RENAME COLUMN text TO missing');b.close();
 await createSnapshot(broken.old,broken.root);await expect(runMigrationAll(broken.root,broken.home)).rejects.toThrow('Incomplete Comms');expect(existsSync(broken.home)).toBe(false);
});

for(const reject of [false,true])it(`holds the same read-only destination and daemon gate across actual Comms crypto ${reject?'rejection':'success'}`,async()=>{
 const f=await fixture();await runMigrationAll(f.root,f.home);
 const crypto=await import('../pieces/comms/crypto.js'),sqlite=await import('./migration-sqlite.js'),{acquireHttpLock}=await import('../transport/http-lock.js');
 const actual=crypto.wordsKey,openSnapshot=sqlite.openSnapshotSqlite;
 let resume!:()=>void,entered!:()=>void;
 const wait=new Promise<void>(resolve=>{resume=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 let first=true;
 vi.spyOn(crypto,'wordsKey').mockImplementation(identity=>{
  const key=actual(identity);return {...key,open:async blob=>{if(first){first=false;entered();await wait;if(reject)throw Error('PRIVATE_CRYPTO_FAILURE');}return key.open(blob);}};
 });
 const opened:Database.Database[]=[];
 vi.spyOn(sqlite,'openSnapshotSqlite').mockImplementation(path=>{const db=openSnapshot(path);if(path===join(f.home,'loom.db'))opened.push(db);return db;});
 const before=bytes(f.home);let settled=false;const pending=verifyMigration(f.root,f.home).then(report=>({report,error:undefined}),error=>({report:undefined,error})).finally(()=>{settled=true;});
 await started;
 try{expect(settled).toBe(false);expect(opened).toHaveLength(1);expect(opened[0].open).toBe(true);expect(opened[0].readonly).toBe(true);expect(()=>acquireHttpLock(f.home)).toThrow('already running');}
 finally{resume();await pending;}
 if(reject)expect((await pending).error).toBeInstanceOf(Error);else expect((await pending).report?.status).toBe('verified');expect(opened[0].open).toBe(false);expect(bytes(f.home)).toEqual(before);
});
