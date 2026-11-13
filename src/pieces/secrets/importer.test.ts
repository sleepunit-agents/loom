import fs from 'node:fs';
import subprocess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
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
  expect(legacy.requests).toEqual([request,pending]);
  const ask=JSON.parse((f.app.db.prepare('SELECT record FROM attention_asks WHERE id=?').get(pending.id) as {record:string}).record);
  expect(ask).toMatchObject({sourceManaged:true,createdAt:Date.parse(at),changedAt:Date.parse(at)});
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
    expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused: policy-request-plan$/);writeFileSync(join(f.from,file),before);
  }
  writeFileSync(join(f.from,'audit.jsonl'),JSON.stringify({at,event:'set',secret:'API',how:'add',value:'PLAINTEXT_CANARY'}));
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused: audit-schema$/);
  writeFileSync(join(f.from,'audit.jsonl'),'');
  expect(readSecretImport(f.from,now,options,{agents:['art'],members:['jonathan']}).records).toEqual([{id:'API',description:'',by:'legacy:unattributed',changedAt:0}]);
  f.app.db.exec('CREATE TABLE attention_asks(id TEXT PRIMARY KEY,record TEXT NOT NULL)');
  f.app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run(pending.id,'{}');
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow();
});
it('checks raw source identity, encrypted-only store contents, duplicate audit keys, future timestamps and exact mappings',()=>{
  const f=setup(),registered={agents:['art','mark'],members:['jonathan']};
  const read=()=>readSecretImport(f.from,now,options,registered);
  f.put('store.sops.json',{API:'PLAINTEXT_CANARY'});expect(read).toThrow(/^Invalid legacy secrets source or identity mapping: encrypted-store$/);
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

it('persists original reciprocal carry metadata without inventing carried attribution or reviving the moved house',()=>{
 const f=setup(),carried={...request,id:'q-23456789',house:'h-4',who:undefined,carriedFrom:request.id};
 const original={...request,claimedBy:carried.id};
 f.put('requests.json',{v:1,requests:{[original.id]:original,[carried.id]:carried,[pending.id]:pending}});
 expect(importSecrets(f.app.db,f.home,f.from,now,options).grants).toBe(2);
 const legacy=JSON.parse((f.app.db.prepare("SELECT value FROM secrets_meta WHERE key='legacy-snapshot'").get() as {value:string}).value);
 expect(legacy.requests).toEqual([original,JSON.parse(JSON.stringify(carried)),pending]);
 const role=grantsRole(f.app.db),resource={kind:'secret' as const,target:'API'};
 expect(role.mayUse('art',resource,now,{house:'h-1',service:'discord'})).toBe(false);
 expect(role.mayUse('art',resource,now,{house:'h-4',service:'discord'})).toBe(true);
});

it('reads only the four copied metadata inputs and invokes no decryptor, child program or source write',()=>{
 const f=setup(),inputs=new Map(['store.sops.json','policy.json','requests.json','audit.jsonl'].map(n=>[join(f.from,n),readFileSync(join(f.from,n))]));
 const read=vi.spyOn(fs,'readFileSync').mockImplementation(path=>{const b=inputs.get(String(path));if(!b)throw Error('Unexpected source read');return b;});
 const writes=(['writeFileSync','appendFileSync','renameSync','unlinkSync'] as const).map(name=>vi.spyOn(fs,name).mockImplementation(()=>{throw Error('Source write');}));
 const processes=(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const).map(name=>vi.spyOn(subprocess,name).mockImplementation(()=>{throw Error('Legacy program');}));
 syncBuiltinESMExports();
 try {
  expect(readSecretImport(f.from,now,options,{agents:['art'],members:['jonathan']}).records.map(r=>r.id)).toEqual(['API']);
  expect(read.mock.calls.map(c=>String(c[0])).sort()).toEqual([...inputs.keys()].sort());
  for(const spy of [...writes,...processes])expect(spy).not.toHaveBeenCalled();
 } finally {vi.restoreAllMocks();syncBuiltinESMExports();}
});

it('imports the reported synthetic inventory and retains the validated audit text byte-exact',()=>{
  const f=setup(),member='jonathan-barket';
  // Synthetic shapes/counts from the coordinator, never copied credential data.
  const names=Array.from({length:62},(_,i)=>`KEY_${i}`);
  f.put('store.sops.json',Object.fromEntries(names.map(n=>[n,'ENC[AES256_GCM,data:SYNTHETIC]'])));
  f.put('policy.json',{v:1,default:'ask',secrets:{KEY_0:{grant:'ask',houses:['art','mark']}}});
  const requests=Array.from({length:99},(_,i)=>{
    const id=`q-${i.toString(16).padStart(8,'0')}`,policy=i%2===0;
    return [id,{id,secret:names[i%62],agent:'art',house:`h-${i+1}`,why:'fixture',minutes:60,
      at,state:'granted',by:policy?'policy':'owner',...(policy?{}:{who:member}),decided:at,
      expires:'2026-11-13T12:59:00.000Z',...(i%3===0?{}:{service:i%3===1?'discord':'discord-bodies'})}];
  });
  f.put('requests.json',{v:1,requests:Object.fromEntries(requests)});
  const counts={request:99,read:402,'refused-read':291,grant:12,always:3,'houses-allow':13,'houses-stop':1,'host-read':14025,issue:15315};
  const events=Object.entries(counts).flatMap(([event,count])=>Array.from({length:count},(_,i)=>({
    at:event==='always'&&i===0?'2026-10-28T11:33:18.985771Z':at,event,secret:names[i%62],
    agent:i%2?'art':'mark',why:'fixture',
    by:event==='host-read'&&i<14?null:(['owner','policy','runtime'] as const)[i%3],
    ...(i%2?{who:member}:{}),...(i%2?{how:'get'}:{}),
  })));
  expect(events).toHaveLength(30161);
  // Include noncanonical JSON spacing and CRLF to distinguish exact retention
  // from reserialization; all lines must still pass the value-free schema.
  const auditText='\uFEFF'+events.map(e=>'  '+JSON.stringify(e)+' \r').join('\n')+'\n';
  writeFileSync(join(f.from,'audit.jsonl'),auditText);
  // Fixture household has jonathan; explicit source mapping preserves attribution.
  const mapped={agents:{art:'art',mark:'mark'},members:{[member]:'jonathan'}};
  expect(importSecrets(f.app.db,f.home,f.from,now,mapped)).toMatchObject({names:62,requests:99,grants:99});
  const stored=JSON.parse((f.app.db.prepare("SELECT value FROM secrets_meta WHERE key='legacy-snapshot'").get() as {value:string}).value);
  expect(Buffer.from(stored.auditText)).toEqual(Buffer.from(auditText));
  expect(stored.audit).toEqual(events);expect(stored.requests).toHaveLength(99);
  expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_uses').get()).toEqual({n:30033});
  expect(readFileSync(join(f.from,'audit.jsonl'),'utf8')).toBe(auditText);
},30_000);

it.each(['','1','12','123','123456','123456789012'])('accepts legacy fractional precision %s and projects milliseconds without changing originals',fraction=>{
  const f=setup(),stamp=`2026-11-13T11:59:00${fraction?'.'+fraction:''}Z`;
  const original={at:stamp,event:'set',secret:'API',how:'add'};
  const auditText=JSON.stringify(original)+'\n';writeFileSync(join(f.from,'audit.jsonl'),auditText);
  // Request timestamps use the same legacy precision rules.
  const expires=`2026-11-13T12:59:00${fraction?'.'+fraction:''}Z`;
  f.put('requests.json',{v:1,requests:{[request.id]:{...request,at:stamp,decided:stamp,expires}}});
  const projected=readSecretImport(f.from,now,options,{agents:['art'],members:['jonathan']});
  expect(projected.records[0].changedAt).toBe(Date.parse(stamp));
  expect(projected.requests[0].createdAt).toBe(Date.parse(stamp));
  expect(projected.legacy.auditText).toBe(auditText);expect(projected.legacy.audit).toEqual([original]);
  expect(importSecrets(f.app.db,f.home,f.from,now,options).imported).toBe(true);
});

it('reports fixed source checks through the importer without reflecting malicious fields or values',()=>{
  const f=setup(),bad='PRIVATE_CANARY';
  f.put('policy.json',{[bad]:bad});
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused: policy-request-plan$/);
  f.put('policy.json',{});
  for(const at of ['2026-02-30T11:59:00Z','2026-11-13T11:59:00.Z',bad]){
    writeFileSync(join(f.from,'audit.jsonl'),JSON.stringify({at,event:'always',secret:'API',why:bad}));
    expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused: audit-schema$/);
  }
  writeFileSync(join(f.from,'audit.jsonl'),JSON.stringify({at,event:'read',secret:'API',agent:bad}));
  expect(()=>importSecrets(f.app.db,f.home,f.from,now,options)).toThrow(/^Secrets import refused: audit-projection$/);
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name='secrets_meta'").all()).toEqual([]);
});
