import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../../fixture.js';
import { createFoundation } from '../../core/app.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { importSecrets } from './importer.js';
import { readSecretImport } from './import-source.js';
import { grantsRole } from './index.js';
const roots:string[]=[], clean:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of clean.splice(0))await f();for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true});});
const now=Date.parse('2026-11-13T12:00:00.000Z'),at='2026-11-13T11:59:00.000Z';
const options={agents:{art:'art'},members:{jonathan:'jonathan'}};
const request={id:'q-01234567',secret:'API',agent:'art',house:'h-1',service:'discord',why:'work',minutes:60,at,state:'granted',by:'owner',who:'jonathan',decided:at,expires:'2026-11-13T12:59:00.000Z'};
const pending={id:'q-12345678',secret:'API',agent:'art',house:'h-2',why:'work',minutes:60,at,state:'pending'};
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'secret-import-'));roots.push(dir);
  const home=join(dir,'new'),from=join(dir,'old');mkdirSync(from);fixture(home);
  const put=(name:string,value:unknown)=>writeFileSync(join(from,name),JSON.stringify(value));
  put('store.sops.json',{API:'ENC[AES256_GCM,data:ENCRYPTED_CANARY,iv:abc,tag:def,type:str]',sops:{mac:'CIPHERTEXT_METADATA'}});
  put('policy.json',{v:1,default:'ask',secrets:{API:{grant:'ask',houses:['art']}}});
  put('requests.json',{v:1,requests:{[request.id]:request,[pending.id]:pending}});
  writeFileSync(join(from,'audit.jsonl'),[
    {at,event:'set',secret:'API',how:'add'}, {at,event:'read',secret:'API',agent:'art',house:'h-1',id:request.id},
    {at,event:'host-read',secret:'API',how:'get'}, {at,event:'refused-read',secret:'API',agent:'art',house:'h-3'},
    {at,event:'grant',secret:'API',agent:'art',house:'h-1',id:request.id,by:'owner',who:'jonathan'},
  ].map(e=>JSON.stringify(e)).join('\n')+'\n');
  const app=createFoundation({home});clean.push(async()=>app.close());
  return {home,from,app,put};
}
it('atomically imports names, separate startup policy, exact temporary authority, history and managed pending asks, then real next mode answers them',async()=>{
  const f=setup(),before=['store.sops.json','policy.json','requests.json','audit.jsonl'].map(n=>readFileSync(join(f.from,n)));
  expect(importSecrets(f.app.db,f.home,f.from,now,options)).toMatchObject({imported:true,names:1,requests:2,grants:1});
  const legacy=JSON.parse((f.app.db.prepare("SELECT value FROM secrets_meta WHERE key='legacy-snapshot'").get() as {value:string}).value);
  expect(legacy.audit).toEqual(readFileSync(join(f.from,'audit.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)));
  const tables=f.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
  const output=JSON.stringify(tables.map(t=>f.app.db.prepare(`SELECT * FROM "${t.name}"`).all()));
  expect(output).not.toContain('ENCRYPTED_CANARY');expect(output).not.toContain('CIPHERTEXT_METADATA');
  const stored=JSON.stringify(f.app.db.prepare('SELECT * FROM secrets_meta').all())+JSON.stringify(f.app.db.prepare('SELECT * FROM secrets_names').all());
  expect(stored).not.toContain('ENCRYPTED_CANARY');expect(stored).not.toContain('CIPHERTEXT_METADATA');
  f.app.close();
  const app=await startLoom({home:f.home,next:true,staging:true,clock:new FakeClock(now),host:'127.0.0.1',port:0,stdout(){}});clean.push(()=>app.close());
  const may=(house:string,service?:string)=>grantsRole(app.db).mayUse('art',{kind:'secret',target:'API'},now,{house,...(service?{service}:{})});
  expect(may('h-1','discord')).toBe(true);expect(may('h-1')).toBe(false);expect(may('h-2')).toBe(false);
  expect(app.operations.call('direct',{kind:'agent',id:'art'},'attention.answer',{id:pending.id,answer:{kind:'yes'}},'wrong')).toMatchObject({ok:false,code:'denied'});
  expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'attention.answer',{id:pending.id,answer:{kind:'yes'}},'owner')).toMatchObject({ok:true});expect(may('h-2')).toBe(true);
  const r=app.db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(pending.id) as {record:string};expect(JSON.parse(r.record)).toMatchObject({state:'allowed',by:'jonathan',attentionManaged:true});
  expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.usage',{name:'API'})).toMatchObject({ok:true,value:{count:2}});
  expect(['store.sops.json','policy.json','requests.json','audit.jsonl'].map(n=>readFileSync(join(f.from,n)))).toEqual(before);
});
it('rolls back schema, all metadata, receipt and pending asks on interruption and detects content damage before commit',()=>{
  const f=setup();
  for(const interrupt of [()=>{throw Error('power');},()=>{f.app.db.prepare("UPDATE secrets_names SET record='{}'").run();},()=>{f.app.db.prepare("DELETE FROM attention_asks").run();}]) {
    expect(()=>importSecrets(f.app.db,f.home,f.from,now,options,{interrupt})).toThrow('Secrets import refused');
    expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('secrets_names','attention_asks')").all()).toEqual([]);
  }
  expect(importSecrets(f.app.db,f.home,f.from,now,options).imported).toBe(true);
});
it('same source after restart is a no-op preserving later edits; different bytes or mapping refuse',()=>{
  const f=setup();importSecrets(f.app.db,f.home,f.from,now,options);
  f.app.db.prepare("UPDATE secrets_names SET record='{}'").run();
  expect(importSecrets(f.app.db,f.home,f.from,now,options).imported).toBe(false);
  expect(f.app.db.prepare('SELECT record FROM secrets_names').get()).toEqual({record:'{}'});
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,{...options,agents:{art:'mark'}})).toThrow('Secrets import refused');
  writeFileSync(join(f.from,'policy.json'),readFileSync(join(f.from,'policy.json'),'utf8')+'\n');
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow('Secrets import refused');
});
it('refuses unknown identities, malformed/value-bearing metadata, pending ask collisions and populated destinations without partial writes',()=>{
  const f=setup();
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,{agents:{art:'absent'},members:options.members})).toThrow('Secrets import refused');
  for(const file of ['policy.json','requests.json']) {
    const before=readFileSync(join(f.from,file));f.put(file,{value:'PLAINTEXT_CANARY'});
    expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused$/);writeFileSync(join(f.from,file),before);
  }
  writeFileSync(join(f.from,'audit.jsonl'),JSON.stringify({at,event:'set',secret:'API',how:'add',value:'PLAINTEXT_CANARY'}));
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused$/);
  writeFileSync(join(f.from,'audit.jsonl'),'');
  expect(readSecretImport(f.from,now,options,{agents:['art'],members:['jonathan']}).records).toEqual([{id:'API',description:'',by:'legacy:unattributed',changedAt:0}]);
  f.app.db.exec('CREATE TABLE attention_asks(id TEXT PRIMARY KEY,record TEXT NOT NULL)');
  f.app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run(pending.id,'{}');
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow();
});
it('checks raw source identity, encrypted-only store contents, duplicate audit keys, future timestamps and exact mappings',()=>{
  const f=setup(),registered={agents:['art','mark'],members:['jonathan']};
  const read=()=>readSecretImport(f.from,now,options,registered);
  f.put('store.sops.json',{API:'PLAINTEXT_CANARY'});expect(read).toThrow(/^Invalid legacy secrets source or identity mapping$/);
  f.put('store.sops.json',{API:'ENC[AES256_GCM,data:fixture]'});
  for(const audit of ['{"at":"'+at+'","event":"read","event":"issue","secret":"API","agent":"art"}',
    JSON.stringify({at:'2099-01-01T00:00:00.000Z',event:'read',secret:'API',agent:'art'}),
    JSON.stringify({at,event:'read',secret:'API',agent:'unknown'})]){
    writeFileSync(join(f.from,'audit.jsonl'),audit);expect(read).toThrow();
  }
  writeFileSync(join(f.from,'audit.jsonl'),'');
  expect(()=>readSecretImport(f.from,now,{agents:{art:'art',other:'art'},members:options.members},registered)).toThrow();
  expect(()=>readSecretImport(f.from,now,{agents:options.agents,members:{jonathan:'absent'}},registered)).toThrow();
});
