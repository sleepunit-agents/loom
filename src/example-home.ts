/** Fictitious acceptance household. Use application services, never row inserts.
 * Missing operations are evidence, not a reason to manufacture passing data. */
import Database from 'better-sqlite3';
import {z} from 'zod';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createDataSchema} from './core/data/database.js';
import {householdService} from './apps/household.js';
import {sharedRoot} from './shared-root.js';
import {FakeClock} from './core/clock.js';
import {exampleRuntime,exampleModelRoles,exampleBackdateMs} from './example-runtime.js';
import {loadKey} from './pieces/comms/crypto.js';

export async function exampleHome(directory:string, webRoot=resolve('dist/web')) {
 const home=resolve(directory);
 // Exclusive creation: this command never opens an existing household.
 mkdirSync(home,{mode:0o700});
 // Settle fictitious inbox mail before wall-clock startup, without future facts.
 const at=new Date(Date.now()-exampleBackdateMs).toISOString(),clock=new FakeClock(Date.parse(at));
 const client=new Database(join(home,'app.db'));
 let root:ReturnType<typeof sharedRoot>|undefined;
 try {
  const db=createDataSchema(client,()=>at),house=householdService(db,()=>at);
  for(const [id,about,markBg,faceShape] of [
   ['fern','Looks after the example garden.','#267a52','pebble'],
   ['moss','Plans repairs for the example shed.','#7959b8','drop'],
  ] as const) house.setAgent({id,about,markBg,markFg:'#ffffff',faceShape,faceEyes:'dot'});
  house.setMember({id:'alex',role:'owner',fullOwner:true,agents:['fern','moss']});
  house.setMember({id:'robin',role:'member',agents:['moss']});
  const commsKey=await loadKey(home);
  root=sharedRoot({db,clock,commsKey,originAllowed:()=>false,reportError:error=>{throw error;},
   modelRoles:()=>exampleModelRoles});
  await root.ready;
  const s=root.services,actor={kind:'member' as const,id:'alex'};
  const thread=s.comms!.threads.open({member:'alex',agent:'fern',title:'Repair the garden pump'});
  await s.comms!.send({thread:thread.id,sender:'alex',kind:'message',words:'Please compare replacement pumps for our example garden.'});
  await s.comms!.send({thread:thread.id,sender:'fern',kind:'reply',words:'Three fit. The quiet model costs 164 example dollars.'});
  const tasks=['Compare garden pumps','Order the selected pump','Measure the hose','Retire the broken pump'].map(title=>s.tasks.create({title,goal:'The example garden has working water.',why:'The old pump stopped.',owner:{kind:'agent',id:'fern'},source:{kind:'conversation',id:thread.conversation}},actor));
  s.tasks.claim(tasks[0].id,{kind:'agent',id:'fern'});
  s.tasks.close(tasks[3].id,'The broken pump was recycled.');
  s.tasks.link(tasks[1].id,tasks[0].id,'blocks');
  s.tasks.comment(tasks[0].id,'Compared three fictitious models.',{kind:'agent',id:'fern'});
  const approval=s.approvals.request({kind:'command',target:'example-worker:inspect-pump',what:'Inspect the example pump',why:'Check the hose before ordering.',agent:'fern',askedFrom:thread.conversation,actingFor:'alex',conversation:thread.conversation,member:'alex',ask:'Inspect the example pump?',ifYes:'Fern inspects it.',ifNo:'Fern waits.'});
  await s.comms!.ask(thread.id,'fern','example-question',{words:'Spend up to 180 example dollars on the pump?',answers:'yes-no',why:'The example pump is available.',ifYes:'Fern orders the pump.',ifNo:'Fern compares cheaper pumps.'});
  const trigger=s.tempo.triggers.set({ownerKind:'agent',owner:'fern',sourceKind:'answer',watches:approval.id,lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fern',instructions:'Continue after the example inspection is answered.',note:'Continue the pump inspection'});
  const change=s.changes.put({id:'github:example-house/garden#12',repo:'github:example-house/garden',number:12,page:'',title:`Plan the pump repair (${tasks[0].id})`,body:'Fictitious pull request for the browser walkthrough.',url:'https://github.com/example-house/garden/pull/12',state:'open',draft:false,author:{login:'example-fern'},created:at,updated:at,closed:null,head:{ref:'pump-repair',id:'a'.repeat(40)},base:{ref:'next'},checks:{state:'passing',failing:[],running:[],total:1},review:{state:'approved',by:[]},mergeable:'yes',conflicts:false,people:[]});
  // This is an outside operation: use an actual current credential rather
  // than treating a caller label as identity. The setup token never survives.
  const setup=root.writes.run(()=>s.signin.issue({kind:'owner',member:'alex',label:'Example setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
  let account:{id:string};let runtime:Awaited<ReturnType<typeof exampleRuntime>>;
  try{
   const response=await root.http.request('http://example/api/runtime/accountCreate',{method:'POST',headers:{authorization:'Bearer '+setup.token,'content-type':'application/json'},body:JSON.stringify({id:'example-account',input:{provider:exampleModelRoles[0].provider,label:'Example model subscription'}})});
   const answer=z.object({ok:z.literal(true),value:z.object({id:z.string()}).strict()}).strict().safeParse(await response.json());
   if(!response.ok||!answer.success)throw Error('Example account could not be created through its API');
   account=answer.data.value;
   runtime=await exampleRuntime(root,clock,setup.token,{account:account.id,owner:'alex',provider:exampleModelRoles[0].provider});
  }finally{root.writes.run(()=>s.signin.revoke(setup.fingerprint));}
  const commons=join(home,'commons'),adapters=join(home,'example-adapters.mjs');
  writeFileSync(adapters,'export default () => ({modelRoles: () => '+JSON.stringify(exampleModelRoles)+'});\n',{mode:0o600});
  const program={adapters,database:join(home,'app.db'),commsKey:join(home,'comms.key'),signinMember:'alex',webRoot:resolve(webRoot),memory:{checkingAgent:'fern',sources:{commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:['fern','moss'].map(agent=>({agent,directory:join(home,'agents',agent),memories:join(home,'agents',agent,'memories.db')}))}}};
  const manifest={fictional:true,createdAt:at,members:['alex','robin'],agents:['fern','moss'],thread:thread.id,conversation:thread.conversation,tasks:tasks.map(t=>t.id),approval:approval.id,trigger:trigger.id,change:change.id,account,runtime,gaps:[
   {page:'people',promise:'A shared project with members, agents and a repository',reason:'No project administration operation or trusted shared service is registered; no raw rows were inserted.'},
   {page:'machines',promise:'A worker claims and executes its queued job',reason:'The example uses real setup, reporting and inbox admission, but does not claim a job or execute a worker/body/provider.'},
  ]};
  writeFileSync(join(home,'program.json'),JSON.stringify(program,null,2)+'\n',{mode:0o600});
  writeFileSync(join(home,'example.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return manifest;
 } finally {await root?.close();client.close();}
}

/** The command entry is testable in-process; no second program or test-only door. */
export async function runExampleHome(args:string[], stdout:(text:string)=>void, stderr:(text:string)=>void) {
 if(args.length!==1){stderr('Usage: node scripts/example-home.mjs <new-home>');return 2;}
 try{stdout(JSON.stringify(await exampleHome(args[0]),null,2));return 0;}
 catch(error){stderr(error instanceof Error?error.message:'Example home failed');return 1;}
}
