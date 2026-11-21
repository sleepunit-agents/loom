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
    const run=(clock=()=>current)=>importTextHistory({archive,household:archive,destination,sourceDays:2,github:'orchard',now:clock,
      key:{async open(){opens++;return 't-432 tools#3 note:garden/log';},async seal(){throw Error('unexpected');},hash(){throw Error('unexpected');}}});
    await expect(run()).rejects.toThrow(/thread differs/);
    expect(opens).toBe(0);
    writer.exec("UPDATE comms_threads SET member='alex'");
    client.exec('SAVEPOINT deadline');
    let ticks=0;
    await run(()=>++ticks<3?at:'2026-11-22T00:00:00.000Z');
    expect(client.prepare('SELECT seq,words FROM messages ORDER BY seq').all()).toEqual([{seq:1,words:null},{seq:3,words:null}]);
    client.exec('ROLLBACK TO deadline; RELEASE deadline');
    opens=0;
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

it('keeps tool state after expiry and cannot restore erased private details on retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-tool-history-'));
  const path = join(dir, 'source.db');
  const writer = new Database(path), archive = new Database(path, { readonly: true }), client = new Database(':memory:');
  let current = '2026-11-20T00:00:00.000Z';
  try {
    const destination = createDataSchema(client);
    client.exec(`INSERT INTO agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES('fern','','','','drop','dot');
      INSERT INTO members(id,role,joined_at) VALUES('alex','member','${current}')`);
    const thread = new Threads(destination, () => current).open({member:'alex',agent:'fern',title:'Garden'});
    writer.exec('CREATE TABLE comms_threads(id,conversation,agent,member,project); CREATE TABLE comms_messages(thread,seq,kind,sender,id,at,run,text,delivered,card_json,step)');
    writer.prepare('INSERT INTO comms_threads VALUES(?,?,?,?,null)').run(thread.id, thread.conversation, 'fern', 'alex');
    const summary = Buffer.from('Garden'), step = Buffer.from('{"body":"garden diff"}');
    writer.prepare("INSERT INTO comms_messages VALUES(?,1,'card','fern','step-edit',?,'run',?,null,?,?)")
      .run(thread.id, current, summary, JSON.stringify({ tool:'Edit', state:'done', exit:0 }), step);
    let opens = 0;
    const run = () => importTextHistory({ archive, household:archive, destination, kind:'cards', sourceDays:2, now:() => current,
      key:{ async open(bytes){ opens++; return bytes.toString(); }, async seal(){ throw Error('unexpected'); }, hash(){ throw Error('unexpected'); } } });
    expect(await run()).toEqual({inserted:1,total:1});
    const read = () => client.prepare('SELECT words, archived_step_words detail, card_state state FROM messages').get();
    expect(read()).toEqual({ words:summary, detail:step, state:'done' });
    client.exec('UPDATE messages SET archived_step_words=NULL');
    expect(await run()).toEqual({inserted:0,total:1});
    expect(read()).toEqual({ words:summary, detail:null, state:'done' });
    current = '2026-11-22T00:00:00.000Z';
    const before = opens;
    await run();
    expect(opens).toBe(before);
    expect(read()).toEqual({ words:null, detail:null, state:'done' });
  } finally {
    archive.close(); writer.close(); client.close(); rmSync(dir, {recursive:true, force:true});
  }
});

it('validates notice attribution, keeps retry state, and never restores an erased reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-notice-history-'));
  const path = join(dir, 'source.db');
  const writer = new Database(path), archive = new Database(path, {readonly:true}), client = new Database(':memory:');
  const at = '2026-11-20T00:00:00.000Z';
  try {
    const destination = createDataSchema(client);
    client.exec(`INSERT INTO agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES('fern','','','','drop','dot');
      INSERT INTO members(id,role,joined_at) VALUES('alex','member','${at}')`);
    const thread = new Threads(destination, () => at).open({member:'alex',agent:'fern',title:'Garden'});
    writer.exec('CREATE TABLE comms_threads(id,conversation,agent,member,project); CREATE TABLE comms_messages(thread,seq,kind,sender,id,at,run,text,delivered,card_json,step)');
    writer.prepare('INSERT INTO comms_threads VALUES(?,?,?,?,null)').run(thread.id,thread.conversation,'fern','alex');
    const info = {error:'start-retry',attempt:2,settled:true,retry_at:at};
    writer.prepare("INSERT INTO comms_messages VALUES(?,1,'error','fern','e1',?,'run',null,null,?,null)")
      .run(thread.id,at,JSON.stringify({...info,reason:'garden failure'}));
    let seals = 0;
    const run = () => importTextHistory({archive,household:archive,destination,kind:'notices',sourceDays:2,now:()=>at,
      key:{async seal(value){seals++;return Buffer.from(value);},async open(bytes){return Buffer.from(bytes).toString();},hash(){throw Error('unexpected');}}});
    await expect(run()).rejects.toThrow(/sender differs/);
    expect(seals).toBe(0);
    writer.exec("UPDATE comms_messages SET sender='loom'");
    expect(await run()).toEqual({inserted:1,total:1});
    const row = () => client.prepare('SELECT kind, archived_notice meta, words FROM messages').get();
    expect(row()).toEqual({kind:'notice',meta:JSON.stringify(info),words:Buffer.from('garden failure')});
    writer.prepare('UPDATE comms_messages SET card_json=?').run(JSON.stringify({...info,reason:'different'}));
    await expect(run()).rejects.toThrow(/Conflicting/);
    client.exec('UPDATE messages SET words=NULL');
    expect(await run()).toEqual({inserted:0,total:1});
    expect(row()).toEqual({kind:'notice',meta:JSON.stringify(info),words:null});
    expect(seals).toBe(1);
  } finally {
    archive.close(); writer.close(); client.close(); rmSync(dir,{recursive:true,force:true});
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
