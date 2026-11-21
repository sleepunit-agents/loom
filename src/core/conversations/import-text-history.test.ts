import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { Threads } from './threads.js';
import { importTextHistory } from './import-text-history.js';

it('validates scope before opening an envelope, rolls back conflicts and keeps purged words erased',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'loom-text-history-')), path=join(dir,'source.db');
  const writer=new Database(path), archive=new Database(path,{readonly:true}), client=new Database(':memory:');
  const at='2026-11-20T00:00:00.000Z';
  try {
    const destination=createDataSchema(client);
    client.exec(`INSERT INTO agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES('fern','','','','drop','dot');
      INSERT INTO members(id,role,joined_at) VALUES('alex','member','${at}')`);
    const t=new Threads(destination,()=>at).open({member:'alex',agent:'fern',title:'Fixture'});
    writer.exec('CREATE TABLE comms_threads(id,conversation,agent,member,project); CREATE TABLE comms_messages(thread,seq,kind,sender,id,at,run,text,delivered)');
    writer.prepare('INSERT INTO comms_threads VALUES(?,?,?,?,null)').run(t.id,t.conversation,'fern','other');
    const add=writer.prepare("INSERT INTO comms_messages VALUES(?,?,'reply','fern',?,?,null,?,null)");
    const envelope=Buffer.from('fixture envelope');
    for(const n of [1,3])add.run(t.id,n,'reply'+n,at,envelope);
    let opens=0, current=at;
    const run=()=>importTextHistory({archive,household:archive,destination,sourceDays:2,github:'orchard',now:()=>current,
      key:{async open(){opens++;return 't-432 tools#3 note:garden/log';},async seal(){throw Error('unexpected');},hash(){throw Error('unexpected');}}});
    await expect(run()).rejects.toThrow(/thread differs/);
    expect(opens).toBe(0);
    writer.exec("UPDATE comms_threads SET member='alex'");
    expect(await run()).toEqual({total:2,inserted:2});
    expect(opens).toBe(2);
    expect(client.prepare('SELECT ref,message_seq FROM thread_refs ORDER BY ref').all()).toEqual(
      ['github:orchard/tools#3','note:garden/log','t-432'].map(ref=>({ref,message_seq:3})));

    client.exec("DELETE FROM messages WHERE seq=1; UPDATE messages SET sender='other' WHERE seq=3");
    await expect(run()).rejects.toThrow(/Conflicting/);
    expect(client.prepare('SELECT seq FROM messages').all()).toEqual([{seq:3}]);
    client.exec("UPDATE messages SET sender='fern',words=NULL WHERE seq=3");
    expect(await run()).toEqual({total:2,inserted:1});
    expect(client.prepare('SELECT seq,words FROM messages ORDER BY seq').all()).toEqual([{seq:1,words:envelope},{seq:3,words:null}]);
    current='2026-11-22T00:00:00.000Z';
    const before=opens;
    expect(await run()).toEqual({total:2,inserted:0});
    expect(opens).toBe(before);
    writer.exec('CREATE TABLE comms_refs(thread,ref,seq,pos,at)');
    const index=writer.prepare('INSERT INTO comms_refs VALUES(?,?,?,?,?)');
    index.run(t.id,'t-123',1,0,at);
    index.run(t.id,'github:t-123/tools#7',1,1,at);
    index.run(t.id,'t-999',99,0,at);
    await expect(run()).rejects.toThrow(/archived thread reference/);
    expect(client.prepare("SELECT ref FROM thread_refs WHERE ref='t-123'").get()).toBeUndefined();
    writer.exec('DELETE FROM comms_refs WHERE seq=99');
    await run();
    expect(client.prepare("SELECT message_seq FROM thread_refs WHERE ref='github:t-123/tools#7'").get()).toEqual({message_seq:1});
    expect(client.prepare("SELECT message_seq FROM thread_refs WHERE ref='t-123'").get()).toEqual({message_seq:1});

    expect(client.prepare('SELECT seq,words FROM messages ORDER BY seq').all()).toEqual([{seq:1,words:null},{seq:3,words:null}]);
  } finally {
    client.close();archive.close();writer.close();rmSync(dir,{recursive:true,force:true});
  }
});

it('skips revoked words and references only when the pending deletion has a tombstone and no live thread', async () => {
  const dir = mkdtempSync(join(tmpdir(),'loom-interrupted-delete-')), path = join(dir,'source.db');
  const writer = new Database(path), archive = new Database(path,{readonly:true}), client = new Database(':memory:');
  const now = () => '2026-11-20T00:00:00.000Z';
  try {
    const destination = createDataSchema(client);
    writer.exec(`CREATE TABLE comms_delete_pending(id TEXT PRIMARY KEY); INSERT INTO comms_delete_pending VALUES ('gone');
      CREATE TABLE comms_deleted(id TEXT PRIMARY KEY);
      CREATE TABLE comms_threads(id,conversation,agent,member,project);
      CREATE TABLE comms_messages(thread,seq,kind,sender,id,at,run,text,delivered);
      INSERT INTO comms_messages VALUES ('gone',1,'message','alex','m','${now()}',null,X'ff',1);
      CREATE TABLE comms_refs(thread,ref,seq,pos,at);
      INSERT INTO comms_refs VALUES ('gone','t-123',1,0,'${now()}')`);
    const badKey = () => { throw Error('Revoked words were opened'); };
    const run = () => importTextHistory({archive,household:archive,destination,sourceDays:2,now,key:{open:badKey,seal:badKey,hash:badKey}});
    await expect(run()).rejects.toThrow(/Pending thread deletion/);
    writer.exec("INSERT INTO comms_deleted VALUES ('gone'); INSERT INTO comms_threads VALUES ('gone','cv','fern','alex',null)");
    await expect(run()).rejects.toThrow(/Pending thread deletion/);
    writer.exec('DELETE FROM comms_threads');
    expect(await run()).toEqual({total:0,inserted:0});
    expect(client.prepare('SELECT * FROM thread_refs').all()).toEqual([]);
    expect(client.prepare('SELECT * FROM messages').all()).toEqual([]);
  } finally { archive.close();writer.close();client.close();rmSync(dir,{recursive:true,force:true}); }
});
