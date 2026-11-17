/** Actual intake -> current body HTTP -> default native adapter -> bridge send.
 * Provider sockets and native children are fictitious; no provider API is used. */
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {bodyProgram} from './runtime/body-program.js';
import type {WorkerAssignment} from './runtime/worker.js';
import type {DiscordGatewayOptions} from './pieces/bridges/discord-gateway.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
import {wordsKey} from './pieces/comms/crypto.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();vi.clearAllMocks();});
it.each([{platform:'discord',revoke:false},{platform:'slack',revoke:false},{platform:'slack',revoke:true}] as const)('runs native $platform input with pending-read revocation=$revoke',async ({platform,revoke})=>{
 const sql=new Database(':memory:');clean.push(()=>sql.close());const db=createDataSchema(sql),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString();
 const workspace=platform==='discord'?'123456789012345678':'TWORK',bot=platform==='discord'?'223456789012345678':'UBOT',channel=platform==='discord'?'323456789012345678':'CROOM';
 db.insert(s.members).values({id:'owner',role:'owner',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(s.boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 db.insert(s.secrets).values(['TOKEN','APP'].map(name=>({name,description:'Synthetic',changedAt:now(),changedBy:'owner'}))).run();
 db.insert(s.bridgeConnections).values({id:'connection',platform,workspace,botUser:bot,agent:'art',tokenSecret:'TOKEN',appSecret:platform==='slack'?'APP':null,enabled:true,state:'disconnected',stateAt:now()}).run();db.insert(s.bridgeChannels).values({platform,workspace,channel,answers:'art',botsMayTalk:false}).run();
 // The outside account that writes has been placed by the agent's owner: a stranger's message is not taken.
 db.insert(s.agentPeople).values({agent:'art',person:JSON.stringify([platform,workspace,platform==='discord'?'623456789012345678':'UUSER']),tier:2}).run();
 let discord!:DiscordGatewayOptions,slack!:Parameters<typeof bridgeSlackSocket>[0];
 const request=vi.fn<typeof fetch>(async(url,options)=>{
  const path=String(url);
  if(path.endsWith('users/@me'))return Response.json({id:bot,bot:true});
  if(path.endsWith('guilds/'+workspace))return Response.json({id:workspace});
  if(path.endsWith('channels/'+channel)&&options?.method==='GET')return Response.json({id:channel,guild_id:workspace,type:0});
  if(path.endsWith('channels/'+channel+'/messages'))return Response.json({id:'523456789012345678',channel_id:channel});
  if(path.endsWith('auth.test'))return Response.json({ok:true,user_id:bot,team_id:workspace,bot_id:'BBOT'});
  if(path.endsWith('bots.info'))return Response.json({ok:true,bot:{id:'BBOT',user_id:bot,app_id:'AAPP',deleted:false}});
  if(path.endsWith('conversations.info'))return Response.json({ok:true,channel:{id:channel,context_team_id:workspace,is_channel:true}});
  if(path.endsWith('chat.postMessage'))return Response.json({ok:true,channel,ts:'1794432000.000009'});
  throw Error('Unexpected fictitious provider path');
 });
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},commsKey:wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR'),tempo:{admit:()=>true},bridges:{request,source:{generation:async()=> '12345678-1234-4234-8234-123456789abc',read:async()=>Buffer.from('SYNTHETIC_TOKEN')},effectsAllowed:()=>true,discord:options=>{discord=options;options.state?.('connected');return{close:async()=>{}};},slack:options=>{slack=options;options.state?.('connected');return{close:async()=>{}};}}});clean.push(()=>root.close());
 const daemon=root.services.bridges.daemon!;await daemon.ready();await daemon.idle();
 if(platform==='discord'){
  const data={type:0,id:'423456789012345678',guild_id:workspace,channel_id:channel,author:{id:'623456789012345678',bot:false},content:'Accepted bridge words',mentions:[],timestamp:'2026-11-14T12:00:00.000Z'};
  await discord.commit({type:'MESSAGE_CREATE',data,seq:1},{session:'fixture',url:'wss://gateway.discord.gg',seq:1},Buffer.from(JSON.stringify({op:0,t:'MESSAGE_CREATE',s:1,d:data})));
 }else await slack.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack',payload:{type:'event_callback',event_id:'event',team_id:workspace,event:{type:'message',channel,user:'UUSER',text:'Accepted bridge words',ts:'1794432000.000001'}}})));
 clock.advance(0);await daemon.idle();const incoming=db.select().from(s.bridgeIncoming).get()!;expect(incoming).toMatchObject({state:'delivered',text:'Accepted bridge words'});
 const token='body_'+'a'.repeat(64),job:WorkerAssignment={id:'native',agent:'art',box:'box',conversation:incoming.conversation,venue:platform,thread:null,model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'r',file:'f',branch:'next'}};
 root.writes.run(()=>{db.insert(s.jobs).values({id:job.id,agent:'art',box:'box',conversation:job.conversation,title:'',brief:'',model:'requested',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'r',houseFile:'f',houseBranch:'next',queuedAt:now()}).run();db.insert(s.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Synthetic native body',kind:'agent',agent:'art',job:job.id,createdAt:now()}).run();});
 vi.mocked(spawn).mockImplementation((_command,args,options)=>{
  expect(JSON.stringify({args,options})).not.toContain(token);expect(db.select().from(s.inbox).get()?.state).toBe('taken');let words='';
  const child=Object.assign(new EventEmitter(),{stdin:new Writable({write(chunk,_encoding,done){words+=chunk.toString();done();}}),stdout:new PassThrough(),stderr:new PassThrough(),stdio:[null,null,null,new Writable({write(_chunk,_encoding,done){done();}})],kill:vi.fn(()=>true)}) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(()=>{expect(words).toBe('Accepted bridge words');const list=args as string[],session=list[list.indexOf('--session-id')+1];child.stdout.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'Native reply'}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:'Native reply'}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0);});return child;
 });
 const paths:string[]=[];const errors=vi.fn(),bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.example',job:job.id,token}}));
 const result=await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house'}),stdin:async()=>bytes,env:{ACCOUNT_PROFILE:'/account'},signal:new AbortController().signal,clock,fetch:async(url,options)=>{paths.push(new URL(String(url)).pathname);const response=await root.http.request(String(url),options);if(revoke&&String(url).endsWith('/take'))root.writes.run(()=>db.update(s.bridgeIncoming).set({text:'Changed while unread'}).where(eq(s.bridgeIncoming.id,incoming.id)).run());return response;},schedule:{every:()=>()=>{}},error:errors});if(revoke){expect(result).toBe(12);expect(spawn).not.toHaveBeenCalled();expect(db.select().from(s.bridgeSends).all()).toEqual([]);expect(bytes.every(byte=>byte===0)).toBe(true);return;}expect(result).toBe(0);expect(db.select().from(s.digests).all()).toEqual([expect.objectContaining({conversation:incoming.conversation,run:job.id,summary:'Completed this stretch of work.',revision:1})]);expect(paths).toContain('/api/bridges/reply');expect(paths).not.toContain('/api/conversation/message');
 await daemon.idle();expect(errors).not.toHaveBeenCalled();expect(spawn).toHaveBeenCalledOnce();expect(db.select().from(s.bridgeSends).get()).toMatchObject({incoming:incoming.id,text:'Native reply',state:'sent'});expect(db.select().from(s.turns).all()).toMatchObject([{kind:'message'},{kind:'reply',run:job.id,model:'observed',outcome:'progressed'}]);expect(sql.serialize().includes(Buffer.from(token))).toBe(false);expect(bytes.every(byte=>byte===0)).toBe(true);
});
