import assert from 'node:assert/strict';
import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';

export async function deskJobs({page,app,example,out}) {
 const machine=example.runtime.box;
 const credential=app.services.signin.issue({kind:'agent',agent:'moss',terminalMachine:machine,label:'Example desk terminal'},'alex');
 const session={machine,harness:'codex',sessionId:'desk-current'};
 async function event(action,extra={}) {
  const response=await fetch(new URL('/api/terminal/session',app.url),{
   method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},
   body:JSON.stringify({id:'desk-rail-'+action,input:{...session,action,...extra}})
  });
  assert.equal(response.status,200,action);
  return (await response.json()).value;
 }
 const rail=page.getByRole('complementary',{name:'Your agents',exact:true});
 const fern=rail.getByRole('region',{name:'Fern rail card',exact:true});
 const moss=rail.getByRole('region',{name:'Moss rail card',exact:true});
 const mossFace=state=>moss.getByRole('img',{name:'Moss, '+state,exact:true});
 const row=moss.locator('[data-kind="terminal"]').filter({hasText:'At a terminal on Example workshop · codex · sundial'});
 const screenshot='action-deskJobs.png';
 try {
  const queued=example.runtime.job;
  const {currentJobs,agentDoing}=await browserRead(page,'{currentJobs(agent:"moss"){id state} agentDoing(agent:"moss"){items{id}}}');
  assert(currentJobs.some(item=>item.id===queued.id&&item.state==='queued'),'Expected the shed job to be queued');
  assert(!agentDoing.items.some(item=>item.id===queued.id),'The queued job appeared as current work');
  await fern.getByRole('img',{name:/^Fern, /}).and(fern.locator('[data-shape="pebble"]')).waitFor();
  await mossFace('quiet').and(moss.locator('[data-shape="drop"]')).waitFor();
  await moss.getByText('Nothing right now.',{exact:true}).waitFor();
  const opened=await event('open',{cwd:'/tmp/sundial',model:null});
  try {
   await row.waitFor();
   await mossFace('working').waitFor();
   await moss.getByText('Working',{exact:true}).waitFor();
   assert.equal((await event('heartbeat')).job,opened.job);
   assert.equal(await row.count(),1);
   assert.equal(await rail.getByText(queued.title,{exact:false}).count(),0);
   await page.screenshot({path:join(out,screenshot),fullPage:true});
  } finally {await event('end');}
  await row.waitFor({state:'detached'});
  await mossFace('quiet').waitFor();
  await moss.getByText('Nothing right now.',{exact:true}).waitFor();
  return {ok:true,screenshot,reason:'Fern and Moss showed their own faces. Moss changed from quiet to working beside the Codex terminal’s machine and folder, kept one entry across a heartbeat and returned to quiet on exit. Its queued job stayed out of current work.'};
 } catch(error) {return {ok:false,error:String(error)};}
 finally {app.services.signin.revoke(credential.fingerprint);}
}
