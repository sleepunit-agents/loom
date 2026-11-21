import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ownHome } from '../core/daemon-home.js';
import { exampleHome } from '../example-home.js';
import { migrateQuestions } from './migrate-questions.js';

it('opens completed archive backups only while the destination is stopped', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'loom-question-command-'));
  const source = join(temp, 'archive'), home = join(temp, 'home');
  let stdout = '';
  const run = () => migrateQuestions(['--source', source, '--home', home], {
    stdout: value => { stdout = value; }, stderr: () => {},
  });
  try {
    await exampleHome(home);
    mkdirSync(source);
    copyFileSync(join(home, 'comms.key'), join(source, 'comms.key'));
    writeFileSync(join(source, 'household.json'), '{}');
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
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
