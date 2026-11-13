import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import type {WebSocket} from 'ws';
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
it('composes installed People names, the durable engine, scoped adapters and separately released staging reads/sends',async()=>{
  const home=mkdtempSync(join(tmpdir(),'bridge-composition-'));fixture(home);const clock=new FakeClock();
  mkdirSync(join(home,'agents/art'),{recursive:true});const people=new PeopleStore({dbPath:join(home,'agents/art/memories.db')});people.write({slug:'jonathan',name:'Trusted Jonathan'});
  const venue=venueSchema.parse({id:'slack',platform:'slack',workspace:'T123',bot:'U123',agent:'art',tokenSecret:'bot',appSecret:'app'});
  const deliveries:Incoming[]=[],posts:unknown[]=[],buffers:Uint8Array[]=[];
  const source={generation:async()=> '00000000-0000-4000-8000-000000000000',read:vi.fn(async()=>{const b=Buffer.from('COMPOSITION-PRIVATE');buffers.push(b);return b;})};
  const request=vi.fn<typeof fetch>(async(url,init)=>{
    const method=String(url).split('/').pop();
    if(method==='auth.test')return Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'});
    if(method==='bots.info')return Response.json({ok:true,bot:{id:'B123',user_id:'U123',deleted:false,app_id:'A123'}});
    if(method==='apps.connections.open')return Response.json({ok:true,url:'wss://wss-primary.slack.com/link?ticket=PRIVATE'});
    if(method==='conversations.info')return Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U200'}});
    if(method==='chat.postMessage'){posts.push(JSON.parse(String(init?.body)));return Response.json({ok:true,channel:'D123',ts:'1794503533.000001'});}
    return Response.json({ok:true,user:{id:'U200',team_id:'T123',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
  });
  const socket=()=>Object.assign(new EventEmitter(),{readyState:1,terminate:vi.fn(),send:vi.fn(),ping:vi.fn()}) as unknown as WebSocket;
  const app=await startLoom({home,next:true,staging:true,clock,stdout:()=>{},bridges:{source,request,socket,
    runtime:{admit:async()=> 'allow',deliver:async i=>{deliveries.push(i);return 'delivered';},stop:async()=>{}}},
    install(a){
      const sharing=()=>new SharingDatabase(a.db,home).sharing();installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
      for(const name of ['bot','app'])for(const [verb,input] of [['describe',{name,description:name}],['grantService',{service:'bridges',name}]] as const)expect(a.operations.call('direct',{kind:'member',id:'jonathan'},`secrets.${verb}`,input,`${verb}-${name}`).ok).toBe(true);
      put(a.db,'venues',venue);put(a.db,'links',{id:'person',platform:'slack',workspace:'T123',user:'U200',person:'jonathan'});
      void slackInbox(a.db,clock,{venue,app:'A123'}).receive({type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:'Ev1',event:{type:'message',channel:'D123',user:'U200',ts:'1794503533.000000',text:'hello <@U200|Untrusted>'}});
    }});
  cleanups.push(async()=>{await app.close();people.close();rmSync(home,{recursive:true,force:true});});
  await settle();expect(source.read).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  const release=()=>{
    const due=app.db.prepare("SELECT id FROM core_effects WHERE state='due'").all() as {id:string}[];
    for(const row of due)expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',row,crypto.randomUUID()).ok).toBe(true);
    clock.advance(0);
  };
  release();await until(()=>app.db.prepare('SELECT id FROM core_effects WHERE id LIKE ?').get('bridges:inspect:%')!==undefined);
  expect(deliveries).toEqual([]);expect(posts).toEqual([]);release();await until(()=>deliveries.length===1);await settle();
  expect(deliveries[0]).toMatchObject({label:'DM with Trusted Jonathan',text:'hello @Trusted Jonathan'});
  // A durable reply fixture enters the actual installed engine's send path.
  const row=app.db.prepare('SELECT id,identity FROM bridges_inbox').get() as {id:string;identity:string};
  app.db.prepare("INSERT INTO bridges_outbox VALUES (?,?,?,?,?,?,'pending',NULL,?)").run('reply',row.id,venue.id,row.identity,JSON.stringify({channel:'D123',dm:true}),'reply <@U200>',clock.now());
  app.live.changed([{type:'bridges.send',id:'reply'}]);await settle();expect(posts).toEqual([]);
  expect(app.db.prepare('SELECT state FROM core_effects WHERE id=?').get('bridges:reply')).toEqual({state:'due'});
  release();await until(()=>posts.length===1);await until(()=>!!app.db.prepare("SELECT id FROM bridges_outbox WHERE state='sent'").get());
  expect(posts[0]).toMatchObject({text:'reply &lt;@U200&gt;',mrkdwn:false});expect(buffers.every(b=>b.every(x=>x===0))).toBe(true);
  await settle();clock.advance(5000);await settle();expect(posts).toHaveLength(1);
});
