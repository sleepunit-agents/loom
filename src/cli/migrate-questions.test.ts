import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ownHome } from '../core/daemon-home.js';
import { exampleHome } from '../example-home.js';
import { migrateComms } from './migrate-questions.js';

it('opens completed archive backups only while the destination is stopped', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'loom-question-command-'));
  const source = join(temp, 'archive #100%'), home = join(temp, 'home');
  let stdout = '';
  const run = () => migrateComms('archived-questions', ['--source', source, '--home', home], {
    stdout: value => { stdout = value; }, stderr: () => {},
  });
  try {
    await exampleHome(home);
    mkdirSync(source);
    copyFileSync(join(home, 'comms.key'), join(source, 'comms.key'));
    writeFileSync(join(source, 'household.json'), '{"github":null}');
    const target = new Database(join(home, 'app.db'), { readonly: true });
    let thread;
    try {
      thread = target.prepare('select t.id, t.conversation, c.agent, c.member from threads t join conversations c on c.id=t.conversation where c.member is not null limit 1').get() as {id:string; conversation:string; agent:string; member:string};
    } finally { target.close(); }
    const meta = new Database(join(source, 'household.db'));
    try {
      meta.exec('create table comms_threads(id, conversation, agent, member)');
      meta.prepare('insert into comms_threads(id, conversation, agent, member) values (@id,@conversation,@agent,@member)').run(thread);
    } finally { meta.close(); }
    const path = join(source, 'comms.db'), archive = new Database(path);
    try {
      archive.pragma('journal_mode = PERSIST');
      archive.pragma('journal_size_limit = 8');
      archive.exec('create table comms_asks(thread, ref, approval, raised, seen, words, answer_json)');
      const at = new Date().toISOString();
      archive.prepare('insert into comms_asks(thread, ref, raised, seen) values (?, ?, ?, ?)').run(thread.id, 'old-ask', at, at);
    } finally { archive.close(); }
    expect(readFileSync(path+'-journal')).toEqual(Buffer.alloc(8));
    const coldJournal=readFileSync(path+'-journal');
    writeFileSync(path+'-journal',Buffer.alloc(28,1));
    expect(await run()).toBe(1);
    writeFileSync(path+'-journal',coldJournal);
    const original = readFileSync(path);
    const release = await ownHome(home);
    try { expect(await run()).toBe(1); } finally { await release(); }
    writeFileSync(path + '-wal', 'incomplete backup');
    expect(await run()).toBe(1);
    rmSync(path + '-wal');
    const directory = new Database(join(source, 'household.db'));
    try {
      directory.prepare('update comms_threads set member=?').run('someone-else');
      expect(await run()).toBe(1);
      directory.prepare('update comms_threads set member=?').run(thread.member);
    } finally { directory.close(); }
    expect(await run()).toBe(0);
    expect(stdout).toBe('Imported 1 of 1 archived questions.\n');
    expect(await run()).toBe(0);
    expect(stdout).toBe('Imported 0 of 1 archived questions.\n');
    expect(readFileSync(path)).toEqual(original);
    const metadata=new Database(join(source,'household.db')), words=new Database(path);
    try {
      metadata.exec('DELETE FROM comms_threads; ALTER TABLE comms_threads ADD COLUMN project text; CREATE TABLE comms_deleted(id)');
      words.exec('CREATE TABLE comms_messages(thread,seq,kind,sender,id,at,run,text,delivered)');
    } finally {metadata.close();words.close();}
    for (const [phase,report] of [['comms-threads','Comms threads'],['comms-text','Comms text messages']]) {
      const entry=fileURLToPath(new URL('../index.ts',import.meta.url));
      const result=spawnSync(process.execPath,['--import','tsx',entry,'migrate',phase,'--home',home,'--source',source],{encoding:'utf8'});
      expect(result.status,result.stderr).toBe(0);
      expect(result.stdout).toContain('Imported 0 of 0 '+report);
    }
    const late = new Database(join(source,'household.db'));
    try {
      late.exec('DROP TABLE comms_deleted; CREATE TABLE comms_deleted(id,conversation,agent,member,at)');
      late.prepare('INSERT INTO comms_deleted VALUES(?,?,?,?,?)')
        .run('retired-fixture','old-conversation',thread.agent,thread.member,new Date().toISOString());
      late.pragma('journal_mode = WAL');
    } finally { late.close(); }
    const seeded=new Database(join(home,'app.db'));
    const checkpoint=Buffer.from('existing checkpoint fixture');
    try {
      seeded.prepare("INSERT INTO conversation_sessions(conversation,harness,session,files,bytes,started_at) VALUES(?,'codex','existing',?,?,?)")
        .run(thread.conversation,checkpoint,checkpoint.length,'2026-01-01T00:00:00.000Z');
    } finally { seeded.close(); }
    const combined = () => migrateComms('comms',['--source',source,'--home',home],{
      stdout:value=>{stdout+=value;},stderr:()=>{},
    });
    stdout='';
    expect(await combined()).toBe(1); // the final archived ask has no source thread
    expect(stdout).toBe('');
    const inspect = new Database(join(home,'app.db'),{readonly:true});
    const tombstone=inspect.prepare("SELECT 1 FROM deleted_threads WHERE id='retired-fixture'");
    try {
      expect(tombstone.get()).toBeUndefined();
      const fixed=new Database(path);
      try {fixed.exec('DELETE FROM comms_asks');} finally {fixed.close();}
      expect(await combined()).toBe(0);
      expect(tombstone.get()).toBeDefined();
      expect(inspect.prepare("SELECT session,files,bytes,started_at FROM conversation_sessions WHERE conversation=? AND harness='codex'").get(thread.conversation))
        .toEqual({session:'existing',files:checkpoint,bytes:checkpoint.length,started_at:'2026-01-01T00:00:00.000Z'});
      expect(stdout).toContain('new deletion records: 1');
      expect(existsSync(join(source,'household.db-shm'))).toBe(false);
      expect(existsSync(join(source,'household.db-wal'))).toBe(false);
    } finally {inspect.close();}
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
