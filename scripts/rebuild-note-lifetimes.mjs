import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';

// The clock starts one millisecond before the Chicago household's nightly sweep.
export async function noteLifetimeEvidence() {
 const dir=mkdtempSync(join(tmpdir(),'loom-fictional-notes-'));
 const home=join(dir,'home'),day=86400000,start=Date.parse('2027-01-01T10:40:59.999Z');
 let app, clock, credential;
 async function open(time){
  if(app){await app.close();app=undefined;}
  clock=new FakeClock(time);
  app=await startSharedHome({home,clock,port:0,stdout(){}});
  credential??=app.writes.run(()=>app.services.signin.issue({kind:'agent',agent:'fern',label:'Fictional lifespan observation'})).value;
 }
 async function post(path,body){
  const r=await fetch(app.url+path,{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(r.status,200);
  const value=await r.json();
  assert.equal(value.errors,undefined);
  return value;
 }
 async function command(name,input){
  const result=await post('/api/'+name,{id:randomUUID(),input});assert.equal(result.ok,true);return result.value;
 }
 const names=['keep','while','short','cited'];
 const path=name=>'fictional/lifetime/'+name;
 const body=name=>'Fictional orchard handoff\n\nA longer paragraph for '+name+'.\n';
 async function read(name){
  const {data}=await post('/graphql',{query:'query($path:String!){memoryNote(agent:"fern",path:$path){path body lifespan}}',variables:{path:path(name)}});
  return data.memoryNote;
 }
 async function verify(visible){
  for(const name of names){
   const expected=visible.includes(name)?{path:path(name),body:body(name),lifespan:name==='cited'?'short':name}:null;
   assert.deepEqual(await read(name),expected);
  }
 }
 try{
  const example=await exampleHome(home);assert.equal(example.fictional,true);
  const config=join(home,'program.json'),p=JSON.parse(readFileSync(config,'utf8'));
  const adapter=join(home,'fictional-embedding.mjs');
  writeFileSync(adapter,'import previous from '+JSON.stringify(pathToFileURL(p.adapters).href)+';\nexport default async context=>({...await previous(context),memoryEmbedding:()=>({dimensions:4,embed:async()=>[1,0,0,0],embedBatch:async words=>words.map(()=>[1,0,0,0])})});\n',{mode:0o600});
  p.adapters=adapter;
  p.memory.noteSweepAgent='fern';writeFileSync(config,JSON.stringify(p));
  await open(start);
  await command('memory/remember',{title:'Fictional orchard date',category:'reference',content:'The fictional orchard was planted in January.',ttl:'permanent'});
  for(const name of names)await command('memory/noteWrite',{path:path(name),body:body(name),lifespan:name==='cited'?'short':name});
  const task=await command('tasks/command',{action:'create',input:{title:'Fictional orchard follow-up',goal:'Review note:'+path('cited'),why:'Fictional retention evidence',owner:{kind:'agent',id:'fern'}}});
  await verify(names);
  const {data}=await post('/graphql',{query:'{memoryNotes(agent:"fern",prefix:"fictional/lifetime/"){path lifespan expires}}'});
  const deadlines={keep:null,while:60,short:14,cited:14};
  const expectedRows=names.map(name=>({
   path:path(name),lifespan:name==='cited'?'short':name,
   expires:deadlines[name]===null?null:new Date(start+deadlines[name]*day).toISOString(),
  }));
  const byPath=(a,b)=>a.path.localeCompare(b.path);
  assert.deepEqual(data.memoryNotes.sort(byPath),expectedRows.sort(byPath));
  await open(start+13*day);
  clock.advance(1);
  await verify(names);
  await open(start+14*day);
  await verify(names);
  clock.advance(1);
  await verify(['keep','while','cited']);
  await command('tasks/command',{action:'close',id:task.id,reason:'Fictional follow-up completed'});
  await open(start+15*day);
  clock.advance(1);
  await verify(['keep','while']);
  await open(start+59*day);
  clock.advance(1);
  await verify(['keep','while']);
  // March 2, before the North American daylight-saving transition.
  await open(start+60*day);
  await verify(['keep','while']);
  clock.advance(1);
  await verify(['keep']);
  return {ok:true,reason:'The configured agent wrote and read whole documents by path. After restart, the nightly sweep expired an uncited short note at 14 days and a while note at 60 days. A keep note survived, as did a short note while its task was open.',configuredAgent:'fern',bodiesAndPathsRetained:true,after14DaySweep:['keep','while','cited'],afterCitingTaskClosed:['keep','while'],after60Days:['keep']};
 } finally {
  try {
   if (credential && app) app.writes.run(()=>app.services.signin.revoke(credential.fingerprint));
  } finally {
   try { await app?.close(); } finally { rmSync(dir,{recursive:true,force:true}); }
  }
 }
}
