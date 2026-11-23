import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { bodyProgramTools } from './runtime/body-program-tools.js';
import { agentPosts, inbox, messages } from './core/data/schema.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

it('posts, resumes and renames activities through the body MCP tool and reads them on the member desk', async () => {
  const f = await bodyFixture(clean);
  const tools = bodyProgramTools({
    url:'https://loom.invalid', token:bodyCredentials.body, clock:f.clock, signal:new AbortController().signal,
    fetch:async (url,init) => f.root.http.request(new Request(String(url),init)), onStop() {}, onStatus() {},
  });
  clean.push(() => tools.close());
  const post = async (id:string,input:Record<string,unknown>) => {
    const result = await tools.call('loom_command',{operation:'conversation.activityPost',id,input});
    expect(result.isError,result.content[0].text).not.toBe(true);
    return JSON.parse(result.content[0].text).value.thread as string;
  };
  const opening = {action:'open',words:'Making boot scroll.'};
  const boot = await post('start-boot',opening);
  expect(await post('start-boot',opening)).toBe(boot);
  const disk = await post('start-disk',{action:'open',words:'What filled the disk?'});
  await post('found-it',{action:'reply',thread:disk,words:'It was my test homes.'});
  await post('rename',{action:'rename',thread:disk,title:'The test homes'});
  await post('resume',{action:'reply',thread:boot,words:'It scrolls!'});
  expect(f.db.select().from(agentPosts).all()).toHaveLength(4);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  expect(f.db.select().from(messages).all()).toEqual([]);
  const response = await f.root.http.request('/graphql',{method:'POST', headers:{'content-type':'application/json',
    cookie:'loom_ui='+bodyCredentials.memberCookie},body:JSON.stringify({query:`{
      agentActivityFeed(agent:"art"){thread title latest{words source} parent{words}}
    }`})});
  expect(await response.json()).toEqual({data:{agentActivityFeed:[
    {thread:boot,title:opening.words,latest:{words:'It scrolls!',source:f.thread.id},parent:{words:opening.words}},
    {thread:disk,title:'The test homes',latest:{words:'It was my test homes.',source:f.thread.id},parent:{words:'What filled the disk?'}},
  ]}});
});

it('posts from the selected standalone terminal when two sessions are open on the machine', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const f = await bodyFixture(clean);
  const {token} = f.root.services.signin.issue({kind:'agent',agent:'art',label:'Terminal',terminalMachine:'box'},'alice');
  const origin='https://loom.invalid';
  const client=new Client({name:'fixture-terminal',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',origin),{
    fetch:async(url,init)=>f.root.http.request(new Request(url,init)),requestInit:{headers:{authorization:'Bearer '+token}},
  }));
  clean.push(()=>client.close());
  const command=async(operation:string,id:string,input:unknown)=>{
    const result=await client.callTool({name:'loom_command',arguments:{operation,id,input}});
    return JSON.parse((result.content as {text:string}[])[0].text);
  };
  const sessions=[{harness:'claude',sessionId:'first'},{harness:'codex',sessionId:'second'}];
  const sources=[];
  const bindings:string[]=[];
  for (const session of sessions) {
    const result=await command('terminal.session','open-'+session.sessionId,{
      action:'open',machine:'box',...session,instanceId:'process-'+session.sessionId,model:null,cwd:'/work',
    });
    expect(result.ok).toBe(true);
    sources.push(result.value.thread);
    const context=await command('terminal.activityContext','context-'+session.sessionId,session);
    expect(context.ok).toBe(true);
    bindings.push(context.value.binding);
  }
  const post = (i:number, id:string, edit:unknown) =>
    command('terminal.activityPost',id,{...sessions[i],binding:bindings[i],post:edit});
  const first={action:'open',words:'Checking the disk.'};
  const opened=await post(1,'disk',first);
  expect(opened).toMatchObject({ok:true,value:{thread:expect.any(String)}});
  expect(await post(1,'disk',first)).toEqual(opened);
  const reply={action:'reply',thread:opened.value.thread,words:'Found the test directories.'};
  expect(await post(1,'found',reply)).toEqual(opened);
  const response=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',
    cookie:'loom_ui='+bodyCredentials.memberCookie},body:JSON.stringify({query:'{agentActivityFeed(agent:"art"){latest{words source} parent{words}}}'})});
  expect(await response.json()).toEqual({data:{agentActivityFeed:[{latest:{words:reply.words,source:sources[1]},parent:{words:first.words}}]}});
  await command('terminal.session','finished',{action:'end',machine:'box',...sessions[1],instanceId:'process-second'});
  expect((await post(1,'late',reply)).ok).toBe(false);
  await command('terminal.session','next-process',{action:'open',machine:'box',...sessions[1],instanceId:'next',model:null,cwd:'/work'});
  const next=await command('terminal.activityContext','next-context',sessions[1]);
  expect(next.ok).toBe(true);
  expect(next.value.binding).not.toBe(bindings[1]);
  expect((await post(1,'late',reply)).ok).toBe(false);
  expect(f.db.select().from(agentPosts).all()).toHaveLength(2);
});

it('withholds a card post when the job is working for another asker',async()=>{
  const f=await bodyFixture(clean), at=new Date(f.clock.now()).toISOString();
  f.db.insert(inbox).values({id:'mail',toKind:'agent',to:'art',conversation:f.thread.conversation,source:'thread',
    fromKind:'person',fromId:'bob',at,changedAt:at,state:'taken',takenAt:at,job:'job'}).run();
  expect((await f.call('activityPost',{action:'open',words:'Checking the disk.'},'disk')).status).toBe(403);
  expect(f.db.select().from(agentPosts).all()).toEqual([]);
});

it('drops the prepared update when its job finishes before the post commits',async()=>{
  const f=await bodyFixture(clean), { jobs }=await import('./core/data/schema.js');
  let began!:()=>void, release!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const resume=new Promise<void>(resolve=>{release=resolve;});
  f.gate(async()=>{began();await resume;});
  const pending=f.call('activityPost',{action:'open',words:'Checking the disk.'},'disk');
  await started;
  f.root.writes.run(()=>f.db.update(jobs).set({state:'done'}).run());
  release();
  expect([401,403]).toContain((await pending).status);
  expect(f.db.select().from(agentPosts).all()).toEqual([]);
});
