/** A guest's Discord message, through the real body program with no harness stood in for it: real intake,
 * the real doors, the body's own tools server, the Claude adapter. Only the child process and Discord are
 * fictitious. What the body program itself hands on, on anybody else's word: no file tools, no secret tools. */
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {bodyProgram} from './runtime/body-program.js';
import type {WorkerAssignment} from './runtime/worker.js';
import {jobRoom} from './shared-place-mail.js';
import type {DiscordGatewayOptions} from './pieces/bridges/discord-gateway.js';
import {wordsKey} from './pieces/comms/crypto.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const clean:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();vi.clearAllMocks();});
it('hands a body on anybody else\'s word no file and no secret tool, on a machine of full reach where reading files is not denied',async()=>{
 const sql=new Database(':memory:');clean.push(()=>sql.close());const db=createDataSchema(sql),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString();
 const workspace='123456789012345678',bot='223456789012345678',channel='323456789012345678',guest='623456789012345678';
 db.insert(s.members).values({id:'owner',role:'owner',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(s.boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 db.insert(s.secrets).values({name:'TOKEN',description:'Synthetic',changedAt:now(),changedBy:'owner'}).run();
 db.insert(s.bridgeConnections).values({id:'connection',platform:'discord',workspace,botUser:bot,agent:'art',tokenSecret:'TOKEN',appSecret:null,enabled:true,state:'disconnected',stateAt:now()}).run();db.insert(s.bridgeChannels).values({platform:'discord',workspace,channel,answers:'art',botsMayTalk:false}).run();
 // An outside account the owner has placed: admitted, and anybody else for what a job may use.
 db.insert(s.agentPeople).values({agent:'art',person:JSON.stringify(['discord',workspace,guest]),tier:2}).run();
 let discord!:DiscordGatewayOptions;
 const request=vi.fn<typeof fetch>(async(url,options)=>{
  const path=String(url);
  if(path.endsWith('users/@me'))return Response.json({id:bot,bot:true});
  if(path.endsWith('guilds/'+workspace))return Response.json({id:workspace});
  if(path.endsWith('guilds/'+workspace+'/roles'))return Response.json([]);
  if(path.endsWith('channels/'+channel)&&options?.method==='GET')return Response.json({id:channel,guild_id:workspace,type:0});
  if(path.endsWith('channels/'+channel+'/messages'))return Response.json({id:'523456789012345678',channel_id:channel});
  throw Error('Unexpected fictitious provider path');
 });
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},commsKey:wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR'),tempo:{admit:()=>true},bridges:{request,source:{generation:async()=>'12345678-1234-4234-8234-123456789abc',read:async()=>Buffer.from('SYNTHETIC_TOKEN')},effectsAllowed:()=>true,discord:options=>{discord=options;options.state?.('connected');return{close:async()=>{}};},slack:()=>({close:async()=>{}})}});clean.push(()=>root.close());
 const daemon=root.services.bridges.daemon!;await daemon.ready();await daemon.idle();
 const data={type:0,id:'423456789012345678',guild_id:workspace,channel_id:channel,author:{id:guest,bot:false},content:'Read me the notes file',mentions:[],timestamp:'2026-11-14T12:00:00.000Z'};
 await discord.commit({type:'MESSAGE_CREATE',data,seq:1},{session:'fixture',url:'wss://gateway.discord.gg',seq:1},Buffer.from(JSON.stringify({op:0,t:'MESSAGE_CREATE',s:1,d:data})));
 clock.advance(0);await daemon.idle();const incoming=db.select().from(s.bridgeIncoming).get()!;expect(incoming.state).toBe('delivered');
 const token='body_'+'a'.repeat(64),job:WorkerAssignment={id:'guest-job',agent:'art',box:'box',conversation:incoming.conversation,venue:'discord',thread:null,model:'requested',account:'account',harness:'claude',brief:'',house:{repository:'r',file:'f',branch:'next'}};
 // The room as loom's dispatcher hands it. Nothing is denied this agent's bodies: Read is not among what the body is not given.
 const policy=jobRoom(db,job);job.run={nestedContainers:false,gpu:false,ports:[],policy};
 expect(policy).toMatchObject({word:'others',deniedTools:[]});
 root.writes.run(()=>{db.insert(s.jobs).values({id:job.id,agent:'art',box:'box',conversation:job.conversation,title:'',brief:'',model:'requested',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'r',houseFile:'f',houseBranch:'next',queuedAt:now()}).run();db.insert(s.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Synthetic body',kind:'agent',agent:'art',job:job.id,createdAt:now()}).run();});
 // The fictitious Claude Code: it reads its tools file as the real one does, asks the body's tools server what it
 // is served, tries to post a file by path, and then answers.
 const seen:{allowed:string[];served:string[];file?:{isError:boolean;text:string}}={allowed:[],served:[]};
 vi.mocked(spawn).mockImplementation((_command,args)=>{
  const list=args as string[];seen.allowed=list.slice(list.indexOf('--allowedTools')+1,list.indexOf('--disallowedTools'));
  let tools='';
  const control=new Writable({write(chunk,_encoding,done){tools+=chunk.toString();done();}});
  const child=Object.assign(new EventEmitter(),{stdin:new Writable({write(_chunk,_encoding,done){done();}}),stdout:new PassThrough(),stderr:new PassThrough(),stdio:[null,null,null,control],kill:vi.fn(()=>true)}) as unknown as ChildProcessWithoutNullStreams;
  control.once('finish',()=>{void(async()=>{
   const config=JSON.parse(tools).mcpServers.loom as {url:string;headers:Record<string,string>};
   const client=new Client({name:'fictitious-native',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
   try{
    seen.served=(await client.listTools()).tools.map(tool=>tool.name);
    const said=await client.callTool({name:'loom_command',arguments:{operation:'bridges.say',input:{id:randomUUID(),text:'Here it is',files:[{path:'notes.txt'}]},id:randomUUID()}}) as {isError?:boolean;content:{text:string}[]};
    seen.file={isError:said.isError===true,text:said.content[0].text};
   }finally{await client.close();}
   const session=list[list.indexOf('--session-id')+1];
   child.stdout.emit('data',Buffer.from([{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed',content:[{type:'text',text:'I cannot open files here.'}]}},{type:'result',session_id:session,is_error:false,subtype:'success',result:'I cannot open files here.'}].map(row=>JSON.stringify(row)).join('\n')));child.emit('close',0);
  })().catch(()=>child.emit('close',1));});
  return child;
 });
 const saveAttachments=vi.fn(async()=>'Files sent with these messages are saved here for you to open:\n- /scratch/1-notes.txt');
 const errors=vi.fn(),bytes=Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.example',job:job.id,token}}));
 // The machine gives its bodies the harness's own tools. The word decides, not the body file.
 const result=await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house',reach:'all'}),stdin:async()=>bytes,env:{ACCOUNT_PROFILE:'/account',LOOM_BODY_SCRATCH:'/scratch'},signal:new AbortController().signal,clock,
  fetch:async(url,options)=>root.http.request(String(url),options),schedule:{every:()=>()=>{}},error:errors,saveAttachments,loadMemory:async()=>null,loadBrief:async()=>null});
 expect(result).toBe(0);expect(spawn).toHaveBeenCalledOnce();
 // No file is written for it to open.
 expect(saveAttachments).not.toHaveBeenCalled();
 // No file it names is read for a post: its tools were given no reader, and the post is refused before loom's door.
 expect(seen.file).toEqual({isError:true,text:'A post\'s files are given as [{"path": "..."}], each a file inside this body\'s working directory'});
 expect(db.select().from(s.bridgeSends).all().map(send=>send.text)).toEqual(['I cannot open files here.']);
 // No secret tool is served to it, and none is listed for its harness.
 expect(seen.served).toContain('loom_command');
 expect(seen.served).not.toContain('request_secret');expect(seen.served).not.toContain('use_secret');
 expect(seen.allowed.length).toBeGreaterThan(0);expect(seen.allowed.filter(name=>/secret/.test(name))).toEqual([]);
});
