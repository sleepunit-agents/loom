import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

/** A separate fictional roster exercises every fallback face without changing the main desk. */
export async function deskFaces({browser,home,out}){
 let app,context;
 try {
  await exampleHome(home);
  const shapes=['pebble','trefoil','clover','drop'], states={waiting:'thinking',working:'working',offline:'error'};
  const db=new Database(join(home,'app.db'),{fileMustExist:true});
  try {
    const add=(id,shape,eyes,state)=>{
      db.prepare('insert into agents(id,about,mark_bg,mark_fg,face_shape,face_eyes) values(?,?,?,?,?,?)').run(id,'Fixture','#B8A6FF','#fff',shape,eyes);
      db.prepare('insert into member_agents(member,agent) values(?,?)').run('robin',id);
      db.prepare('insert into agent_status(agent,state,work,changed_at) values(?,?,?,?)').run(id,state,'',new Date().toISOString());
    };
    db.transaction(()=>{
      for (const shape of shapes) for (const eyes of ['dot','oval']) add('face-'+shape+'-'+eyes,shape,eyes,'idle');
      for (const state of Object.keys(states)) add('face-'+state,'pebble','dot',state);
      add('face-ask','pebble','dot','idle');
    })();
  }finally{db.close();}
  app=await startSharedHome({home,port:0,stdout(){}});
  const service=app.services.comms;
  const open=agent=>app.writes.run(()=>service.threads.open({agent,member:'robin',title:'Fixture face states'})).value;
  const asking=open('face-ask');
  app.writes.run(await service.prepareAsk(asking.id,'face-ask','face-ask-1',{words:'Review fixture?',why:'Exercise the real waiting state',answers:'yes-no'}));
  const replying=open('face-pebble-dot');
  context=await browser.newContext({viewport:{width:1600,height:1100},reducedMotion:'no-preference',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.signinLink('robin'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const face=id=>page.locator('.desk-home-card[data-agent="face-'+id+'"] svg[data-slot="agent-face"]');
  const seen=new Map();
  for (const shape of shapes) for (const eyes of ['dot','oval']) {
    const f=face(shape+'-'+eyes);await f.scrollIntoViewIfNeeded();
    const snapshot=await f.evaluate(el=>({
      shape:el.dataset.shape,state:el.dataset.state,
      outline:el.querySelector('.loom-face__field > path').getAttribute('d'),
      eye:[...el.querySelectorAll('.loom-face__eyes > *')].filter(e=>getComputedStyle(e).fill!=='none').map(e=>e.localName),
      box:el.getBoundingClientRect().width
    }));
    assert.equal(snapshot.shape,shape);assert.equal(snapshot.state,'idle');
    assert.deepEqual(snapshot.eye,[eyes==='dot'?'circle':'ellipse',eyes==='dot'?'circle':'ellipse']);
    assert(snapshot.box>0&&snapshot.outline.length>20);
    if(seen.has(shape))assert.equal(snapshot.outline,seen.get(shape));
    seen.set(shape,snapshot.outline);
  }
  assert.equal(new Set(seen.values()).size,4);
  const labels={thinking:'thinking',working:'working',error:'needs a look','needs-input':'waiting on you',talking:'talking',complete:'done',idle:'quiet'};
  for (const [agent,state] of Object.entries({...states,ask:'needs-input'})) {
    await face(agent).waitFor();
    await page.waitForFunction(({id,state})=>document.querySelector('.desk-home-card[data-agent="face-'+id+'"] svg')?.dataset.state===state,{id:agent,state});
    assert.ok((await face(agent).getAttribute('aria-label')).endsWith(', '+labels[state]));
  }
  await page.goto(app.url+'/p/comms-preview/thread/'+encodeURIComponent(replying.id.replace(/^th:/,'')));
  const live=page.locator('.desk-comms-screen svg[data-slot="agent-face"]');
  await live.waitFor();assert.equal(await live.getAttribute('data-state'),'idle');
  app.writes.run(await service.prepareSend({thread:replying.id,sender:'face-pebble-dot',kind:'reply',clientId:'demo-reply',words:'One short reply.'}));
  for (const state of ['talking','complete','idle']) {
    await page.locator('.desk-comms-screen svg[data-state="'+state+'"]').waitFor();
    assert.ok((await live.getAttribute('aria-label')).endsWith(', '+labels[state]));
  }
  assert.deepEqual(errors,[]);
  const screenshot='action-deskFaces.png';
  await live.screenshot({path:join(out,screenshot)});
  return {ok:true,screenshot,reason:'All eight shape and eye combinations rendered on Home with four distinct outlines. A waiting question, reported states and a new Comms reply exercised all seven expressions.'};
 }catch(error){return {ok:false,error:String(error)};}
 finally{try{await context?.close();}finally{await app?.close();}}
}
