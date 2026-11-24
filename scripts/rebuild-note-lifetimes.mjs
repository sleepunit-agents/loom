import assert from 'node:assert/strict';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export function noteLifetimeEvidence() {
 return withFictionalMemoryHome(async ({command,post,open,advance,start})=>{
  const day=86400000;
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
  const edited='revised', editedPath=path(edited);
  const marker='Violet grafting instructions';
  const revisedBody=marker+'\n\nReplace the original handoff in full.';
  const pointer='Find the orchard handoff at '+editedPath;
  const fact=await command('memory/remember',{title:'Fictional orchard handoff',category:'reference',content:pointer,ttl:'permanent'});
  assert.equal(fact.ids.length,1);
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
  await command('memory/noteWrite',{path:editedPath,body:'Old orchard handoff',lifespan:'short'});
  await open(start+13*day);
  await command('memory/noteWrite',{path:editedPath,body:revisedBody});
  assert.deepEqual(await read(edited),{path:editedPath,body:revisedBody,lifespan:'short'});
  const listing=await post('/graphql',{query:'query($path:String!){memoryNotes(agent:"fern",prefix:$path){path expires}}',variables:{path:editedPath}});
  assert.deepEqual(listing.data.memoryNotes,[{path:editedPath,expires:new Date(start+27*day).toISOString()}]);
  const recalled=await command('memory/recall',{query:marker,limit:20});
  assert.deepEqual(recalled.ids,fact.ids);
  const identity=await post('/graphql',{query:'{memoryIdentity(agent:"fern"){topOfMind}}'});
  assert.ok(identity.data.memoryIdentity.topOfMind.includes(pointer));
  assert.ok(!identity.data.memoryIdentity.topOfMind.includes(marker));
  advance(1);
  await verify(names);
  await open(start+14*day);
  await verify(names);
  advance(1);
  await verify(['keep','while','cited']);
  await command('tasks/command',{action:'close',id:task.id,reason:'Fictional follow-up completed'});
  await open(start+15*day);
  advance(1);
  await verify(['keep','while']);
  await open(start+27*day);
  assert.equal((await read(edited)).body,revisedBody);
  advance(1);
  assert.equal(await read(edited),null);
  await open(start+59*day);
  advance(1);
  await verify(['keep','while']);
  // March 2, before the North American daylight-saving transition.
  await open(start+60*day);
  await verify(['keep','while']);
  advance(1);
  await verify(['keep']);
  return {ok:true,reason:'A whole-note edit replaced the previous body and renewed the 14-day deadline. Recall and top of mind contained the pointing fact. The note text was available by path. After restart, the nightly sweep expired an uncited short note at 14 days and a while note at 60 days. A keep note survived, as did a short note while its task was open.',editedNoteExpiredAfterRenewal:true,onlyFactRecalled:true,configuredAgent:'fern',bodiesAndPathsRetained:true,after14DaySweep:['keep','while','cited'],afterCitingTaskClosed:['keep','while'],after60Days:['keep']};
 });
}
