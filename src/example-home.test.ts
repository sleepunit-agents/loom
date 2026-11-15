import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome,runExampleHome} from './example-home.js';
import {FakeClock} from './core/clock.js';
import {startSharedHome} from './shared-startup.js';
it('builds fictitious data through services, then normal startup signs in and queries it',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-test-')),home=join(parent,'home');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const output:string[]=[],errors:string[]=[];
  expect(await runExampleHome([],text=>output.push(text),text=>errors.push(text))).toBe(2);
  expect(await runExampleHome([home],text=>output.push(text),text=>errors.push(text))).toBe(0);
  const manifest=JSON.parse(output[0]);
  expect(statSync(join(home,'comms.key')).mode & 0o077).toBe(0);
  expect(manifest.tasks).toHaveLength(4);expect(manifest.gaps.map((g:{page:string})=>g.page)).toEqual(['people','machines']);
  const before=readFileSync(join(home,'app.db'));
  await expect(exampleHome(home)).rejects.toThrow();expect(readFileSync(join(home,'app.db'))).toEqual(before);
  mkdirSync(join(parent,'public'));writeFileSync(join(parent,'public','next.html'),'<main>Example entry</main>');
  const clock=new FakeClock(Date.now());
  let link='';app=await startSharedHome({home,clock,webRoot:join(parent,'public'),port:0,stdout:text=>{link=text.trim();}});
  const response=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});
  expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  const query=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id title status } approvals { id state } triggers { id } modelAccounts { ... on RuntimeAccountDetail { id label } } }'})});
  const result=await query.json();expect(result.errors).toBeUndefined();
  expect(result.data.tasks).toHaveLength(4);expect(result.data.tasks.map((t:{status:string})=>t.status)).toContain('in_progress');
  expect(result.data.approvals).toEqual([expect.objectContaining({state:'pending'})]);
  expect(result.data.modelAccounts).toEqual([expect.objectContaining({label:'Example model subscription'})]);
  const command=async(name:string,input:unknown,id:string)=>{
   const response=await fetch(app!.url+'/api/'+name.replace('.','/'),{method:'POST',headers:{cookie,origin:app!.url,'content-type':'application/json'},body:JSON.stringify({id,input})});expect(response.status).toBe(200);
  };
  const trigger=async()=>{
   const response=await fetch(app!.url+'/graphql',{method:'POST',headers:{cookie,origin:app!.url,'content-type':'application/json'},body:JSON.stringify({query:'query Watch($id:String!){triggers(where:{id:{eq:$id}}){state lastFiredAt} triggerLog(where:{trigger:{eq:$id}}){event}}',variables:{id:manifest.trigger}})});const data=await response.json();expect(data.errors).toBeUndefined();return data.data;
  };
  await command('tempo.pause',{agent:manifest.agents[0]},'pause-example');
  await command('approvals.answer',{id:manifest.approval,answer:'allow'},'answer-example');
  expect((await trigger()).triggers).toEqual([{state:'held',lastFiredAt:null}]);
  await command('tempo.resume',{agent:manifest.agents[0]},'resume-example');
  const fired=await trigger();expect(fired.triggers[0].state).toBe('fired');expect(fired.triggerLog.filter((row:{event:string})=>row.event==='fired')).toHaveLength(1);
  const read=async(query:string)=>{const response=await fetch(app!.url+'/graphql',{method:'POST',headers:{cookie,origin:app!.url,'content-type':'application/json'},body:JSON.stringify({query})});const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
  const timeTrigger=(id:string)=>({id,ownerKind:'household',sourceKind:'time',times:new Date(clock.now()+60_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'person',to:'alex',instructions:'Example manual notice',note:id});
  await command('tempo.set',timeTrigger('manual-notice'),'set-notice');await command('tempo.runNow',{id:'manual-notice'},'run-notice');
  const selection='{inboxItems(source:"trigger"){id sourceId refs body{words}} settledInboxNotice{id count}}';
  const delivered=await read(selection);expect(delivered.inboxItems).toEqual([expect.objectContaining({sourceId:expect.stringMatching(/^manual-notice:/),refs:['manual-notice'],body:{words:'Example manual notice'}})]);
  clock.advance(4999);expect((await read(selection)).settledInboxNotice).toBeNull();clock.advance(1);expect((await read(selection)).settledInboxNotice.count).toBe(2);
  await command('tempo.set',timeTrigger('cancel-notice'),'set-cancel');await command('tempo.stop',{id:'cancel-notice'},'cancel-notice');clock.advance(60_000);
  expect((await read(selection)).inboxItems).toHaveLength(1);


 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});
