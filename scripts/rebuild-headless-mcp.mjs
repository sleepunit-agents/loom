/** Isolated normal-startup terminal MCP evidence. No browser, worker or model process. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
const requireFact=(value,message)=>{if(!value)throw Error(message);};
export async function headlessMcpEvidence(){
 const directory=mkdtempSync(join(tmpdir(),'loom-headless-evidence-')),home=join(directory,'home'),abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),12000),client=new Client({name:'fictional-terminal-evidence',version:'1'});
 let app,owner,credential,answer;const cleanup={credentialsRevoked:false,rootClosed:false,homeRemoved:false};
 try{
  const webRoot=join(directory,'web');mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictional headless household</main>');
  const example=await exampleHome(home),clock=new FakeClock(Date.parse(example.createdAt));requireFact(example.fictional,'Headless evidence requires a new fictional home');
  const config=join(home,'program.json'),program=JSON.parse(readFileSync(config,'utf8')),adapter=join(home,'headless-embedding.mjs');
  writeFileSync(adapter,'import previous from '+JSON.stringify(pathToFileURL(program.adapters).href)+';\nexport default async context=>({...await previous(context),memoryEmbedding:()=>({dimensions:4,embed:async()=>[1,0,0,0],embedBatch:async words=>words.map(()=>[1,0,0,0])})});\n',{mode:0o600,flag:'wx'});
  program.adapters=adapter;writeFileSync(config,JSON.stringify(program),{mode:0o600});
  app=await startSharedHome({home,clock,port:0,webRoot,stdout(){},reportError(){}});
  const db=app.services.comms.db.$client,beforeJobs=db.prepare('SELECT count(*) AS n FROM jobs').get().n;
  owner=app.writes.run(()=>app.services.signin.issue({kind:'owner',member:'alex',label:'Fictional headless owner setup'})).value;
  const issued=await fetch(app.url+'/api/signin/token',{method:'POST',signal:abort.signal,headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify({kind:'agent',agent:'fern',label:'Fictional headless terminal'})});
  requireFact(issued.status===200,'The owner could not issue a terminal token over the real HTTP door');credential=(await issued.json()).value;
  writeFileSync(join(home,'agents/fern/IDENTITY.md'),'FICTIONAL_HEADLESS_IDENTITY');
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',app.url),{requestInit:{signal:abort.signal,headers:{authorization:'Bearer '+credential.token,'x-loom-agent':'fern'}}}));
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args},undefined,{signal:abort.signal});requireFact(!result.isError,'Headless '+(args.operation??name)+' was refused');return JSON.parse(result.content[0].text);};
  const query=async query=>{const result=await call('loom_query',{query});requireFact(!result.errors,'A headless query failed');return result.data;};
  const command=async(operation,input)=>{const result=await call('loom_command',{operation,input,id:randomUUID()});requireFact(result.ok===true,'A canonical headless operation failed');return result.value;};
  const identity=await client.callTool({name:'identity',arguments:{client:'fictional-terminal-evidence'}},undefined,{signal:abort.signal});requireFact(!identity.isError&&identity.content[0]?.text.includes('FICTIONAL_HEADLESS_IDENTITY'),'The terminal identity tool did not load its actual creed');
  requireFact((await query('{memoryIdentity(agent:"fern"){creed}}')).memoryIdentity?.creed==='FICTIONAL_HEADLESS_IDENTITY','The authenticated terminal did not load its own Identity');
  const words='FICTIONAL_HEADLESS_RETAINED_WORDS',remembered=await command('memory.remember',{category:'reference',title:'Fictional headless lesson',content:words,ttl:'permanent'}),recalled=await command('memory.recall',{query:'headless lesson'});
  requireFact(remembered.ids.length===1&&recalled.ids.includes(remembered.ids[0]),'Native semantic memory did not round trip');
  requireFact((await query('{memoryProjectMemory(id:'+JSON.stringify(remembered.ids[0])+'){content}}')).memoryProjectMemory?.content===words,'Recall did not resolve to its actual retained words');
  const noteWords='FICTIONAL_HEADLESS_NOTE_WORDS';await command('memory.noteWrite',{path:'fictional/headless',body:noteWords,lifespan:'keep'});
  requireFact((await query('{memoryNote(agent:"fern",path:"fictional/headless"){body by}}')).memoryNote?.body===noteWords,'The private note did not round trip');
  const task=await command('tasks.command',{action:'create',input:{title:'Fictional headless task',goal:'Complete a task through the terminal door',why:'The terminal uses the same program',owner:{kind:'agent',id:'fern'}}});
  requireFact((await query('{tasks{id}}')).tasks.some(row=>row.id===task.id),'The terminal cannot list its new task');
  await command('tasks.command',{action:'claim',id:task.id});await command('tasks.command',{action:'comment',id:task.id,text:'Fictional headless result'});await command('tasks.command',{action:'close',id:task.id,reason:'Fictional headless work completed'});
  requireFact(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id)?.status==='closed','The canonical task did not close');
  const fact=await command('mind.knowledgeAdd',{title:'Fictional headless fact',domain:'fictional',body:'A fictional terminal can read what it knows.'});
  const page=(await query('{memoryKnowledgePage(slug:'+JSON.stringify(fact.slug)+'){body by}}')).memoryKnowledgePage;requireFact(page?.body==='A fictional terminal can read what it knows.'&&page.by==='fern','Knowledge did not retain the terminal author and words');
  requireFact(db.prepare('SELECT count(*) AS n FROM jobs').get().n===beforeJobs,'The terminal unexpectedly fabricated a worker job');
  const image=db.serialize();for(const value of [words,noteWords,owner.token,credential.token])requireFact(!image.includes(Buffer.from(value)),'Private words or raw credentials reached the shared database');
  answer={identity:true,memory:true,notes:true,knowledge:true,tasks:true,noBrowser:true,noWorkerJob:true,embedding:'trusted fictional 4-dimensional provider; actual SQLite vector backend',transport:'real HTTP MCP on normal shared startup',cleanup};
 }finally{
  clearTimeout(deadline);abort.abort();const errors=[];
  try{await client.close();}catch(error){errors.push(error);}
  try{if(app)app.writes.run(()=>{if(credential)app.services.signin.revoke(credential.fingerprint);if(owner)app.services.signin.revoke(owner.fingerprint);for(const value of [credential,owner].filter(Boolean))requireFact(!!app.services.comms.db.$client.prepare('SELECT revoked_at FROM tokens WHERE fingerprint=?').get(value.fingerprint)?.revoked_at,'A headless fixture credential remained live');cleanup.credentialsRevoked=true;});}catch(error){errors.push(error);}
  try{await app?.close();if(app){requireFact(app.services.comms.db.$client.open===false,'The headless Root connection remained open');cleanup.rootClosed=true;}}catch(error){errors.push(error);}finally{rmSync(directory,{recursive:true,force:true});cleanup.homeRemoved=!existsSync(directory);requireFact(cleanup.homeRemoved,'The headless fixture home remained');}
  if(errors.length)throw Error('Headless evidence cleanup failed');
 }
 return answer;
}
