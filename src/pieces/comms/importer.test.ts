import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../foundation.js';
import { loadKey } from './crypto.js';
import { importComms } from './importer.js';
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
 const t=JSON.parse((app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record);expect(t).toMatchObject({id:'th:old',readSeq:2,nextSeq:4});
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
 expect(app.db.prepare('SELECT * FROM comms_threads').all()).toEqual([]);expect(app.db.prepare('SELECT * FROM comms_messages').all()).toEqual([]);
 await expect(importComms(app.db,s.from,to,{interrupt:()=>{app.db.prepare('UPDATE comms_threads SET record=?').run('{}');}})).rejects.toThrow('comparison');
 expect(await importComms(app.db,s.from,to)).toMatchObject({imported:true});
});
