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
export async function withFictionalMemoryHome(measure,{realEmbedding=false,alternateCheckingAgent}={}) {
 const dir=mkdtempSync(join(tmpdir(),'loom-fictional-memory-'));
 const home=join(dir,'home'),start=Date.parse('2027-01-01T10:40:59.999Z');
 let app, clock, credential;
 async function open(time){
  if(app){await app.close();app=undefined;}
  clock=new FakeClock(time);
  app=await startSharedHome({home,clock,port:0,stdout(){}});
  credential??=app.writes.run(()=>app.services.signin.issue({kind:'agent',agent:'fern',label:'Fictional memory walkthrough'})).value;
 }
 async function post(path,body,status=200,token=credential.token){
  const r=await fetch(app.url+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(r.status,status);
  const value=await r.json();
  assert.equal(value.errors,undefined);
  return value;
 }
 async function command(name,input,token=credential.token){
  const result=await post('/api/'+name,{id:randomUUID(),input},200,token);assert.equal(result.ok,true);return result.value;
 }
 try{
  const example=await exampleHome(home);assert.equal(example.fictional,true);
  const config=join(home,'program.json'),p=JSON.parse(readFileSync(config,'utf8'));
  if(!realEmbedding){
   const adapter=join(home,'fictional-embedding.mjs');
   writeFileSync(adapter,'import previous from '+JSON.stringify(pathToFileURL(p.adapters).href)+';\nexport default async context=>({...await previous(context),memoryEmbedding:()=>({dimensions:4,embed:async()=>[1,0,0,0],embedBatch:async words=>words.map(()=>[1,0,0,0])})});\n',{mode:0o600});
   p.adapters=adapter;
  }
  if(alternateCheckingAgent)p.memory.alternateCheckingAgent=alternateCheckingAgent;
  p.memory.noteSweepAgent='fern';writeFileSync(config,JSON.stringify(p));
  await open(start);
  const issue=input=>app.writes.run(()=>app.services.signin.issue(input)).value.token;
  return await measure({command,post,open,issue,home,advance:ms=>clock.advance(ms),start});
 } finally {
  try {
   if (credential && app) app.writes.run(()=>app.services.signin.revoke(credential.fingerprint));
  } finally {
   try { await app?.close(); } finally { rmSync(dir,{recursive:true,force:true}); }
  }
 }
}
