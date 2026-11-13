import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { FakeClock } from './core/clock.js';
import { HouseholdDatabase } from './core/household/document.js';
import { SharingDatabase } from './core/household/sharing.js';
import { change } from './pieces/changes/fixture.js';
import { replaceChanges } from './pieces/changes/store.js';
import { fixtureSharing } from './fixture.js';
import { installApprovals } from './pieces/approvals/index.js';

it('next Changes answers through real owner Approvals and keeps exact-head and current ownership checks', async()=>{
 const home=mkdtempSync(join(tmpdir(),'changes-approvals-'));
 const loom=await startLoom({home,next:true,clock:new FakeClock(Date.parse('2026-11-13T00:00:00Z')),stdout:()=>{},authenticate:req=>({viewer:{kind:'member',id:String(req.headers.authorization)},valid:()=>true})});
 let serial=0;
 const owner={kind:'member' as const,id:'jonathan'};
 const call=(name:string,input:object={},viewer=owner)=>loom.operations.call('direct',viewer,name,input,`test-${++serial}`);
 const answer=async(action:string,head=change().head.id,who='jonathan',person?:string)=>{
  const response=await fetch(`${loom.url}/api/changes/answer`,{method:'POST',headers:{authorization:who,'content-type':'application/json'},body:JSON.stringify({id:`http-${++serial}`,input:{id:change().id,head,action,...(person?{person}:{})}})});
  return response.json();
 };
 const target=`${change().id}@${change().head.id}`;
 const show=()=>call('changes.show',{id:change().id});
 try {
  loom.db.transaction(()=>{
   new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'},{person:'pollock',role:'member',agents:['art']}]});
   new SharingDatabase(loom.db,home).create({slug:'pond',name:'Pond',repositories:['acme/app'],members:['pollock'],agents:['art']});
   replaceChanges(loom.db,[change()]);
  })();
  expect(call('household.setAgentAccounts',{agent:'art',accounts:{github:['art-bot']}})).toMatchObject({ok:true});
  expect(show()).toMatchObject({ok:true,value:{group:'you',rule:{tier:'ask'}}});
  expect(call('changes.confirm',{id:change().id,head:change().head.id})).toMatchObject({ok:true,value:{open:true}});
  expect(await answer('yes',change().head.id,'pollock')).toMatchObject({ok:false,code:'denied'});
  expect(await answer('yes','b'.repeat(40))).toMatchObject({ok:false,code:'conflict'});
  expect(call('approvals.list')).toMatchObject({ok:true,value:{approvals:[]}});
  expect(await answer('not-yet')).toMatchObject({ok:true,value:{state:'denied',for:'owner',who:{agent:'art'},target}});
  expect(show()).toMatchObject({ok:true,value:{group:'you',status:'You said not yet'}});
  expect(await answer('yes')).toMatchObject({ok:true,value:{state:'allowed',for:'owner',who:{agent:'art'},target}});
  expect(show()).toMatchObject({ok:true,value:{group:'agent'}});
  expect(await answer('yes')).toMatchObject({ok:false,code:'conflict'});
  // A new head cannot inherit a previous grant.
  loom.db.transaction(()=>replaceChanges(loom.db,[change({head:{id:'b'.repeat(40),ref:'art/new'}})]))();
  expect(show()).toMatchObject({ok:true,value:{group:'you'}});
  // Fail the actual grant write after the project rule write, inside the real outer operation.
  loom.db.exec("CREATE TRIGGER fail_changes_grant BEFORE INSERT ON approvals_approvals BEGIN SELECT RAISE(ABORT, 'test grant failure'); END");
  expect(await answer('always','b'.repeat(40))).toMatchObject({ok:false,code:'unavailable'});
  expect(call('approvals.rules')).toMatchObject({ok:true,value:{rules:[]}});
  expect(call('approvals.list')).toMatchObject({ok:true,value:{approvals:[{target},{target}]}});
  loom.db.exec('DROP TRIGGER fail_changes_grant');
  expect(await answer('always','b'.repeat(40))).toMatchObject({ok:true,value:{state:'allowed',target:`${change().id}@${'b'.repeat(40)}`}});
  expect(call('approvals.rules')).toMatchObject({ok:true,value:{rules:[{scope:'project:pond',tier:'do'}]}});
  expect(show()).toMatchObject({ok:true,value:{group:'agent',rule:{tier:'do'}}});
  loom.db.transaction(()=>new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art'],members:[{person:'pollock',role:'owner',agents:'*'},{person:'jonathan',role:'member',agents:['art']}]}))();
  expect(await answer('yes','b'.repeat(40))).toMatchObject({ok:false,code:'denied'});
  expect(show()).toMatchObject({ok:false,code:'denied'});
 } finally {await loom.close();rmSync(home,{recursive:true,force:true});}
});

it('real person-specific pending requests are answered without becoming owner grants',async()=>{
 const home=mkdtempSync(join(tmpdir(),'changes-person-'));
 let principal='pollock';
 // Runtime authentication supplies the Caller to Approvals, never to Changes.
 const loom=await startLoom({home,next:true,sharing:fixtureSharing,stdout:()=>{},clock:new FakeClock(Date.parse('2026-11-13T00:00:00Z')),install:app=>installApprovals(app.db,app.operations,app.live,fixtureSharing,{caller:viewer=>viewer.kind==='agent'?{who:{agent:viewer.id,where:'authenticated runtime'},for:principal}:undefined})});
 const owner={kind:'member' as const,id:'jonathan'};
 let serial=0;
 const call=(name:string,input:object={},viewer:import('./core/index.js').Viewer=owner)=>loom.operations.call('direct',viewer,name,input,`person-${++serial}`);
 try {
  loom.db.transaction(()=>{
   new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'}]});
   replaceChanges(loom.db,[change()]);
  })();
  expect(call('household.setAgentAccounts',{agent:'art',accounts:{github:['art-bot']}})).toMatchObject({ok:true});
  const request=call('approvals.request',{kind:'merge',target:`${change().id}@${change().head.id}`,what:'merge the change',why:'ready',ask:'Merge this change?',if_yes:'I merge it.',if_no:'I leave it open.'},{kind:'agent',id:'art'});
  expect(request).toMatchObject({ok:true});
  principal='loren';
  expect(call('approvals.request',{kind:'merge',target:`${change().id}@${change().head.id}`,what:'merge the change',why:'ready',ask:'Merge this change?',if_yes:'I merge it.',if_no:'I leave it open.'},{kind:'agent',id:'art'})).toMatchObject({ok:true});
  principal='dan';
  expect(call('approvals.request',{kind:'merge',target:`${change().id}@${change().head.id}`,what:'merge the change',why:'ready',ask:'Merge this change?',if_yes:'I merge it.',if_no:'I leave it open.'},{kind:'agent',id:'art'})).toMatchObject({ok:true});
  expect(call('changes.show',{id:change().id})).toMatchObject({ok:true,value:{rule:{for:{slug:'pollock',state:'pending'}}}});
  const input={id:change().id,head:change().head.id,action:'yes'};
  expect(call('changes.answer',input)).toMatchObject({ok:false,code:'conflict'});
  expect(call('changes.answer',{...input,person:'pollock',action:'always'})).toMatchObject({ok:false,code:'conflict'});
  expect(call('changes.answer',{...input,person:'pollock'})).toMatchObject({ok:true,value:{for:'pollock',state:'allowed'}});
  expect(call('approvals.list')).toMatchObject({ok:true,value:{approvals:expect.arrayContaining([expect.objectContaining({for:'pollock',state:'allowed'}),expect.objectContaining({for:'loren',state:'pending'})])}});
  expect(call('changes.show',{id:change().id})).toMatchObject({ok:true,value:{group:'you',rule:{for:{slug:'loren',state:'pending'}}}});
  // Existing Approvals contract: a newer denial revokes sibling answers across principals.
  expect(call('changes.answer',{...input,person:'loren',action:'not-yet'})).toMatchObject({ok:true,value:{for:'loren',state:'denied'}});
  expect(call('approvals.list')).toMatchObject({ok:true,value:{approvals:expect.arrayContaining([expect.objectContaining({for:'loren',state:'denied'}),expect.objectContaining({for:'pollock',state:'denied'}),expect.objectContaining({for:'dan',state:'denied'})])}});
 } finally {await loom.close();rmSync(home,{recursive:true,force:true});}
});

it('Changes Yes and Not yet preserve pending authenticated conversation requests',async()=>{
 const home=mkdtempSync(join(tmpdir(),'changes-conversation-'));
 const conversation='cv-0123456789ab';
 const loom=await startLoom({home,next:true,sharing:fixtureSharing,stdout:()=>{},clock:new FakeClock(Date.parse('2026-11-13T00:00:00Z')),install:app=>installApprovals(app.db,app.operations,app.live,fixtureSharing,{caller:viewer=>viewer.kind==='agent'?{who:{agent:viewer.id,where:'authenticated runtime'},for:'pollock',conversation}:undefined})});
 let serial=0;
 const call=(name:string,input:object={},viewer:import('./core/index.js').Viewer={kind:'member',id:'jonathan'})=>loom.operations.call('direct',viewer,name,input,`conversation-${++serial}`);
 try {
  loom.db.transaction(()=>{
   new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'}]});
   replaceChanges(loom.db,[change()]);
  })();
  expect(call('household.setAgentAccounts',{agent:'art',accounts:{github:['art-bot']}})).toMatchObject({ok:true});
  const request=call('approvals.request',{kind:'merge',target:`${change().id}@${change().head.id}`,conversation,what:'merge the change',why:'ready',ask:'Merge this change?',if_yes:'I merge it.',if_no:'I leave it open.'},{kind:'agent',id:'art'});
  expect(request).toMatchObject({ok:true,value:{state:'pending',conversation}});
  const pending=(request as {value:{id:string}}).value.id;
  const input={id:change().id,head:change().head.id,person:'pollock'};
  expect(call('changes.answer',{...input,action:'yes'})).toMatchObject({ok:true,value:{state:'allowed',for:'pollock',granted:true}});
  expect(call('approvals.list')).toMatchObject({ok:true,value:{approvals:expect.arrayContaining([expect.objectContaining({id:pending,state:'pending',conversation}),expect.objectContaining({state:'allowed',granted:true})])}});
  expect(call('changes.answer',{...input,action:'not-yet'})).toMatchObject({ok:true,value:{state:'denied',for:'pollock',granted:true}});
  const cards=call('approvals.list');
  expect(cards).toMatchObject({ok:true,value:{approvals:expect.arrayContaining([expect.objectContaining({id:pending,state:'pending',conversation}),expect.objectContaining({state:'denied',granted:true})])}});
  expect((cards as {value:{approvals:{state:string}[]}}).value.approvals.filter(a=>a.state==='allowed')).toEqual([]);
 } finally {await loom.close();rmSync(home,{recursive:true,force:true});}
});
