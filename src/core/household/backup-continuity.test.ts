import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { captureHouseholdContinuity, type ContinuitySources } from './backup-continuity.js';
import { Notes } from '../../notes.js';

const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) close(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-continuity-'));
  closers.push(() => rmSync(home, { recursive: true, force: true }));
  const put = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(join(home,path)), { recursive:true }); writeFileSync(join(home,path),bytes); };
  for (const agent of ['art','other']) put(`agents/${agent}/IDENTITY.md`, `CREED_${agent}`);
  const db = (path = ':memory:') => { const db = new Database(path); closers.push(() => db.close()); return db; };
  const memory = db(join(home,'agents/art/memories.db'));
  memory.pragma('journal_mode = WAL'); sqliteVec.load(memory);
  memory.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, words TEXT); CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[2]); INSERT INTO memories VALUES(1,'MEMORY_WORDS');");
  memory.prepare('INSERT INTO vec_memories(rowid,embedding) VALUES(?,?)').run(1n,new Float32Array([1,2]));
  const writer = db(memory.name);
  writer.prepare('INSERT INTO memories VALUES(?,?)').run(2,'COMMITTED_WAL_WORDS');
  const notesWriter = new Notes(join(home,'agents/art'));
  notesWriter.write('work/plan','NOTE_WORDS',{lifespan:'keep',by:'art'}); notesWriter.close();
  const notes = db(join(home,'agents/art/notes.db'));
  const attachment=Buffer.from('ATTACHMENT_WORDS'), hash=createHash('sha256').update(attachment).digest('hex');
  notes.prepare('INSERT INTO note_files VALUES(?,?,?,?,?,?)').run('work/plan','proof.txt',hash,attachment.length,'text/plain','2026-11-14T00:00:00Z');
  put(`agents/art/note-files/${hash.slice(0,2)}/${hash}`, attachment);
  put('agents/art/note-files/aa/'+'a'.repeat(64), 'UNREFERENCED');
  const knowledge=db(); knowledge.exec("CREATE TABLE pages(words TEXT); INSERT INTO pages VALUES('KNOWLEDGE_WORDS');");
  const people=db(); people.exec("CREATE TABLE people(words TEXT); INSERT INTO people VALUES('PEOPLE_WORDS');");
  const sources: ContinuitySources={agents:[{agent:'art',memories:memory,notes},{agent:'other',memories:null,notes:null}],knowledge,people};
  return { home, put, db, memory, notes, writer, hash, sources };
}
it('captures complete virtual-table memory/WAL, notes and commons, pairs only snapshot-owned attachments, and preserves explicit absence', () => {
  const f=fixture(), before=f.memory.serialize();
  const result=captureHouseholdContinuity(f.home,f.sources);
  expect(result.databases.map(f=>f.path)).toEqual(['agents/art/memories.db','agents/art/notes.db','commons/knowledge.db','commons/people.db']);
  expect(result.absent).toEqual(['agents/other/memories.db','agents/other/notes.db']);
  expect(result.files.map(f=>f.path)).toEqual(['agents/art/IDENTITY.md',`agents/art/note-files/${f.hash.slice(0,2)}/${f.hash}`,'agents/other/IDENTITY.md']);
  for(const image of [...result.databases,...result.files]) expect(image.sha256).toBe(createHash('sha256').update(image.bytes).digest('hex'));
  const restored=new Database(result.databases[0].bytes); closers.push(()=>restored.close()); sqliteVec.load(restored);
  expect(restored.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual([{id:1,words:'MEMORY_WORDS'},{id:2,words:'COMMITTED_WAL_WORDS'}]);
  expect(restored.prepare('SELECT rowid,embedding FROM vec_memories').get()).toEqual({rowid:1,embedding:Buffer.from(new Float32Array([1,2]).buffer)});
  expect(f.memory.serialize()).toEqual(before); expect(f.memory.inTransaction).toBe(false);
  expect(f.memory.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({n:2});
  for(const image of result.databases) {
    const db=new Database(image.bytes); sqliteVec.load(db);
    expect(db.pragma('integrity_check',{simple:true})).toBe('ok'); db.close();
  }
});
it('uses references in the captured notes image even when the source references change after serialization', () => {
  const f=fixture(), serialize=Database.prototype.serialize;
  vi.spyOn(Database.prototype,'serialize').mockImplementation(function(this: Database.Database) {
    const image=serialize.call(this);
    if(this===f.notes) this.prepare('DELETE FROM note_files').run();
    return image;
  });
  const result=captureHouseholdContinuity(f.home,f.sources);
  expect(f.notes.prepare('SELECT * FROM note_files').all()).toEqual([]);
  expect(result.files.some(file=>file.path.endsWith(f.hash))).toBe(true);
  const restored=new Database(result.databases[1].bytes); closers.push(()=>restored.close());
  expect(restored.prepare('SELECT sha256 FROM note_files').get()).toEqual({sha256:f.hash});
});
it.each(['missing','changed','size','malformed','conflicting'])('refuses %s referenced attachments without returning partial plaintext', kind => {
  const f=fixture();
  if(kind==='missing') rmSync(join(f.home,`agents/art/note-files/${f.hash.slice(0,2)}/${f.hash}`));
  if(kind==='changed') f.put(`agents/art/note-files/${f.hash.slice(0,2)}/${f.hash}`,'OTHER');
  if(kind==='size') f.notes.prepare('UPDATE note_files SET bytes=bytes+1').run();
  if(kind==='malformed') f.notes.prepare('UPDATE note_files SET sha256=?').run('../PRIVATE');
  if(kind==='conflicting') f.notes.prepare("INSERT INTO note_files SELECT path,'other',sha256,bytes+1,type,added FROM note_files").run();
  const captured:Buffer[]=[]; const serialize=Database.prototype.serialize;
  vi.spyOn(Database.prototype,'serialize').mockImplementation(function(this:Database.Database){const bytes=serialize.call(this);captured.push(bytes);return bytes;});
  expect(()=>captureHouseholdContinuity(f.home,f.sources)).toThrow(/^Household continuity capture failed$/);
  expect(captured.length).toBeGreaterThan(0); expect(captured.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
});
it('refuses caller transactions without committing or exposing their uncommitted changes', () => {
  const f=fixture(); f.memory.exec("BEGIN; INSERT INTO memories VALUES(3,'UNCOMMITTED')");
  expect(()=>captureHouseholdContinuity(f.home,f.sources)).toThrow(/^Household continuity capture failed$/);
  expect(f.memory.inTransaction).toBe(true); f.memory.exec('ROLLBACK');
  expect(f.memory.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({n:2});
});
it.each(['bad-agent','duplicate','closed','notes-schema'])('refuses %s input rather than treating failure as absence', kind => {
  const f=fixture();
  if(kind==='bad-agent') f.sources.agents=[{agent:'../art',memories:null,notes:null}];
  if(kind==='duplicate') f.sources.agents=[f.sources.agents[0],f.sources.agents[0]];
  if(kind==='closed') { const db=new Database(':memory:'); db.close(); f.sources.knowledge=db; }
  if(kind==='notes-schema') f.notes.exec('DROP TABLE note_files');
  expect(()=>captureHouseholdContinuity(f.home,f.sources)).toThrow(/^Household continuity capture failed$/);
});
it('wipes an allocated image if ending the read transaction fails before the snapshot returns', () => {
  const f=fixture(), serialize=Database.prototype.serialize; let bytes:Buffer|undefined;
  vi.spyOn(Database.prototype,'serialize').mockImplementation(function(this:Database.Database) {
    bytes=serialize.call(this); this.exec('ROLLBACK'); return bytes;
  });
  expect(()=>captureHouseholdContinuity(f.home,f.sources)).toThrow(/^Household continuity capture failed$/);
  expect(bytes?.length).toBeGreaterThan(0); expect(bytes?.every(byte=>byte===0)).toBe(true);
});
it('wipes all images if reopening, integrity checking, or closing a restored connection fails', () => {
  const f=fixture(), serialize=Database.prototype.serialize, close=Database.prototype.close;
  const images:Buffer[]=[];
  vi.spyOn(Database.prototype,'serialize').mockImplementation(function(this:Database.Database){const bytes=serialize.call(this);images.push(bytes);return bytes;});
  vi.spyOn(Database.prototype,'close').mockImplementation(function(this:Database.Database) { close.call(this); throw Error('PRIVATE_CLOSE_DETAIL'); });
  expect(()=>captureHouseholdContinuity(f.home,f.sources)).toThrow(/^Household continuity capture failed$/);
  expect(images.length).toBeGreaterThan(0); expect(images.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
});
it('refuses oversized page estimates before allocating a serialized image', () => {
  const f=fixture(), pragma=Database.prototype.pragma;
  vi.spyOn(Database.prototype,'pragma').mockImplementation(function(this:Database.Database,sql:string,options?:Database.PragmaOptions){
    if(this===f.memory && sql==='page_count') return 1000000;
    return pragma.call(this,sql,options);
  });
  const serialize=vi.spyOn(Database.prototype,'serialize');
  expect(()=>captureHouseholdContinuity(f.home,f.sources)).toThrow(/^Household continuity capture failed$/);
  expect(serialize).not.toHaveBeenCalled();
});
