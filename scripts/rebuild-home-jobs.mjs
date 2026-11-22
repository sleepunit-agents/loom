import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function homeJobs({page,tile,app,example,out}) {
 const screenshot='action-home-jobs.png';
 const cards=new Map(['Fern','Moss'].map(name=>[name.toLowerCase(),tile.getByRole('region',{name:name+' card',exact:true})]));
 const credentials=new Map();
 const active=new Set();
 const machine=example.runtime.box;
 async function event(agent,action) {
  const credential=credentials.get(agent);
  const input={machine,harness:'codex',sessionId:'home-example-'+agent,action};
  if(action==='open')Object.assign(input,{cwd:'/tmp/work-'+agent,model:null});
  const response=await fetch(new URL('/api/terminal/session',app.url),{
   method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},
   body:JSON.stringify({id:'home-job-'+agent+'-'+action,input}),
  });
  assert.equal(response.status,200,agent+' '+action);
  const {value}=await response.json();
  if(action==='open')active.add(agent);else active.delete(agent);
  return value.job;
 }
 const row=(card,agent)=>card.locator('[data-kind="terminal"]').filter({hasText:'work-'+agent});
 const fern=cards.get('fern'),moss=cards.get('moss');
 try {
  for(const agent of cards.keys())credentials.set(agent,app.services.signin.issue({
   kind:'agent',agent,terminalMachine:machine,label:'Home terminal for '+agent,
  },'alex'));
  const mossJob=await event('moss','open');
  assert.notEqual(await event('fern','open'),mossJob);
  await row(fern,'fern').waitFor();
  await row(moss,'moss').waitFor();
  assert.equal(await row(fern,'moss').count(),0);
  assert.equal(await row(moss,'fern').count(),0);
  assert.equal(await moss.locator('.desk-doing').getByText(example.runtime.job.title,{exact:false}).count(),0);
  await tile.screenshot({path:join(out,screenshot)});
  await event('fern','end');
  await row(fern,'fern').waitFor({state:'detached'});
  await row(moss,'moss').waitFor();
  await event('moss','end');
  await row(moss,'moss').waitFor({state:'detached'});
  return {ok:true,screenshot,reason:'Two simultaneous terminal jobs appeared on their respective Home cards, each disappeared on exit, and queued work stayed out of the current-work list.'};
 } catch(error) {
  return {ok:false,error:String(error)};
 } finally {
  try {for(const agent of active)await event(agent,'end');}
  finally {for(const credential of credentials.values())app.services.signin.revoke(credential.fingerprint);}
 }
}
