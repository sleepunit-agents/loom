import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openSnapshotSqlite } from '../../cli/migration-sqlite.js';
import { readBridgeStoreInventory, type BridgeStoreFile } from './import-stores.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(kind:'shuttle'|'runtime'='shuttle') {
  const root=mkdtempSync(join(tmpdir(),'bridges-stores-'));roots.push(root);
  const file:BridgeStoreFile={name:`home/commons/stores/${kind}.db`,path:join(root,`${kind}.db`),kind};
  const db=new Database(file.path);
  db.exec(`CREATE TABLE docs(collection TEXT NOT NULL,key TEXT NOT NULL,doc TEXT NOT NULL,rev INTEGER NOT NULL,updated TEXT NOT NULL,by TEXT NOT NULL,PRIMARY KEY(collection,key));
    CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,collection TEXT NOT NULL,key TEXT NOT NULL,doc TEXT,rev INTEGER NOT NULL,op TEXT NOT NULL,at TEXT NOT NULL,by TEXT NOT NULL);`);
  const add=(collection:string,key:string,doc:string,rev=1)=>db.prepare('INSERT INTO docs VALUES(?,?,?,?,?,?)').run(collection,key,doc,rev,'original time','original writer');
  return {file,db,add};
}
it('retains authoritative documents, unknown collections, proposals, tombstones and exact revision words without applying them',()=>{
  const {file,db,add}=fixture();
  const raw=' {"people":{"jonathan":{"tier":3,"discord":9007199254740991.1}},"token_file":"do-not-open"} ';
  add('people','art',raw,2);add('moved','art','{"agent":"art"}');add('routes','household','{"guild":"123"}');
  add('channels','art','{"bot":"200","flags":{"300":{"readers":["jonathan"]}}}');
  add('proposals','art.pending','{"entry":{"tier":3},"then-relay-say":"do not execute"}');add('future','opaque','null');
  db.prepare('INSERT INTO revisions(collection,key,doc,rev,op,at,by) VALUES(?,?,?,?,?,?,?)').run('people','art','{"people":{}}',1,'put','before','owner');
  db.prepare('INSERT INTO revisions(collection,key,doc,rev,op,at,by) VALUES(?,?,?,?,?,?,?)').run('offers','gone',null,2,'del','after','owner');db.close();
  const before=readFileSync(file.path), open=vi.fn(openSnapshotSqlite), inventory=readBridgeStoreInventory([file],open);
  expect(open.mock.calls).toEqual([[file.path]]);
  expect(inventory.stores[0].documents.map(d=>[d.collection,d.key])).toEqual([['channels','art'],['future','opaque'],['moved','art'],['people','art'],['proposals','art.pending'],['routes','household']]);
  expect(inventory.stores[0].documents.find(d=>d.collection==='people')).toEqual({collection:'people',key:'art',doc:raw,rev:2,updated:'original time',by:'original writer'});
  expect(inventory.stores[0].revisions).toEqual([{id:1,collection:'people',key:'art',doc:'{"people":{}}',rev:1,op:'put',at:'before',by:'owner'},{id:2,collection:'offers',key:'gone',doc:null,rev:2,op:'del',at:'after',by:'owner'}]);
  expect(inventory.stores[0].sha256).toBe(createHash('sha256').update(before).digest('hex'));
  expect(inventory.stores[0].bytes).toBe(before.length);
  expect(inventory.checksum).toBe(createHash('sha256').update(JSON.stringify(inventory.stores)).digest('hex'));
  expect(readFileSync(file.path)).toEqual(before);
});
it('keeps shuttle and runtime evidence distinct and hashes names, kinds and every row',()=>{
  const s=fixture(),r=fixture('runtime');s.add('people','art','{"people":{}}');r.add('gates','art','{"people":{"other":{}}}');s.db.close();r.db.close();
  const inventory=readBridgeStoreInventory([s.file,r.file],openSnapshotSqlite);
  expect(inventory).toEqual(readBridgeStoreInventory([r.file,s.file],openSnapshotSqlite));
  expect(inventory.stores.map(s=>s.kind)).toEqual(['runtime','shuttle']);
  expect(readBridgeStoreInventory([{...s.file,name:'other/shuttle.db'},r.file],openSnapshotSqlite).checksum).not.toBe(inventory.checksum);
  const db=new Database(s.file.path);db.prepare("UPDATE docs SET doc='{}'").run();db.close();
  expect(readBridgeStoreInventory([s.file,r.file],openSnapshotSqlite).checksum).not.toBe(inventory.checksum);
});
it('refuses missing/duplicate/mislabeled inputs and leaf links before opening SQLite',()=>{
  const {file,db}=fixture();db.close();const open=vi.fn(openSnapshotSqlite);
  const link=join(file.path,'..','alias.db');symlinkSync(file.path,link);
  for(const files of [[],[file,file],[{...file,name:'../shuttle.db'}],[{...file,kind:'runtime' as const}],[{...file,path:link}],[{...file,path:join(file.path,'..','missing','shuttle.db')}]] ) {
    expect(()=>readBridgeStoreInventory(files,open)).toThrow(/^Invalid offline Bridges store inventory$/);
  }
  expect(open).not.toHaveBeenCalled();
});
it.each(['bad-json','unsafe-rev','extra-table','extra-column','generated-column','wildcard-table','unsafe-revision-id'])('refuses %s with exact sanitized error and closes source',kind=>{
  const {file,db,add}=fixture();add('people','art','{}');
  if(kind==='bad-json')db.prepare("UPDATE docs SET doc='private source text'").run();
  if(kind==='unsafe-rev')db.exec('UPDATE docs SET rev=9007199254740993');
  if(kind==='extra-table')db.exec('CREATE TABLE lost(value TEXT)');
  if(kind==='wildcard-table')db.exec('CREATE TABLE sqliteXlost(value TEXT)');
  if(kind==='generated-column'){db.exec('DELETE FROM docs');db.exec("ALTER TABLE docs ADD COLUMN lost TEXT GENERATED ALWAYS AS (doc || 'lost') STORED");}
  if(kind==='extra-column')db.exec('ALTER TABLE docs ADD COLUMN lost TEXT');
  if(kind==='unsafe-revision-id')db.exec("INSERT INTO revisions VALUES(9007199254740993,'people','art','{}',1,'put','t','by')");db.close();
  let closed=false;
  const open=(path:string)=>{const source=openSnapshotSqlite(path),close=source.close.bind(source);source.close=()=>{closed=true;return close();};return source;};
  expect(()=>readBridgeStoreInventory([file],open)).toThrow(/^Invalid offline Bridges store inventory$/);expect(closed).toBe(true);
});
it('refuses oversized UTF-8 document bytes before selecting raw words',()=>{
  const {file,db,add}=fixture();add('people','art',JSON.stringify({words:'界'.repeat(3*1024*1024)}));db.close();
  let selected=false;
  const open=(path:string)=>{const source=openSnapshotSqlite(path),prepare=source.prepare.bind(source);source.prepare=((sql:string)=>{if(sql.startsWith('SELECT collection,key,doc'))selected=true;return prepare(sql);}) as typeof source.prepare;return source;};
  expect(()=>readBridgeStoreInventory([file],open)).toThrow('Invalid offline');expect(selected).toBe(false);
});
it('refuses source mutation around the read snapshot and sanitizes SQLite failures',()=>{
  const {file,db}=fixture();db.close();
  expect(()=>readBridgeStoreInventory([file],path=>{const changed=new Database(path);changed.prepare('INSERT INTO docs VALUES(?,?,?,?,?,?)').run('people','art','{}',1,'t','owner');changed.close();return openSnapshotSqlite(path);})).toThrow(/^Invalid offline Bridges store inventory$/);
  expect(()=>readBridgeStoreInventory([file],()=>{throw Error('private source path and credential');})).toThrow(/^Invalid offline Bridges store inventory$/);
});

it('refuses an oversized file before hashing or opening SQLite',()=>{
  const {file,db}=fixture();db.close();truncateSync(file.path,128*1024*1024+1);
  const open=vi.fn(openSnapshotSqlite);
  expect(()=>readBridgeStoreInventory([file],open)).toThrow(/^Invalid offline Bridges store inventory$/);
  expect(open).not.toHaveBeenCalled();
});
it.each(['count','metadata'])('bounds %s before selecting document words',kind=>{
  const {file,db,add}=fixture();
  if(kind==='count')db.transaction(()=>{for(let n=0;n<10001;n++)add('people',String(n),'{}');})();
  else {add('people','art','{}');db.prepare('UPDATE docs SET by=?').run('x'.repeat(8*1024*1024));}
  db.close();let selected=false;
  const open=(path:string)=>{const source=openSnapshotSqlite(path),prepare=source.prepare.bind(source);source.prepare=((sql:string)=>{if(sql.startsWith('SELECT collection,key,doc'))selected=true;return prepare(sql);}) as typeof source.prepare;return source;};
  expect(()=>readBridgeStoreInventory([file],open)).toThrow(/^Invalid offline Bridges store inventory$/);expect(selected).toBe(false);
});
