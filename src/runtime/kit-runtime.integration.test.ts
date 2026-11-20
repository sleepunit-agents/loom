/** A held native job against a real root, per-job worker socket, MCP listener,
 * model stand-in and executable helper. Only the image/engine is substituted. */
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {eq} from 'drizzle-orm';
import {bodyCredentials,bodyFixture,credentialHash} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {jobRoom} from '../shared-place-mail.js';
import * as bodyKits from './body-kit-tools.js';
import {bodyProgram} from './body-program.js';
import {kitPrivateClient} from './kit-private-client.js';
import {kitBroker} from './kit-broker.js';
import {kitUnavailableList} from './kit-availability.js';
import {kitSocket} from './kit-socket.js';
import {runKitContainer} from './kit-container.js';
import type {DockerEngine} from './docker-engine.js';

const clean:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of clean.splice(0).reverse())await close();});

/** Resolve the one path the image contains to the test's executable. The
 * bootstrap, its actual argv/environment and the helper all run as written. */
function fixtureEngine(image:string,helper:string,finished:()=>void):DockerEngine{
  let launcher:string[],input:Buffer[]=[];
  let ended!: (reply:{StatusCode:number|null})=>void;
  const waited=new Promise<{StatusCode:number|null}>(resolve=>ended=resolve);
  const socket=new Duplex({read(){},write(chunk,_encoding,done){input.push(Buffer.from(chunk));done();}});
  return {build:vi.fn(),attach:async()=>socket,async json(method,path,body){
    if(path.startsWith('/images/'))return {Id:image,Config:{}};
    if(path.startsWith('/containers/')&&path.endsWith('/json'))return {Mounts:[]};
    if(path.includes('/create')){
      const spec=body as {Entrypoint:string[];Cmd:string[]};
      expect(spec.Cmd).toEqual(['/home/agent/repo/fixtures/lookup']);launcher=spec.Entrypoint.slice(1);
      return {Id:'a'.repeat(64)};
    }
    if(path.endsWith('/start')){
      const child=spawn(process.execPath,[...launcher,helper],{env:{},stdio:['pipe','pipe','ignore']});
      socket.once('finish',()=>{child.stdin.end(Buffer.concat(input));input=[];});
      child.stdout.on('data',(chunk:Buffer)=>{const frame=Buffer.alloc(8);frame[0]=1;frame.writeUInt32BE(chunk.length,4);socket.push(Buffer.concat([frame,chunk]));});
      child.once('close',code=>{socket.push(null);ended({StatusCode:code});});
    }
    if(path.includes('/wait?'))return waited;
    if(method==='DELETE')finished();
  }};
}

it.each(['ungranted','matching','different house'])('keeps a held job fresh and advertises its usable tools (%s)',async scenario=>{
  const granted=scenario!=='ungranted',usable=scenario==='matching';
  const secret='fictional-pond-credential',read=vi.fn(async()=>Buffer.from(secret));
  const f=await bodyFixture(clean,{secretInputs:{source:{read}}});
  const dir=await mkdtemp(join(tmpdir(),'loom-kit-body-'));clean.push(()=>rm(dir,{force:true,recursive:true}));
  const server=createServer(getRequestListener(f.root.http.fetch));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  clean.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();if(!address||typeof address==='string')throw Error('Fixture listener unavailable');
  const url='http://127.0.0.1:'+address.port,body='body_'+'d'.repeat(64),conversation=f.thread.conversation;
  const now=new Date(f.clock.now()).toISOString(),who={platform:'slack',workspace:'T1',user:'guest'},person=JSON.stringify(Object.values(who));
  const house={repository:'https://example.org/house',commit:'c'.repeat(40),image:'sha256:'+'f'.repeat(64)};
  const tool={...house,name:'lookup',description:'Look up one sample',program:'fixtures/lookup',args:[{parameter:'sample'}],
    parameters:{sample:{type:'string' as const,description:'Sample name'}},secrets:{KIT_POND:'pond-read'}};
  f.db.delete(s.threads).where(eq(s.threads.id,f.thread.id)).run();
  f.db.update(s.conversations).set({venue:'wake',member:null,place:'observations'}).where(eq(s.conversations.id,conversation)).run();
  f.db.update(s.jobs).set({member:null,harness:'claude',model:'fixture'}).run();
  f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();
  f.db.insert(s.tokens).values({fingerprint:credentialHash(body),kind:'agent',agent:'art',job:'job',label:'Fixture body',createdAt:now}).run();
  f.db.insert(s.agentPeople).values({agent:'art',person,tier:2}).run();
  f.db.insert(s.agentKits).values({agent:'art',kit:'pond',tools:[tool]}).run();
  f.db.insert(s.agentKitProjects).values({agent:'art',kit:'pond',project:'pond'}).run();
  if(granted)f.db.insert(s.projectOutsidePeople).values({project:'pond',...who}).run();
  f.db.insert(s.secrets).values({name:'pond-read',description:'read only',changedAt:now,changedBy:'alice'}).run();
  f.db.insert(s.secretChanges).values({id:'baseline',secret:'pond-read',action:'add',by:'alice',at:now}).run();
  const mail=f.root.services.comms!.threads.conversations.send({conversation,toKind:'agent',to:'art',source:'trigger',fromKind:'schedule',words:'Check the sample.'});
  f.db.update(s.inbox).set({job:'job',onWordKind:'outside',onWord:person}).where(eq(s.inbox.id,mail.id)).run();
  const room=jobRoom(f.db,{id:'job',agent:'art',conversation});expect(room.word).toBe('others');
  const helper=join(dir,'lookup');
  await writeFile(helper,'#!'+process.execPath+'\nif(!process.env.KIT_POND)process.exit(1);\nprocess.stdout.write(process.argv[2]==="leak"?process.env.KIT_POND:JSON.stringify(process.argv.slice(2)));',{mode:0o700});
  let launches=0;
  const pin=scenario==='different house'?{...house,commit:'d'.repeat(40)}:house;
  const post=kitPrivateClient({url,runner:bodyCredentials.runner,body,job:'job'});
  const broker=kitBroker({...pin,denials:[],post,
    run:input=>runKitContainer(fixtureEngine(house.image,helper,()=>{
      if(++launches===2)f.db.delete(s.projectOutsidePeople).run();
    }),{...input,job:'job',box:'box'})});
  const signal=new AbortController().signal,socket=await kitSocket(dir,()=>broker,signal,async(transport,signal)=>{
    const reply=await post('availability',{pin,transport,offered:broker.offeredKits()},signal) as {unavailable:unknown};
    return kitUnavailableList.parse(reply.unavailable);
  });clean.push(()=>socket.close());
  // The engine mounts the worker socket at this fixed path. The test process
  // reaches the same UNIX listener at its host path without a mount namespace.
  const load=bodyKits.bodyKitTools;
  vi.spyOn(bodyKits,'bodyKitTools').mockImplementation((path,signal,onUnavailable)=>{expect(path).toBe(bodyKits.KIT_SOCKET);return load(socket.path,signal,onUnavailable);});
  const job={id:'job',agent:'art',box:'box',conversation,venue:'wake',account:'fixture',model:'fixture',harness:'claude',brief:'',
    house:{repository:house.repository,file:'Housefile',branch:'main'},run:{nestedContainers:false,gpu:false,ports:[],policy:room}};
  const envelope=Buffer.from(JSON.stringify({job,build:house.image,kitSocket:true,bootstrap:{origin:url,job:'job',token:body}}));
  const plan=join(dir,'body.json');
  await writeFile(plan,JSON.stringify({cwd:dir,command:resolve('test/fixtures/kit-model.mjs'),reach:'all'}));
  const errors=vi.fn();
  const result=await bodyProgram({args:[plan],read:path=>readFile(path,'utf8'),stdin:async()=>envelope,env:{PATH:dirname(process.execPath)},signal,clock:f.clock,
    schedule:{every:()=>()=>{}},error:errors});
  expect(result,JSON.stringify(errors.mock.calls)).toBe(0);
  const report=JSON.parse(await readFile(join(dir,'model-report.json'),'utf8'));
  expect(report.ephemeral).toBe(true);expect(report.ambient).toBe(false);
  expect(report.args.slice(report.args.indexOf('--tools'),report.args.indexOf('--tools')+2)).toEqual(['--tools','']);
  expect(report.args.slice(report.args.indexOf('--disallowedTools'))).toEqual(expect.arrayContaining(['Bash','Read','WebFetch','Agent']));
  expect(report.names).not.toContain('request_secret');expect(report.names).not.toContain('use_secret');
  expect(report.names.filter((name:string)=>name.startsWith('kit_'))).toEqual(usable?['kit_lookup']:[]);
  expect(report.kitBrief).toBe(scenario==='different house'
    ? 'Kit pond is unavailable because the job ran in a different house than the one pinned by the kit.' : null);
  if(usable){
    expect(report.results[0]).toMatchObject({content:[{text:'["pond $(date); echo"]'}]});
    expect(report.results[1]).toMatchObject({isError:true});
    expect(report.results[2]).toMatchObject({isError:true,content:[{text:expect.stringContaining('The tool did not run')}]});
  }
  for(const value of [secret,Buffer.from(secret).toString('base64'),body,bodyCredentials.runner])expect(JSON.stringify(report)).not.toContain(value);
  expect(read).toHaveBeenCalledTimes(usable?2:0);expect(launches).toBe(usable?2:0);
  const audit=f.db.select().from(s.kitUses).all();
  expect(audit.map(row=>row.outcome)).toEqual(usable?['ran','failed','refused']:[]);
  expect(JSON.stringify(audit)).not.toContain(secret);
});
