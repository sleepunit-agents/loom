import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { importThreads } from './import-threads.js';
import { legacyThreadLookup } from './legacy-thread-id.js';

it('matches the original creator and requires one recorded parent for an old thread deletion', () => {
  const dir=mkdtempSync(join(tmpdir(),'legacy-thread-'));
  const path=join(dir,'memories.db');
  const writer=new Database(path);
  const source=new Database(path,{readonly:true});
  try {
    writer.exec(`CREATE TABLE conversations(id TEXT, agent TEXT, venue TEXT, place TEXT);
      INSERT INTO conversations VALUES
        ('cv-d19bd80169d4','fern','loom','th:ordinary'),
        ('cv-0b37adc83353','fern','spawn','fixture-job')`);
    const salt=Buffer.from(Array.from({length:32},(_,i)=>i));
    const reader=()=>legacyThreadLookup(()=>source,()=>salt);
    const lookup=reader();
    expect(lookup('fern','alex','th:ordinary')).toBe('cv-d19bd80169d4');
    expect(lookup('fern','alex','th:oi7jknf4hi')).toBe('cv-0b37adc83353');
    expect(lookup('fern','robin','th:oi7jknf4hi')).toBeUndefined();
    expect(lookup('moss','alex','th:oi7jknf4hi')).toBeUndefined();
    writer.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('cv-93552a2f3944','fern','loom','th:oi7jknf4hi');
    expect(reader()('fern','alex','th:oi7jknf4hi')).toBeUndefined();
  } finally {
    source.close();
    writer.close();
    rmSync(dir,{recursive:true,force:true});
  }
});


it('releases the archive connection when a deletion cannot be resolved before live threads are read', () => {
  const dir=mkdtempSync(join(tmpdir(),'unresolved-thread-'));
  const path=join(dir,'household.db');
  const writer=new Database(path);
  const destination=new Database(':memory:');
  try {
    writer.exec(`CREATE TABLE comms_deleted(id,at,member,agent);
      INSERT INTO comms_deleted VALUES ('th:gone','2026-11-20T00:00:00Z','alex','fern');
      CREATE TABLE comms_threads(id)`);
    const source=new Database(path,{readonly:true});
    try {
      const db=createDataSchema(destination);
      expect(()=>importThreads(source,db,()=>undefined)).toThrow(/no unique backing conversation/);
    } finally {
      source.close();
    }
  } finally {
    writer.close();
    destination.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

it('restores a job-backed private thread only under its recorded backing conversation', () => {
  const dir=mkdtempSync(join(tmpdir(),'spawn-thread-'));
  const path=join(dir,'household.db');
  const writer=new Database(path);
  const destination=new Database(':memory:');
  const at='2026-11-20T00:00:00.000Z';
  try {
    writer.exec(`CREATE TABLE comms_deleted(id,conversation,agent,member,channel,at);
      INSERT INTO comms_deleted(id,conversation,agent,member,channel,at) VALUES ('th:gone','cv-removed','fern','alex',4,'${at}');
      CREATE TABLE comms_threads(id, conversation, member, agent, title, titled_by, channel, project, pinned, archived, opened, last, read_seq)`);
    writer.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('th:oi7jknf4hi','cv-0b37adc83353','alex','fern','Garden job','agent',1,null,0,null,at,at,7);
    const source=new Database(path,{readonly:true});
    try {
      const db=createDataSchema(destination);
      destination.prepare("INSERT INTO agents (id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES ('fern','','','','drop','dot')").run();
      destination.prepare("INSERT INTO members (id,role,joined_at) VALUES ('alex','member',?)").run(at);
      expect(()=>importThreads(source,db,()=>'cv-other')).toThrow(/backing conversation/);
      expect(destination.prepare('SELECT count(*) AS n FROM deleted_threads').get()).toEqual({n:0});
      const recover=(agent:string,member:string,thread:string)=>{
        expect([agent,member,thread]).toEqual(['fern','alex','th:oi7jknf4hi']);
        return 'cv-0b37adc83353';
      };
      expect(importThreads(source,db,recover)).toEqual({inserted:1,total:1,tombstones:1});
      expect(destination.prepare('SELECT read_seq FROM threads').get()).toEqual({read_seq:7});
      expect(destination.prepare('SELECT conversation,source_member,source_agent,source_channel FROM deleted_threads').all()).toEqual([{conversation:'cv-removed',source_member:'alex',source_agent:'fern',source_channel:4}]);
      for(const table of ['jobs','messages','inbox']) expect(destination.prepare('SELECT count(*) AS n FROM '+table).get()).toEqual({n:0});
      expect(importThreads(source,db,recover).inserted).toBe(0);
      const started='2026-11-18T00:00:00.000Z';
      destination.prepare('UPDATE conversations SET started_at=?,turn_count=3').run(started);
      const recorded=(agent:string,cv:string)=>{
        expect([agent,cv]).toEqual(['fern','cv-0b37adc83353']);
        return {started,last:at};
      };
      expect(importThreads(source,db,recover,recorded).inserted).toBe(0);
      destination.prepare('UPDATE conversations SET started_at=?').run('2026-11-15T00:00:00.000Z');
      expect(()=>importThreads(source,db,recover,recorded)).toThrow(/differs/);
      writer.exec("UPDATE comms_deleted SET member='other'");
      expect(()=>importThreads(source,db,recover)).toThrow(/deletion differs/);
      expect(destination.prepare('SELECT id,member,venue,place FROM conversations').all()).toEqual([
        {id:'cv-0b37adc83353',member:'alex',venue:'loom',place:'th:oi7jknf4hi'},
      ]);
    } finally { source.close(); }
  } finally {
    writer.close();
    destination.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
