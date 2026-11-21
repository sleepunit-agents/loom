import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

const day=86400000;
export function dueKnowledgeDelivery(){
 return withFictionalMemoryHome(async({command,post,open,issue,home,advance})=>{
  const base=Date.parse('2027-01-01T13:17:00.000Z');
  await open(base);
  const moss=issue({kind:'agent',agent:'moss',label:'Fictional alternate checker'});
  const query='query($slug:String!){memoryKnowledgePage(slug:$slug){fresh routineCheckDays sourcing sources{href} by checks{by outcome} checkRevision}}';
  const read=async slug=>(await post('/graphql',{query,variables:{slug}})).data.memoryKnowledgePage;
  const sourceUrl='https://example.invalid/seed-record';
  const add=async(title,source)=>(await command('mind/knowledgeAdd',{domain:'fixture',title,source,body:'Fictional orchard observation.'})).slug;
  const rotated=await add('Three checks by Fern',sourceUrl);
  const ordinary=await add('Ordinary due sample','');
  const verify=async(slug,token)=>command('mind/knowledgeVerify',{slug,expectedRevision:(await read(slug)).checkRevision},token);
  for(let i=0;i<3;i++)await verify(rotated);
  assert.equal((await read(ordinary)).sourcing,'provisional');
  assert.deepEqual((await read(rotated)).sources,[{href:sourceUrl}]);
  const fixture=new Database(join(home,'app.db'),{readonly:true,fileMustExist:true});
  function recipientsAfter(time,slug){
   const rows=fixture.prepare('select "to" as recipient,words from inbox where at>=? and to_kind=? order by at,id').all(new Date(time).toISOString(),'agent');
   return rows.filter(row=>row.words?.includes('Re-check knowledge page '+slug+':')).map(row=>row.recipient);
  }
  try{
   const due=base+30*day;
   // Preserve the schedules across reopen, then trigger the actual daily occurrence on its clock.
   await open(due-1);
   const before=await read(rotated);
   assert.equal(before.fresh,'aging');
   assert.equal(before.routineCheckDays,30);
   assert.equal(before.by,'fern');
   assert.deepEqual(before.checks.map(x=>x.by),['fern','fern','fern']);
   advance(1);
   const current=await read(rotated);
   assert.equal(current.fresh,'due');
   assert.deepEqual(current.checks,before.checks);
   assert.equal((await read(ordinary)).fresh,'due');
   assert.deepEqual(recipientsAfter(due,rotated),['moss']);
   assert.deepEqual(recipientsAfter(due,ordinary),['fern']);
   await verify(rotated,moss);
   assert.equal((await read(ordinary)).sourcing,'provisional');
   const checked=await read(rotated);
   assert.deepEqual(checked.sources,[{href:sourceUrl}]);
   assert.equal(checked.fresh,'fresh');
   assert.equal(checked.checks[0].by,'moss');
   const next=due+30*day;
   await open(next-1);
   advance(1);
   assert.deepEqual(recipientsAfter(next,rotated),['fern']);
   return {ok:true,days:30,reason:'At the 30-day deadline the active page became due and its configured checker received the reminder. The citation persisted, an unsourced control stayed provisional, and an independent check made the page fresh until its next deadline.'};
  }finally{fixture.close();}
 },{alternateCheckingAgent:'moss'});
}
