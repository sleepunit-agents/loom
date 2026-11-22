import assert from 'node:assert/strict';
import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';

export async function deskJobs({page,app,example,out}) {
 const machine=example.runtime.box;
 const credential=app.services.signin.issue({kind:'agent',agent:'moss',terminalMachine:machine,label:'Example desk terminal'},'alex');
 const session={machine,harness:'codex',sessionId:'desk-current'};
 async function event(action,extra={},key=action) {
  const response=await fetch(new URL('/api/terminal/session',app.url),{
   method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},
   body:JSON.stringify({id:'desk-rail-'+key,input:{...session,action,...extra}})
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
   const usage=(runId,revision,tokensOut,completed=false)=>event('usage',{
    runId,revision,description:runId==='main'?null:'Example terminal helper',completed,
    report:{source:'transcript',tokensOut},
   },'usage-'+runId+'-'+revision);
   await usage('main',30,12);
   await usage('helper',8,2);
   await usage('helper',25,9,true);
   await usage('helper',12,4);
   const runs=app.services.comms.db.$client.prepare(`SELECT r.parent,r.run_id,r.revision,r.job,u.tokens_out,j.state
    FROM terminal_runs r JOIN job_usage u ON u.job=r.job JOIN jobs j ON j.id=r.job
    WHERE r.parent=? ORDER BY r.run_id`).all(opened.job);
   assert.equal(runs.length,2);
   const [helper,main]=runs;
   assert.deepEqual(main,{parent:opened.job,run_id:'main',revision:30,job:opened.job,tokens_out:12,state:'running'});
   assert.notEqual(helper.job,opened.job);
   assert.deepEqual(helper,{parent:opened.job,run_id:'helper',revision:25,job:helper.job,tokens_out:9,state:'done'});
  } finally {await event('end');}
  const db=app.services.comms.db.$client;
  const binding=db.prepare('SELECT machine,member FROM terminal_credentials WHERE fingerprint=?').get(credential.fingerprint);
  assert.deepEqual(binding,{machine,member:'alex'});
  const saved=db.prepare(`SELECT s.job,s.thread,s.machine,s.member,s.agent,s.harness,s.session_id,
    c.id AS conversation,c.member AS private_member,c.venue,j.started_by_kind,j.state
    FROM terminal_sessions s JOIN threads t ON t.id=s.thread JOIN conversations c ON c.id=t.conversation
    JOIN jobs j ON j.id=s.job AND j.conversation=c.id AND j.box=s.machine
    WHERE s.job=?`).get(opened.job);
  assert.deepEqual(saved,{...opened,machine,member:'alex',agent:'moss',harness:'codex',session_id:'desk-current',
    private_member:'alex',venue:'terminal',started_by_kind:'terminal',state:'done'});
  await row.waitFor({state:'detached'});
  await mossFace('quiet').waitFor();
  await moss.getByText('Nothing right now.',{exact:true}).waitFor();
  return {ok:true,screenshot,reason:'Fern and Moss showed their own faces. Moss changed from quiet to working beside the Codex terminal’s machine and folder, kept one entry across a heartbeat and returned to quiet on exit. Its queued job stayed out of current work. The terminal credential named the machine and its member. The ended session retained the same parent job and member-private Comms thread. A late transcript report preserved the completed helper’s last revision and cumulative token count.'};
 } catch(error) {return {ok:false,error:String(error)};}
 finally {app.services.signin.revoke(credential.fingerprint);}
}
