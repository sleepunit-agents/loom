/** Observe the actual browser transport and actual SQLite executions. No mock IO. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
const signatures={Tasks:'query\\s+Tasks\\b',Approvals:'query\\s+ApprovalsView\\b','Project sharing':'\\bhouseholdSharing\\b',Changes:'query\\s+ChangesView\\b',Inbox:'query\\s+Inbox\\b',Tempo:'query\\s+Tempo\\b',Home:'query\\s+DeskLastAnswer\\b',Projects:'query\\s+MemoryProjects\\b',Activity:'query\\s+MemoryActivity\\b',Comms:'query\\s+Comms\\b',Agents:'query\\s+DeskAgentProfiles\\b',People:'query\\s+MemoryPeople\\b',Knowledge:'query\\s+MemoryKnowledge\\b',Bridges:'query\\s+Bridges\\b',Settings:'query\\s+SettingsSecrets\\b','Household setup':'\\bhouseholdSetup\\b','Your account':'\\baccount\\s*\\{'};
export async function installDataProbe(page){
 await page.addInitScript(()=>{
  const Native=globalThis.WebSocket,state={sockets:[],entries:new WeakMap()};globalThis.__loomDataProbe=state;
  globalThis.WebSocket=class extends Native{
   constructor(...args){super(...args);const entry={socket:this,requests:[],active:new Map(),frames:[]};state.sockets.push(this);state.entries.set(this,entry);
    this.addEventListener('message',event=>{try{const m=JSON.parse(event.data),d=m.payload?.data?.observe;if(m.type==='complete'||m.type==='error')entry.active.delete(m.id);if(d)entry.frames.push({id:m.id,revision:d.revision,paths:d.patches.map(p=>p.path)});}catch{}});
   }
   send(data){try{const m=JSON.parse(data),entry=state.entries.get(this);if(m.type==='subscribe'){const request={id:m.id,query:m.payload?.variables?.query??m.payload?.query,variables:m.payload?.variables?.variables??{}};entry.requests.push(request);entry.active.set(m.id,request);}if(m.type==='complete')entry.active.delete(m.id);}catch{}return super.send(data);}
  };
 });
}
export async function auditDataDoor(page,title){
 if(!signatures[title])return{known:false,title};
 return page.evaluate(({title,pattern})=>{const state=globalThis.__loomDataProbe,open=state.sockets.filter(s=>s.readyState===WebSocket.OPEN),graphql=open.filter(s=>new URL(s.url).pathname==='/graphql');return{known:true,title,graphql:graphql.length,other:open.filter(s=>new URL(s.url).pathname!=='/graphql').map(s=>new URL(s.url).pathname),selectionSeen:graphql.some(s=>state.entries.get(s).requests.some(r=>new RegExp(pattern).test(r.query)))};},{title,pattern:signatures[title]});
}
const check=(yes,message)=>{if(!yes)throw Error(message);};
/** Attribute queries to the tagged browser request, retaining no bind values. */
async function sqlRead({page,app,query,match,task}){
 const scope=new AsyncLocalStorage(),db=app.services.comms.db.$client,prepare=db.prepare,fetch=app.http.fetch,statements=[];
 app.http.fetch=(request,...rest)=>scope.run(request.headers.get('x-loom-walkthrough-sql')==='measure',()=>Reflect.apply(fetch,app.http,[request,...rest]));
 db.prepare=function(sql){const statement=Reflect.apply(prepare,this,[sql]);if(match.test(sql))for(const method of ['get','all','iterate']){const original=statement[method];statement[method]=function(...args){if(scope.getStore()&&(!task||args.flat(Infinity).includes(task)))statements.push(String(sql));return Reflect.apply(original,this,args);};}return statement;};
 try{const response=await page.evaluate(async query=>{const r=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json','x-loom-walkthrough-sql':'measure'},body:JSON.stringify({query}),signal:AbortSignal.timeout(4000)});return{status:r.status,body:await r.json()};},query);return{...response,statements};}
 finally{app.http.fetch=fetch;db.prepare=prepare;scope.disable();}
}
async function open(page,title){
 await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+Space');const launcher=page.getByRole('dialog',{name:'Apps',exact:true});await launcher.waitFor();const button=launcher.locator('.loom-lapp').filter({has:page.locator('.loom-lapp__nm',{hasText:new RegExp('^'+title+'$')})});await button.focus();await button.press('Enter');await launcher.waitFor({state:'hidden'});const tile=page.getByRole('region',{name:`${title} tile`,exact:true});await tile.waitFor();return tile;
}
const envelope='subscription WalkthroughData($query:String!) { observe(query:$query) { revision patches { path removed value } } }';
async function watch(page,query){
 await page.evaluate(({query,envelope})=>{const state=globalThis.__loomDataProbe,socket=state.sockets.find(s=>s.readyState===WebSocket.OPEN&&new URL(s.url).pathname==='/graphql');if(!socket)throw Error('No current GraphQL connection');const entry=state.entries.get(socket),id='walkthrough-data-'+crypto.randomUUID(),probe={id,socket,events:[],error:null};probe.listener=event=>{try{const m=JSON.parse(event.data);if(m.id!==id)return;if(m.type==='error'||m.payload?.errors)probe.error=JSON.stringify(m.payload);if(m.payload?.data?.observe)probe.events.push(m.payload.data.observe);}catch{}};socket.addEventListener('message',probe.listener);state.probe=probe;socket.send(JSON.stringify({id,type:'subscribe',payload:{query:envelope,variables:{query}}}));}, {query,envelope});
 await page.waitForFunction(()=>globalThis.__loomDataProbe.probe.error||globalThis.__loomDataProbe.probe.events.length>0,undefined,{timeout:4000});
 const initial=await page.evaluate(()=>{const p=globalThis.__loomDataProbe.probe;return{error:p.error,delta:p.events[0]};});check(!initial.error,'Data subscription refused: '+initial.error);return initial.delta;
}
async function stop(page){await page.evaluate(()=>{const state=globalThis.__loomDataProbe,p=state?.probe;if(!p)return;p.socket.removeEventListener('message',p.listener);if(p.socket.readyState===WebSocket.OPEN)p.socket.send(JSON.stringify({id:p.id,type:'complete'}));delete state.probe;}).catch(()=>{});}
export async function dataActions({page,app,example,apps,subscriptions,out}){
 const evidence={};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await stop(page);await page.screenshot({path:join(out,screenshot),fullPage:true});};
 const unknown=apps.filter(a=>!a.dataDoor?.known);
 evidence.dataDoor=unknown.length?{inconclusive:true,reason:'No query signature for '+unknown.map(a=>a.title).join(', ')}:{ok:apps.every(a=>a.opened&&a.dataDoor.graphql===1&&!a.dataDoor.other.length&&a.dataDoor.selectionSeen),reason:'Every visited app was checked for its actual data selection on the current document’s single open GraphQL socket.',apps:apps.map(a=>a.dataDoor)};
 await attempt('dataSelectionSQL',async()=>{
  const original=subscriptions.find(s=>/query\s+Tasks\b/.test(s.query))?.query;check(original,'The real Tasks selection was not observed');
  const query=original.replace(/\btasks\s*\(/,'tasks(where:{id:{eq:'+JSON.stringify(example.tasks[0])+'}}, ');check(query!==original,'Could not add the ID filter to the actual tile selection');
  const result=await sqlRead({page,app,query,task:example.tasks[0],match:/\b(?:from|join)\s+"?tasks"?\b/i});
  check(result.status===200&&!result.body.errors,'Generated selection failed: '+JSON.stringify(result.body.errors));
  const rows=result.body.data.tasks;check(rows.length===1&&rows[0].id===example.tasks[0]&&rows[0].taskCommentsByTask.length>0,'Filtering or connected comment rows differed');
  check(result.statements.length===1,'Filtered relational task selection used '+result.statements.length+' fact SQL executions');
  const sql=result.statements[0];check(sql.includes('task_comments')&&sql.includes('members')&&sql.includes('project_members'),'SQL omitted connected reads or sharing predicates');
  return{reason:'The observed Tasks selection named its fields/relations and its filtered replay returned one task with comments in one SQL statement containing live sharing predicates.',statements:result.statements,fields:Object.keys(rows[0]),task:example.tasks[0]};
 });
 await attempt('dataSharingSQL',async()=>{
  const query=subscriptions.find(s=>/\bhouseholdSharing\b/.test(s.query))?.query;check(query,'The actual Sharing selection was not observed');
  const result=await sqlRead({page,app,query,match:/\b(?:from|join)\s+"?project(?:s|_members|_agents|_repositories)"?\b/i});check(result.status===200&&!result.body.errors,'Sharing read failed');
  const distinct=[...new Set(result.statements)];check(distinct.length===1,'One Sharing root selection executed '+distinct.length+' distinct project/relationship SQL statements: '+JSON.stringify(distinct));
  return{reason:'The Sharing root selection used one project/relationship fact statement.',statements:distinct};
 });
 await attempt('dataTaskPatches',async()=>{
  await open(page,'Tasks');
  await page.waitForFunction(()=>{const s=globalThis.__loomDataProbe,e=s.entries.get(s.sockets.find(x=>x.readyState===WebSocket.OPEN&&new URL(x.url).pathname==='/graphql'));return e&&[...e.active.values()].some(r=>/query\s+Tasks\b/.test(r.query)&&e.frames.some(f=>f.id===r.id));},undefined,{timeout:4000});
  await page.evaluate(()=>{const s=globalThis.__loomDataProbe,e=s.entries.get(s.sockets.find(x=>x.readyState===WebSocket.OPEN&&new URL(x.url).pathname==='/graphql'));s.beforeTasks={ids:[...e.active.values()].filter(r=>/query\s+Tasks\b/.test(r.query)).map(r=>r.id),requests:e.requests.filter(r=>/query\s+Tasks\b/.test(r.query)).length,frames:e.frames.length};});
  const initial=await watch(page,'{ tasks(where:{id:{eq:'+JSON.stringify(example.tasks[0])+'}}) { id title commentCount } }');
  check(initial.revision===1&&initial.patches.length===1&&initial.patches[0].path.length===0,'Missing one initial result');const before=initial.patches[0].value.tasks[0].commentCount;
  app.writes.run(()=>app.services.tasks.comment(example.tasks[0],'A fictitious live-delta comment.',{kind:'member',id:'alex'}));
  await page.waitForFunction(()=>globalThis.__loomDataProbe.probe.events.length>1||globalThis.__loomDataProbe.probe.error,undefined,{timeout:4000});
  const proof=await page.evaluate(()=>{const s=globalThis.__loomDataProbe,p=s.probe,e=s.entries.get(p.socket);return{error:p.error,events:p.events,requests:e.requests.filter(r=>r.id===p.id).length,taskRequests:e.requests.filter(r=>/query\s+Tasks\b/.test(r.query)).length,before:s.beforeTasks,taskFrames:e.frames.slice(s.beforeTasks.frames).filter(f=>s.beforeTasks.ids.includes(f.id))};});
  check(!proof.error&&proof.requests===1&&proof.taskRequests===proof.before.requests,'A selection was resubscribed for a normal change');
  const delta=proof.events[1];check(delta.revision>1&&delta.patches.length===1&&JSON.stringify(delta.patches[0].path)===JSON.stringify(['tasks',0,'commentCount'])&&delta.patches[0].value===before+1,'Changed fields were not delivered as one narrow patch');
  check(proof.taskFrames.some(f=>f.revision>1)&&proof.taskFrames.every(f=>f.paths.every(path=>path.length>0)),'The actual Tasks tile did not receive changes without another root snapshot');
  return{reason:'The same socket delivered one initial result then only the changed comment count; the real Tasks selection received patches without resubscribing.',initialRevision:initial.revision,changedRevision:delta.revision,patches:delta.patches,taskFrames:proof.taskFrames,requests:proof.requests};
 });
 await attempt('dataInboxChange',async()=>{
  const tile=await open(page,'Inbox'),back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();await tile.getByLabel('Search asks',{exact:true}).fill('');
  const question='Fictitious live data-layer question?';
  const initial=await watch(page,'{ inboxItems(folder:"needs", search:'+JSON.stringify(question)+', limit:51, offset:0) { id body { words } } }');check(initial.patches[0].value.inboxItems.length===0,'Unique question already existed');
  const commit=await app.services.comms.prepareAsk(example.thread,'fern','walkthrough-live-inbox',{words:question,answers:'yes-no',ifYes:'Fern proceeds.',ifNo:'Fern waits.'});const message=app.writes.run(commit).value;
  await page.waitForFunction(()=>globalThis.__loomDataProbe.probe.events.length>1||globalThis.__loomDataProbe.probe.error,undefined,{timeout:4000});
  await tile.locator('[data-split-row]:visible').filter({hasText:question}).waitFor({timeout:4000});
  const proof=await page.evaluate(()=>{const s=globalThis.__loomDataProbe,p=s.probe,e=s.entries.get(p.socket);return{error:p.error,events:p.events,requests:e.requests.filter(r=>r.id===p.id).length};});
  check(!proof.error&&proof.requests===1&&proof.events.slice(1).every(d=>d.patches.every(p=>p.path.length>0)),'Inbox needed a second selection/root snapshot');
  return{reason:'A new private question arrived as a change over the existing socket and appeared in the already open Inbox without another selection.',item:message.inboxItem,initialRevision:initial.revision,changedRevisions:proof.events.slice(1).map(d=>d.revision),requests:proof.requests};
 });
 return evidence;
}
