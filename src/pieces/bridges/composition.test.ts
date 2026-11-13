import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import type {WebSocket} from 'ws';
import {closeNext} from '../../next.js';
import {startLoom} from '../../foundation.js';
import {fixture} from '../../fixture.js';
import {PeopleStore} from '../../backends/people.js';
import {FakeClock} from '../../core/clock.js';
import {installSecrets} from '../secrets/index.js';
import {installSecretServices} from '../secrets/service.js';
import {SharingDatabase} from '../../core/household/sharing.js';
import {installBridges} from './index.js';
import {venueSchema} from './model.js';
import {put} from './store.js';
import {slackInbox} from './slack-inbox.js';
import type {Incoming} from './role.js';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
async function until(condition:()=>boolean){for(let n=0;n<4000;n++){if(condition())return;await Promise.resolve();}throw Error('condition not reached');}
async function settle(){for(let i=0;i<200;i++)await Promise.resolve();}
it.each(['own','commons','missing','other','no-runtime'] as const)('composes %s People visibility, durable engine and separate staging releases',async visibility=>{
  const home=mkdtempSync(join(tmpdir(),'bridge-composition-'));fixture(home);const clock=new FakeClock();
  const path=visibility==='commons'?'commons/people.db':visibility==='other'?'agents/mark/memories.db':'agents/art/memories.db';
  mkdirSync(join(home,path.substring(0,path.lastIndexOf('/'))),{recursive:true});const people=new PeopleStore({dbPath:join(home,path)});if(visibility!=='missing')people.write({slug:'jonathan',name:'Trusted Jonathan'});
  const venue=venueSchema.parse({id:'slack',platform:'slack',workspace:'T123',bot:'U123',agent:'art',tokenSecret:'bot',appSecret:'app'});
  const deliveries:Incoming[]=[],posts:unknown[]=[],buffers:Uint8Array[]=[];
  let generation='00000000-0000-4000-8000-000000000000',admitWait:Promise<void>|undefined;
  const admitStarted=Promise.withResolvers<void>(),postStarted=Promise.withResolvers<void>(),postFinish=Promise.withResolvers<void>();let pausePost=false;
  const source={generation:async()=> generation,read:vi.fn(async()=>{const b=Buffer.from('COMPOSITION-PRIVATE');buffers.push(b);return b;})};
  const request=vi.fn<typeof fetch>(async(url,init)=>{
    const method=String(url).split('/').pop();
    if(method==='auth.test')return Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'});
    if(method==='bots.info')return Response.json({ok:true,bot:{id:'B123',user_id:'U123',deleted:false,app_id:'A123'}});
    if(method==='apps.connections.open')return Response.json({ok:true,url:'wss://wss-primary.slack.com/link?ticket=PRIVATE'});
    if(method==='conversations.info')return Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U200'}});
    if(method==='chat.postMessage'){if(pausePost){postStarted.resolve();await postFinish.promise;}posts.push(JSON.parse(String(init?.body)));return Response.json({ok:true,channel:'D123',ts:'1794503533.000001'});}
    return Response.json({ok:true,user:{id:'U200',team_id:'T123',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
  });
  const socket=()=>Object.assign(new EventEmitter(),{readyState:1,terminate:vi.fn(),send:vi.fn(),ping:vi.fn()}) as unknown as WebSocket;
  let foundation!:import('../../core/app.js').Foundation;
  const app=await startLoom({home,next:true,staging:true,clock,stdout:()=>{},bridges:{source,request,socket,
    runtime:visibility==='no-runtime'?undefined:{admit:async()=>{if(admitWait){admitStarted.resolve();await admitWait;}return 'allow';},deliver:async i=>{deliveries.push(i);return 'delivered';},stop:async()=>{}}},
    install(a){foundation=a;
      const sharing=()=>new SharingDatabase(a.db,home).sharing();installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
      for(const name of ['bot','app'])for(const [verb,input] of [['describe',{name,description:name}],['grantService',{service:'bridges',name}]] as const)expect(a.operations.call('direct',{kind:'member',id:'jonathan'},`secrets.${verb}`,input,`${verb}-${name}`).ok).toBe(true);
      put(a.db,'venues',venue);put(a.db,'links',{id:'person',platform:'slack',workspace:'T123',user:'U200',person:'jonathan'});
      void slackInbox(a.db,clock,{venue,app:'A123'}).receive({type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:'Ev1',event:{type:'message',channel:'D123',user:'U200',ts:'1794503533.000000',text:'hello <@U200|Untrusted>'}});
    }});
  let closed=false;cleanups.push(async()=>{if(!closed)await app.close();people.close();rmSync(home,{recursive:true,force:true});});
  await settle();expect(source.read).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  const release=()=>{
    const due=app.db.prepare("SELECT id FROM core_effects WHERE state='due'").all() as {id:string}[];
    for(const row of due)expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',row,crypto.randomUUID()).ok).toBe(true);
    clock.advance(0);
  };
  release();await until(()=>app.db.prepare('SELECT id FROM core_effects WHERE id LIKE ?').get('bridges:inspect:%')!==undefined);
  expect(deliveries).toEqual([]);expect(posts).toEqual([]);release();
  if(visibility==='no-runtime'){await until(()=>request.mock.calls.filter(([url])=>String(url).endsWith('users.info')).length>=2);await settle();expect(app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'pending',reason:null});expect(app.db.prepare('SELECT retry_since FROM bridges_inbox').get()).toMatchObject({retry_since:expect.any(Number)});expect(deliveries).toEqual([]);expect(app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);expect(posts).toEqual([]);return;}
  await until(()=>deliveries.length===1);await settle();
  expect(deliveries[0]).toMatchObject(visibility==='own'?{label:'DM with Trusted Jonathan',text:'hello @Trusted Jonathan'}:{label:'DM',text:'hello @someone'});
  expect(app.operations.call('direct',{kind:'agent',id:'art'},'mind.personRead',{id:'commons:jonathan'})).toMatchObject({ok:false,code:'denied'});
  // A durable reply fixture enters the actual installed engine's send path.
  const row=app.db.prepare('SELECT id,identity FROM bridges_inbox').get() as {id:string;identity:string};
  app.db.prepare("INSERT INTO bridges_outbox VALUES (?,?,?,?,?,?,'pending',NULL,?)").run('reply',row.id,venue.id,row.identity,JSON.stringify({channel:'D123',dm:true}),'reply <@U200>',clock.now());
  app.live.changed([{type:'bridges.send',id:'reply'}]);await settle();expect(posts).toEqual([]);
  expect(app.db.prepare('SELECT state FROM core_effects WHERE id=?').get('bridges:reply')).toEqual({state:'due'});
  release();await until(()=>posts.length===1);await until(()=>!!app.db.prepare("SELECT id FROM bridges_outbox WHERE state='sent'").get());
  expect(posts[0]).toMatchObject({text:'reply &lt;@U200&gt;',mrkdwn:false});expect(buffers.every(b=>b.every(x=>x===0))).toBe(true);
  await settle();clock.advance(5000);await settle();expect(posts).toHaveLength(1);
  if(visibility==='own') {
    // Current holder metadata must survive the separate runtime admission await.
    const finish=Promise.withResolvers<void>();admitWait=finish.promise;
    await slackInbox(app.db,clock,{venue,app:'A123'}).receive({type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:'Ev2',event:{type:'message',channel:'D123',user:'U200',ts:'1794503534.000000',text:'second'}});
    clock.advance(5000);await admitStarted.promise;
    generation='00000000-0000-4000-8000-000000000001';clock.advance(5000);await settle();finish.resolve();await settle();expect(deliveries).toHaveLength(1);admitWait=undefined;
    // Fresh staging inspection is needed for a recovered generation.
    release();await settle();
    app.db.prepare("INSERT INTO bridges_outbox VALUES (?,?,?,?,?,?,'pending',NULL,?)").run('closing',row.id,venue.id,row.identity,JSON.stringify({channel:'D123',dm:true}),'close waits',clock.now());
    pausePost=true;app.live.changed([{type:'bridges.send',id:'closing'}]);await settle();release();await settle();release();await postStarted.promise;
    let finished=false;const closing=closeNext(foundation).then(()=>{finished=true;});await settle();try{expect(finished).toBe(false);expect(app.db.open).toBe(true);}finally{postFinish.resolve();await closing;}
    expect(finished).toBe(true);await app.close();closed=true;expect(app.db.open).toBe(false);
  }
});
