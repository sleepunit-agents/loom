import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { Threads } from './threads.js';
import { importArchivedQuestions } from './archived-question-store.js';

it('recognizes both pre-question stores and refuses a newer incomplete archive', async () => {
  const dir = mkdtempSync(join(tmpdir(),'loom-question-layout-'));
  const path = join(dir,'comms.db');
  const db = new Database(':memory:'), writer = new Database(path), archive = new Database(path,{readonly:true});
  try {
    const at = '2026-11-20T00:00:00.000Z', destination = createDataSchema(db);
    let opens = 0;
    let onOpen = () => {};
    const run = () => importArchivedQuestions({archive,household:archive,destination,now:()=>at,sourceDays:2,
      key:{async open(){opens++;onOpen();return '{"text":"garden?"}';},async seal(){throw Error('unexpected');},hash(){throw Error('unexpected');}}});
    writer.exec('CREATE TABLE comms_messages(thread TEXT,seq INTEGER,at TEXT,kind TEXT,sender TEXT,id TEXT,hash TEXT,text BLOB,card_json TEXT,run TEXT,delivered INTEGER,PRIMARY KEY(thread,seq))');
    expect(await run()).toEqual({total:0,inserted:0});
    writer.exec('ALTER TABLE comms_messages ADD COLUMN sending_at INTEGER; ALTER TABLE comms_messages ADD COLUMN delivery_json TEXT');
    expect(await run()).toEqual({total:0,inserted:0});
    writer.exec('ALTER TABLE comms_messages ADD COLUMN step BLOB');
    await expect(run()).rejects.toThrow(/Unrecognized archive/);

    writer.exec('CREATE TABLE comms_asks(thread,ref,approval,raised,seen,words,answer_json); CREATE TABLE comms_threads(id,agent,member,conversation,project)');
    db.exec(`INSERT INTO agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES('fern','','','','drop','dot');
      INSERT INTO members(id,role,joined_at) VALUES('alex','member','${at}')`);
    const thread = new Threads(destination,()=>at).open({agent:'fern',member:'alex',title:'Garden'});
    writer.prepare('INSERT INTO comms_threads VALUES(?,?,?,?,?)').run(thread.id,'fern','alex',thread.conversation,'other-project');
    writer.prepare('INSERT INTO comms_asks VALUES(?,?,null,?,?,?,null)').run(thread.id,'digest:garden',at,at,Buffer.from('fixture'));
    await expect(run()).rejects.toThrow(/destination thread differs/);
    expect(opens).toBe(0);
    writer.exec('UPDATE comms_threads SET project=NULL');
    onOpen = () => { db.prepare('UPDATE conversations SET place=? WHERE id=?').run('other-thread',thread.conversation); };
    await expect(run()).rejects.toThrow(/destination thread differs/);
    expect(db.prepare('SELECT count(*) n FROM archived_questions').get()).toEqual({n:0});
    db.prepare('UPDATE conversations SET place=? WHERE id=?').run(thread.id,thread.conversation);
    onOpen = () => {};
    expect(await run()).toEqual({inserted:1,total:1});
  } finally {
    archive.close();writer.close();db.close();rmSync(dir,{recursive:true,force:true});
  }
});
