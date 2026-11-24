import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, household, members, tasks, taskComments } from './core/data/schema.js';
import { Notes } from './notes.js';
import { nightlyNoteRetention, sweepAgentNotes } from './shared-note-retention.js';
import { upgradeKnowledgeStore } from './backends/sqlite-knowledge.js';

it('expires notes at the household hour and retains live task, knowledge and memory citations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-notes-'));
  const agent = { agent: 'art', directory, memories: join(directory, 'memories.db') };
  const commons = { directory, people: join(directory, 'people.db'), knowledge: join(directory, 'knowledge.db') };
  const client = new Database(':memory:'), db = createDataSchema(client);
  const knowledge = new Database(commons.knowledge), memories = new Database(agent.memories);
  const stamp = '2026-01-01T10:40:59.000Z', clock = new FakeClock(Date.parse(stamp));
  const notes = new Notes(directory, () => clock.now());
  const changed = vi.fn(), report = vi.fn();
  let stop: (() => void) | undefined;
  try {
    db.insert(household).values({id:'house',name:'Example',timezone:'America/Chicago'}).run();
    db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
    db.insert(members).values({id:'owner',role:'owner',joinedAt:stamp}).run();
    const base = { createdByKind:'member' as const, createdBy:'owner', ownerKind:'household' as const, createdAt:stamp, changedAt:stamp };
    db.insert(tasks).values([
      {...base,id:'open',title:'See notes/pump.md',doneWhen:'Check note:actual.md'},
      {...base,id:'working',title:'Working',status:'in_progress',specItem:'See note:spec',criterion:'Follow notes/criterion.md',sourceKind:'note',sourceId:'source-note'},
      {...base,id:'closed',title:'Old note:scratch',status:'closed'},
    ]).run();
    db.insert(taskComments).values({task:'working',seq:1,actorKind:'member',actor:'owner',at:stamp,text:'See notes/inspection/photo.jpg'}).run();
    upgradeKnowledgeStore(knowledge);
    knowledge.prepare('INSERT INTO pages (uuid,slug,title,domain,body,created) VALUES (?,?,?,?,?,?)')
      .run('one','garden','Garden','garden','',stamp);
    knowledge.prepare('INSERT INTO citations (page_id,claim,source_kind,source_locator,excerpt,retrieved_at,created) VALUES (1,?,?,?,?,?,?)')
      .run('Evidence','note','note:manual','',stamp,stamp);
    memories.exec('CREATE TABLE memories (title,content,metadata,provenance,archived)');
    memories.prepare('INSERT INTO memories VALUES (?,?,?,?,0)').run('Garden','','','note:log');
    for (const path of ['pump','actual.md','inspection','manual','log','scratch','spec','criterion','source-note']) notes.write(path,'words',{lifespan:'short',by:'art'});
    clock.advance(15*86400000);
    const dry = sweepAgentNotes(db,agent,commons.knowledge,()=>clock.now(),true);
    expect(dry.gone).toEqual(['scratch']);
    expect(dry.keptCited.sort()).toEqual(['actual.md','criterion','inspection','log','manual','pump','source-note','spec']);
    expect(notes.read('scratch')).not.toBeNull();
    stop = nightlyNoteRetention(db,clock,{agents:[agent],commons},'art',changed,report);
    // A missing citation source must prevent deletion. The next night tries again.
    memories.exec('ALTER TABLE memories RENAME TO unavailable');
    clock.advance(1000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(notes.read('scratch')).not.toBeNull();
    memories.exec('ALTER TABLE unavailable RENAME TO memories');
    clock.advance(86400000);
    expect(notes.read('scratch')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    for (const path of dry.keptCited) expect(notes.read(path)).not.toBeNull();
    client.prepare("UPDATE tasks SET status='closed' WHERE id='working'").run();
    clock.advance(86400000);
    for (const path of ['spec','criterion','source-note','inspection']) expect(notes.read(path)).toBeNull();
    stop();stop=undefined;
    client.prepare("UPDATE tasks SET status='closed' WHERE id='open'").run();
    clock.advance(86400000);
    expect(notes.read('pump')).not.toBeNull();
  } finally { stop?.(); notes.close(); memories.close(); knowledge.close(); client.close(); rmSync(directory,{recursive:true,force:true}); }
});

it('sweeps a prepared notes-only store, preserving citations and stopping on an unrecognized source', async () => {
  const {prepareAgentMemory} = await import('./shared-memory.js');
  const directory = mkdtempSync(join(tmpdir(), 'loom-notes-only-'));
  const agent = {agent:'fern', directory, memories:join(directory,'memories.db')};
  const knowledgeFile = join(directory,'knowledge.db');
  const client = new Database(':memory:'), db = createDataSchema(client);
  const knowledge = new Database(knowledgeFile);
  const start = Date.UTC(2026,0,1), due = start+15*86400000;
  let notes: Notes | undefined;
  let memory: Database.Database | undefined;
  try {
    upgradeKnowledgeStore(knowledge);
    prepareAgentMemory(agent);
    notes = new Notes(directory,()=>start);
    for (const path of ['scratch','garden']) notes.write(path,'words',{lifespan:'short',by:'fern'});
    db.insert(agents).values({id:'fern',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
    db.insert(tasks).values({id:'garden-task',title:'Water note:garden',status:'open',
      createdByKind:'agent',createdBy:'fern',ownerKind:'household',createdAt:new Date(start).toISOString(),
      changedAt:new Date(start).toISOString()}).run();
    const sweep = (dryRun=false) => sweepAgentNotes(db,agent,knowledgeFile,()=>due,dryRun);
    expect(sweep(true)).toEqual({gone:['scratch'],keptCited:['garden']});
    memory = new Database(agent.memories);
    memory.exec('CREATE TABLE unavailable(title, content, metadata, provenance, archived)');
    expect(()=>sweep()).toThrow();
    expect(notes.read('scratch')).not.toBeNull();
    memory.exec('DROP TABLE unavailable');
    memory.prepare('INSERT INTO memory_card_references VALUES(?,?,?)').run('receipt','person','fern');
    expect(()=>sweep()).toThrow();
    expect(notes.read('scratch')).not.toBeNull();
    memory.exec('DELETE FROM memory_card_references');
    expect(sweep()).toEqual({gone:['scratch'],keptCited:['garden']});
    expect(notes.read('scratch')).toBeNull();
    expect(notes.read('garden')).not.toBeNull();
  } finally {
    memory?.close(); notes?.close(); knowledge.close(); client.close(); rmSync(directory,{recursive:true,force:true});
  }
});
