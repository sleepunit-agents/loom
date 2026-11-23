import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {eq} from 'drizzle-orm';
import {generateX25519Identity} from 'age-encryption';
import {FakeClock} from '../dist/core/clock.js';
import {createDataSchema} from '../dist/core/data/database.js';
import * as s from '../dist/core/data/schema.js';
import {sharedRoot} from '../dist/shared-root.js';
import {wordsKey} from '../dist/pieces/comms/crypto.js';
import {bodyConversationClient} from '../dist/runtime/conversation-client.js';

function fixtureProvider(platform, accounts, workspace) {
 const discord=platform==='discord', transports=new Map(), posts=[];
 const secrets={generation:async()=> '12345678-1234-4234-8234-123456789abc',read:async name=>Buffer.from('fixture-'+name)};
 function connect(options) {
  const account=accounts.find(row=>discord?row.bot===options.bot:row.app===options.app);
  assert.ok(account,'The provider authenticated the configured bot');
  transports.set(account.agent,options);
  options.state('connected');
  return {close:async()=>{}};
 }
 async function request(url,init) {
  const path=new URL(url).pathname;
  const auth=new Headers(init.headers).get('authorization');
  const account=accounts.find(row=>auth===(discord?'Bot ':'Bearer ')+'fixture-'+row.token);
  assert.ok(account,'Provider request used a configured bot credential');
  if(discord) {
   if(path.endsWith('/users/@me'))return Response.json({id:account.bot,bot:true});
   if(path.endsWith('/guilds/'+workspace))return Response.json({id:workspace});
   if(path.endsWith('/roles'))return Response.json([]);
   const channel=path.split('/')[4];
   if(path.endsWith('/messages')) {
    posts.push({agent:account.agent,channel,text:JSON.parse(init.body).content});
    return Response.json({channel_id:channel,id:String(800000000000000000n+BigInt(posts.length))});
   }
   if(accounts.some(row=>row.room===channel))return Response.json({id:channel,type:0,guild_id:workspace,name:'garden'});
   if(channel===account.dm)return Response.json({id:channel,type:1});
  } else {
   if(path.endsWith('/auth.test'))return Response.json({ok:true,user_id:account.bot,bot_id:account.botId,team_id:workspace});
   if(path.endsWith('/bots.info'))return Response.json({ok:true,bot:{id:account.botId,user_id:account.bot,app_id:account.app,deleted:false}});
   if(path.endsWith('/conversations.info')) {
    const channel=new URLSearchParams(init.body).get('channel');
    return Response.json({ok:true,channel:{id:channel,context_team_id:workspace,...(channel===account.dm?{is_im:true}:{is_channel:true})}});
   }
   if(path.endsWith('/chat.postMessage')) {
    const {channel,text,thread_ts}=JSON.parse(init.body);
    posts.push({agent:account.agent,channel,text,...(thread_ts?{thread:thread_ts}:{})});
    return Response.json({ok:true,channel,ts:'1794432000.'+String(900+posts.length).padStart(6,'0')});
   }
  }
  throw Error('Unexpected provider request: '+path);
 }
 return {transports, posts, bridges:{source:secrets,effectsAllowed:()=>true,request,[platform]:connect}};
}

/** Use the installed bridge daemon and body command. Both provider transports,
 * their credentials, the acting bodies, and the household are local fixtures. */
export async function providerConversations(platform) {
 assert.ok(['discord','slack'].includes(platform));
 const discord=platform==='discord', workspace=discord?'123456789012345678':'TGARDEN';
 const user=discord?'223456789012345678':'UOWNER';
 const accounts=['fern','moss'].map((agent,i)=>({agent,token:'BOT_'+agent,
  bot:discord?'32345678901234567'+i:'U'+agent.toUpperCase(),
  botId:'B'+agent.toUpperCase(),app:'A'+agent.toUpperCase(),
  room:discord?'42345678901234567'+i:'C'+agent.toUpperCase(),dm:discord?'52345678901234567'+i:'D'+agent.toUpperCase()}));
 const sql=new Database(':memory:'), clock=new FakeClock(Date.parse('2026-11-14T18:00:00Z'));
 const now=()=>new Date(clock.now()).toISOString(), db=createDataSchema(sql,now);
 const {transports,posts,bridges}=fixtureProvider(platform,accounts,workspace);
 let app;
 try {
  db.insert(s.members).values({id:'alex',role:'owner',joinedAt:now()}).run();
  db.insert(s.boxes).values({id:'box',name:'Fixture box',owner:'alex',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
  db.insert(s.bridgePeople).values({platform,workspace,user,member:'alex'}).run();
  for(const account of accounts) {
   const {agent,bot,token,room}=account;
   db.insert(s.agents).values({id:agent,about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
   db.insert(s.memberAgents).values({member:'alex',agent}).run();
   db.insert(s.secrets).values([token,'APP_'+agent].map(name=>({name,description:'Test fixture',changedBy:'alex',changedAt:now()}))).run();
   db.insert(s.bridgeConnections).values({id:agent,agent,platform,workspace,botUser:bot,tokenSecret:token,
    appSecret:discord?null:'APP_'+agent,enabled:true,state:'disconnected',stateAt:now()}).run();
   db.insert(s.bridgeChannels).values({platform,workspace,channel:room,answers:agent,botsMayTalk:false}).run();
  }
  app=sharedRoot({db,clock,originAllowed:()=>true,commsKey:wordsKey(await generateX25519Identity()),tempo:{admit:()=>true},bridges});
  const daemon=app.services.bridges.daemon;
  await daemon.ready(); await daemon.idle();
  assert.equal(transports.size,2);
  const places=new Set(), sequences=new Map();
  for(const account of accounts)for(const direct of [false,true]) {
   const {agent}=account,channel=direct?account.dm:account.room;
   const sentAt='1794432000.00000'+(places.size+1);
   const words=agent+' '+(direct?'direct message':'channel message');
   // Both bots hear the shared channel. A direct message reaches only the
   // addressed bot's transport, as it does at each provider.
   for(const hearing of (direct?[account]:accounts)) {
    const transport=transports.get(hearing.agent);
    if(discord) {
     const seq=(sequences.get(hearing.agent)??0)+1;
     sequences.set(hearing.agent,seq);
     const data={type:0,id:'62345678901234567'+places.size,channel_id:channel,...(direct?{}:{guild_id:workspace}),
      author:{id:user,bot:false},content:words,mentions:[],timestamp:now()};
     await transport.commit({type:'MESSAGE_CREATE',data,seq},{session:hearing.agent,url:'wss://gateway.discord.gg',seq},
      Buffer.from(JSON.stringify({op:0,t:'MESSAGE_CREATE',s:seq,d:data})));
    } else {
     const payload={type:'event_callback',team_id:workspace,api_app_id:hearing.app,event_id:randomUUID(),
      event:{type:'message',channel,channel_type:direct?'im':'channel',user,text:words,ts:sentAt}};
     await transport.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:randomUUID(),payload})));
    }
   }
   clock.advance(0); await daemon.idle();
   const received=db.select().from(s.bridgeIncoming).where(eq(s.bridgeIncoming.channel,channel)).all();
   assert.equal(received.length,direct?1:2);
   if(!direct)assert.equal(received.find(row=>row.connection!==agent)?.state,'dropped');
   const incoming=received.find(row=>row.connection===agent);
   assert.equal(incoming?.state,'delivered',words);
   assert.equal(incoming.connection,agent);
   const cv=db.select().from(s.conversations).where(eq(s.conversations.id,incoming.conversation)).get();
   assert.deepEqual([cv.venue,cv.agent,cv.direct,cv.member],[platform,agent,direct,direct?'alex':null]);
   assert.ok(!places.has(cv.id)); places.add(cv.id);
   const job='job-'+places.size,credential='body_'+createHash('sha256').update(randomUUID()).digest('hex');
   db.insert(s.jobs).values({id:job,agent,box:'box',member:cv.member,conversation:cv.id,title:'Fixture reply',state:'running',
    brief:'',model:'fixture',startedByKind:'agent',startedBy:agent,houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
   db.insert(s.tokens).values({kind:'agent',label:job,fingerprint:createHash('sha256').update(credential).digest('hex'),agent,job,createdAt:now()}).run();
   const client=bodyConversationClient({url:'https://loom.invalid',token:credential,job,conversation:cv.id,signal:new AbortController().signal,clock,
    fetch:(url,init)=>app.http.request(new Request(url,init))});
   const text='Reply to '+words;
   try {
    const taken=await client.takeAndAccept(async item=>{assert.equal(item.words,words);assert.ok(item.refs.includes(incoming.id));});
    assert.equal(taken.accepted,1);
    await client.bridgeReply({incoming:incoming.id,text,model:'fixture'});
   } finally {client.close();}
   await daemon.idle();
   assert.deepEqual(posts.at(-1),{agent,channel,text,...(!discord&&!direct?{thread:sentAt}:{})});
   const receipt=db.select().from(s.bridgeSends).where(eq(s.bridgeSends.incoming,incoming.id)).get();
   assert.deepEqual([receipt.state,receipt.connection,receipt.incoming,receipt.channel],['sent',agent,incoming.id,channel]);
   const turns=db.select().from(s.turns).where(eq(s.turns.conversation,cv.id)).orderBy(s.turns.seq).all();
   assert.deepEqual(turns.map(row=>[row.kind,row.fromId]),[['message','alex'],['reply',agent]]);
  }
  assert.equal(posts.length,4);
  return {ok:true,reason:'On fixture '+(discord?'Discord':'Slack')+' connections, two agents each answered their assigned channel and a private member DM as their own bot. The other bot ignored each channel message. The body read the received words, and the provider transport acknowledged all four replies in their original places.'};
 } finally {try{await app?.close();}finally{sql.close();}}
}
