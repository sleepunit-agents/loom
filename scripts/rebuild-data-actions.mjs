/** Observe the actual browser transport and actual SQLite executions. No mock IO. */
import {parse} from 'graphql';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
const signatures={Tasks:'query\\s+Tasks\\b',Approvals:'query\\s+ApprovalsView\\b',Sharing:'\\bhouseholdSharing\\b',Changes:'query\\s+ChangesView\\b',Inbox:'query\\s+Inbox\\b',Tempo:'query\\s+Tempo\\b',Home:'query\\s+DeskCardTalk\\b',Projects:'query\\s+MemoryProjects\\b',Activity:'query\\s+MemoryActivity\\b',Comms:'query\\s+Comms\\b',Agents:'query\\s+DeskAgentProfiles\\b',People:'query\\s+MemoryPeople\\b',Knowledge:'query\\s+MemoryKnowledge\\b',Bridges:'query\\s+Bridges\\b','Job usage':'query\\s+UsageConversations\\b','Machines and jobs':'query\\s+OwnerMachines\\b',Subscriptions:'\\bsubscriptionSetup\\b',Settings:'query\\s+SettingsSecrets\\b','Household setup':'\\bhouseholdSetup\\b','Your account':'\\baccount\\s*\\{',Appearance:'query\\s+DeskPreferences\\b'};
export async function installDataProbe(page){
 await page.addInitScript(()=>{
  const Native=globalThis.WebSocket,state={sockets:[],entries:new WeakMap()};globalThis.__loomDataProbe=state;
  globalThis.WebSocket=class extends Native{
   constructor(...args){super(...args);const entry={socket:this,requests:[],active:new Map(),frames:[]};state.sockets.push(this);state.entries.set(this,entry);
    this.addEventListener('message',event=>{try{const m=JSON.parse(event.data),d=m.payload?.data?.observe;if(m.type==='complete'||m.type==='error'||m.payload?.errors)entry.active.delete(m.id);if(d&&!m.payload?.errors)entry.frames.push({id:m.id,revision:d.revision,paths:d.patches.map(p=>p.path),patches:d.patches});}catch{}});
   }
   send(data){try{const m=JSON.parse(data),entry=state.entries.get(this);if(m.type==='subscribe'){const request={id:m.id,query:m.payload?.variables?.query??m.payload?.query,variables:m.payload?.variables?.variables??{}};entry.requests.push(request);entry.active.set(m.id,request);}if(m.type==='complete')entry.active.delete(m.id);}catch{}return super.send(data);}
  };
 });
}
export function connectionEvidence({title,pattern,waitForSelection=false}){
 const state=globalThis.__loomDataProbe,open=state.sockets.filter(s=>s.readyState===WebSocket.OPEN),graphql=open.filter(s=>new URL(s.url).pathname==='/graphql');
 const evidence={known:true,title,graphql:graphql.length,other:open.filter(s=>new URL(s.url).pathname!=='/graphql').map(s=>new URL(s.url).pathname),selectionSeen:graphql.some(s=>{const e=state.entries.get(s);return [...e.active.values()].some(r=>new RegExp(pattern).test(r.query)&&e.frames.some(f=>f.id===r.id));})};
 return waitForSelection?evidence.selectionSeen:evidence;
}
export async function auditDataDoor(page,title){
 if(!signatures[title])return{known:false,title};
 // A final folder click can replace the selection before its first result arrives.
 // Wait for actual successful data; a timeout still produces the missing-evidence result.
 await page.waitForFunction(connectionEvidence,{title,pattern:signatures[title],waitForSelection:true},{timeout:4000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
 return page.evaluate(connectionEvidence,{title,pattern:signatures[title]});
}
/** Reconstruct prior selected data; reject unchanged fields and collection snapshots. */
export function changedFields(history,after,root,minDepth){
 let value;let changes=0;
 for(let i=0;i<history.length;i++)for(const patch of history[i].patches){
  const path=patch.path;
  if(i>=after){
   if(!path.length)return false;
   if(path[0]===root){if(path.length<minDepth)return false;
   const previous=path.reduce((row,key)=>row?.[key],value);
   if(patch.removed?previous===undefined:JSON.stringify(previous)===JSON.stringify(patch.value))return false;
   changes++;}
  }
  if(!path.length){value=structuredClone(patch.value);continue;}
  const parent=path.slice(0,-1).reduce((row,key)=>row?.[key],value);if(!parent)return false;
  if(patch.removed)delete parent[path.at(-1)];else parent[path.at(-1)]=structuredClone(patch.value);
 }
 return changes>0;
}
const check=(yes,message)=>{if(!yes)throw Error(message);};
/** Attribute queries to the tagged browser request, retaining no bind values. */
export async function sqlRead({page,app,query,match,task,caller}){
 const scope=new AsyncLocalStorage(),db=app.services.comms.db.$client,prepare=db.prepare,fetch=app.http.fetch,statements=[],restore=[];
 app.http.fetch=(request,...rest)=>scope.run(request.headers.get('x-loom-walkthrough-sql')==='measure',()=>Reflect.apply(fetch,app.http,[request,...rest]));
 db.prepare=function(sql){const statement=Reflect.apply(prepare,this,[sql]);if(match.test(sql))for(const method of ['get','all','iterate']){const original=statement[method],descriptor=Object.getOwnPropertyDescriptor(statement,method);restore.push(()=>{if(descriptor)Object.defineProperty(statement,method,descriptor);else delete statement[method];});statement[method]=function(...args){if(scope.getStore()&&(!task||args.flat(Infinity).includes(task))&&(!caller||caller.test(new Error().stack??'')))statements.push(String(sql));return Reflect.apply(original,this,args);};}return statement;};
 try{const response=await page.evaluate(async query=>{const r=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json','x-loom-walkthrough-sql':'measure'},body:JSON.stringify({query}),signal:AbortSignal.timeout(4000)});return{status:r.status,body:await r.json()};},query);return{...response,statements};}
 finally{app.http.fetch=fetch;db.prepare=prepare;for(const undo of restore.reverse())undo();scope.disable();}
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
export async function sharingGrowth({page,app,subscriptions,out}){
 const screenshot='action-dataSharingSQL.png';let result;
 try{
  result=await (async()=>{
  const query=subscriptions.find(s=>/\bhouseholdSharing\b/.test(s.query))?.query;check(query,'The actual Sharing selection was not observed');
  const samples=[];
  for(const size of [2,10]){
   const existing=app.services.projects.read().projects.length;
   check(existing<=size,'The fresh household already exceeds the growth sample');
   for(let n=existing;n<size;n++)app.writes.run(()=>app.services.projects.save({id:'walkthrough-growth-'+n,name:'Fictional growth project '+n,members:['alex'],agents:['fern'],repositories:[]}));
   const result=await sqlRead({page,app,query,caller:/(?:at Object\.read \(.*shared-projects\.[jt]s:|at readSharing \()/,match:/\b(?:from|join)\s+/i});
   check(result.status===200&&!result.body.errors,'Sharing growth read failed');
   const rows=result.body.data?.householdSharing?.projects;
   check(Array.isArray(rows)&&rows.length===size,'The actual Sharing selection did not return the expected project count');
   check(result.statements.length>0,'No actual Sharing SQL executions were attributed');
   samples.push({projects:rows.length,sqlExecutions:result.statements.length,statements:[...new Set(result.statements)]});
  }
  const details={samples,statements:[...new Set(samples.flatMap(sample=>sample.statements))]};
  if(samples[1].sqlExecutions>samples[0].sqlExecutions)return{ok:false,...details,error:'Sharing SQL executions grew from '+samples[0].sqlExecutions+' to '+samples[1].sqlExecutions+' as projects grew from 2 to 10.'};
  return{...details,inconclusive:true,reason:'The actual Sharing selection uses a fixed SQL count at 2 and 10 projects, one API call each. The complete promise also requires filtering and caller visibility in the database; this growth measurement alone does not establish those clauses.'};
  })();
 }catch(error){result={inconclusive:true,reason:'The growth measurement did not complete: '+String(error)};}
 await page.screenshot({path:join(out,screenshot),fullPage:true});return{...result,screenshot};
}
export async function dataActions({page,app,example,apps,subscriptions,out,sharingSQL}){
 const evidence={};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await stop(page);await page.screenshot({path:join(out,screenshot),fullPage:true});};
 const unknown=apps.filter(a=>!a.dataDoor?.known||!a.dataDoor.selectionSeen),bad=apps.filter(a=>!a.opened||a.dataDoor?.graphql!==1||a.dataDoor?.other?.length);
 evidence.dataDoor=bad.length?{ok:false,error:'Expected one open GraphQL socket at '+bad.map(a=>a.title).join(', '),apps:apps.map(a=>a.dataDoor)}:unknown.length?{inconclusive:true,reason:'A current-document selection signature was not observed for '+unknown.map(a=>a.title).join(', '),apps:apps.map(a=>a.dataDoor)}:{ok:true,inconclusive:true,reason:'One active successful selection for every app used its current document’s GraphQL socket; complete attribution of every secondary selection and transient transport is not measured.',apps:apps.map(a=>a.dataDoor)};
 await attempt('dataSelectionSQL',async()=>{
  const original=subscriptions.find(s=>/query\s+Tasks\b/.test(s.query))?.query;check(original,'The real Tasks selection was not observed');
  const query=original.replace(/\btasks\s*\(/,'tasks(where:{id:{eq:'+JSON.stringify(example.tasks[0])+'}}, ');check(query!==original,'Could not add the ID filter to the actual tile selection');
  const result=await sqlRead({page,app,query,task:example.tasks[0],match:/\b(?:from|join)\s+"?tasks"?\b/i});
  check(result.status===200&&!result.body.errors,'Generated selection failed: '+JSON.stringify(result.body.errors));
  const rows=result.body.data.tasks;check(rows.length===1&&rows[0].id===example.tasks[0]&&rows[0].taskCommentsByTask.length>0,'Filtering or connected comment rows differed');
  const root=parse(query).definitions.find(d=>d.kind==='OperationDefinition').selectionSet.selections.find(f=>f.kind==='Field'&&f.name.value==='tasks');
  const fields=selection=>[...new Set(selection.selections.filter(f=>f.kind==='Field').map(f=>f.alias?.value??f.name.value))].sort();
  check(JSON.stringify(Object.keys(rows[0]).sort())===JSON.stringify(fields(root.selectionSet)),'The result did not contain exactly the selected task fields');
  const child=root.selectionSet.selections.find(f=>f.kind==='Field'&&f.name.value==='taskCommentsByTask');check(JSON.stringify(Object.keys(rows[0].taskCommentsByTask[0]).sort())===JSON.stringify(fields(child.selectionSet)),'Connected rows did not contain exactly the selected fields');
  return{reason:'The observed Tasks selection named its fields and connected comments; its filtered browser replay returned exactly those selected fields.',statements:result.statements,factSQLExecutions:result.statements.length,fields:Object.keys(rows[0]),task:example.tasks[0]};
 });
 evidence.dataSharingSQL=sharingSQL??{inconclusive:true,reason:'The early fresh-household growth measurement is unavailable.'};
 await attempt('dataTaskPatches',async()=>{
  await open(page,'Tasks');
  await page.waitForFunction(()=>{const s=globalThis.__loomDataProbe,e=s.entries.get(s.sockets.find(x=>x.readyState===WebSocket.OPEN&&new URL(x.url).pathname==='/graphql'));return e&&[...e.active.values()].some(r=>/query\s+Tasks\b/.test(r.query)&&e.frames.some(f=>f.id===r.id));},undefined,{timeout:4000});
  await page.evaluate(()=>{const s=globalThis.__loomDataProbe,e=s.entries.get(s.sockets.find(x=>x.readyState===WebSocket.OPEN&&new URL(x.url).pathname==='/graphql'));s.beforeTasks={ids:[...e.active.values()].filter(r=>/query\s+Tasks\b/.test(r.query)).map(r=>r.id),requests:e.requests.filter(r=>/query\s+Tasks\b/.test(r.query)).length,frames:e.frames.length};});
  const initial=await watch(page,'{ tasks(where:{id:{eq:'+JSON.stringify(example.tasks[0])+'}}) { id title commentCount } }');
  check(initial.revision===1&&initial.patches.length===1&&initial.patches[0].path.length===0,'Missing one initial result');const before=initial.patches[0].value.tasks[0].commentCount;
  app.writes.run(()=>app.services.tasks.comment(example.tasks[0],'A fictitious live-delta comment.',{kind:'member',id:'alex'}));
  await page.waitForFunction(()=>globalThis.__loomDataProbe.probe.events.length>1||globalThis.__loomDataProbe.probe.error,undefined,{timeout:4000});
  await page.waitForFunction(()=>{const s=globalThis.__loomDataProbe,p=s.probe,e=s.entries.get(p.socket);return e.frames.slice(s.beforeTasks.frames).some(f=>s.beforeTasks.ids.includes(f.id)&&f.revision>1);},undefined,{timeout:4000});
  const proof=await page.evaluate(()=>{const s=globalThis.__loomDataProbe,p=s.probe,e=s.entries.get(p.socket);return{error:p.error,events:p.events,requests:e.requests.filter(r=>r.id===p.id).length,taskRequests:e.requests.filter(r=>/query\s+Tasks\b/.test(r.query)).length,before:s.beforeTasks,history:e.frames.filter(f=>s.beforeTasks.ids.includes(f.id)),after:e.frames.slice(0,s.beforeTasks.frames).filter(f=>s.beforeTasks.ids.includes(f.id)).length,taskFrames:e.frames.slice(s.beforeTasks.frames).filter(f=>s.beforeTasks.ids.includes(f.id)).map(({patches,...frame})=>frame)};});
  check(!proof.error&&proof.requests===1&&proof.taskRequests===proof.before.requests,'A selection was resubscribed for a normal change');
  const delta=proof.events[1];check(delta.revision>1&&delta.patches.length===1&&JSON.stringify(delta.patches[0].path)===JSON.stringify(['tasks',0,'commentCount'])&&delta.patches[0].value===before+1,'Changed fields were not delivered as one narrow patch');
  check(proof.taskFrames.some(f=>f.revision>1)&&changedFields(proof.history,proof.after,'tasks',3),'The actual Tasks tile did not receive changes without another root snapshot');
  return{inconclusive:true,reason:'The actual Tasks comment delta was narrow and required no resubscription; complete change behavior across all selections and edits is not measured.',initialRevision:initial.revision,changedRevision:delta.revision,patches:delta.patches,taskFrames:proof.taskFrames,requests:proof.requests};
 });
 await attempt('dataInboxChange',async()=>{
  const tile=await open(page,'Inbox'),back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();await tile.getByLabel('Search asks',{exact:true}).fill('');
  await page.waitForFunction(()=>{const s=globalThis.__loomDataProbe,e=s.entries.get(s.sockets.find(x=>x.readyState===WebSocket.OPEN&&new URL(x.url).pathname==='/graphql'));return [...e.active.values()].some(r=>/query\s+Inbox\b/.test(r.query)&&e.frames.some(f=>f.id===r.id));},undefined,{timeout:4000});
  await page.evaluate(()=>{const s=globalThis.__loomDataProbe,e=s.entries.get(s.sockets.find(x=>x.readyState===WebSocket.OPEN&&new URL(x.url).pathname==='/graphql'));s.beforeInbox={ids:[...e.active.values()].filter(r=>/query\s+Inbox\b/.test(r.query)).map(r=>r.id),requests:e.requests.filter(r=>/query\s+Inbox\b/.test(r.query)).length,frames:e.frames.length};});
  const question='Fictitious live data-layer question?';
  const initial=await watch(page,'{ inboxItems(folder:"needs", search:'+JSON.stringify(question)+', limit:51, offset:0) { id body { words } } }');check(initial.patches[0].value.inboxItems.length===0,'Unique question already existed');
  const commit=await app.services.comms.prepareAsk(example.thread,'fern','walkthrough-live-inbox',{words:question,answers:'yes-no',ifYes:'Fern proceeds.',ifNo:'Fern waits.'});const message=app.writes.run(commit).value;
  await page.waitForFunction(()=>globalThis.__loomDataProbe.probe.events.length>1||globalThis.__loomDataProbe.probe.error,undefined,{timeout:4000});
  await tile.locator('[data-split-row]:visible').filter({hasText:question}).waitFor({timeout:4000});
  await page.waitForFunction(()=>{const s=globalThis.__loomDataProbe,p=s.probe,e=s.entries.get(p.socket);return e.frames.slice(s.beforeInbox.frames).some(f=>s.beforeInbox.ids.includes(f.id));},undefined,{timeout:4000});
  const proof=await page.evaluate(()=>{const s=globalThis.__loomDataProbe,p=s.probe,e=s.entries.get(p.socket);return{error:p.error,events:p.events,requests:e.requests.filter(r=>r.id===p.id).length,inboxRequests:e.requests.filter(r=>/query\s+Inbox\b/.test(r.query)).length,before:s.beforeInbox,history:e.frames.filter(f=>s.beforeInbox.ids.includes(f.id)),after:e.frames.slice(0,s.beforeInbox.frames).filter(f=>s.beforeInbox.ids.includes(f.id)).length};});
  check(!proof.error&&proof.requests===1&&proof.inboxRequests===proof.before.requests&&changedFields(proof.history,proof.after,'inboxItems',2)&&proof.events.slice(1).every(d=>d.patches.every(p=>p.path.length>0)),'Inbox needed a second selection/root snapshot');
  return{reason:'A new private question arrived as a change over the existing socket and appeared in the already open Inbox without another selection.',item:message.inboxItem,initialRevision:initial.revision,changedRevisions:proof.events.slice(1).map(d=>d.revision),requests:proof.requests};
 });
 return evidence;
}

/** Replay the observed Home summary read with two and ten owned agents. */
export async function homeReadGrowth({page,app,subscriptions,out,sharing}){
 const screenshot='action-dataHomeGrowth.png';let home;
 try{
  const query=subscriptions.find(row=>/query\s+DeskHomeComms\b/.test(row.query))?.query;check(query,'The actual Home summary selection was not observed');
  const samples=[];
  for(const size of [2,10]){
   const own=app.services.household.members().find(row=>row.id==='alex');check(own?.agents.length<=size,'The example owner already exceeds the Home sample');
   for(let n=own.agents.length;n<size;n++)app.writes.run(()=>{
    const agent='walkthrough-growth-agent-'+n;
    app.services.household.setAgent({id:agent,about:'Fictional read-growth agent.',markBg:'#267a52',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'});
    app.services.comms.threads.open({member:'alex',agent,title:'Fictional read-growth thread '+n});
   });
   const result=await sqlRead({page,app,query,caller:/at readCommsHome \(/,match:/\b(?:from|join)\s+/i});
   check(result.status===200&&!result.body.errors,'The actual Home summary read failed');
   const selected=result.body.data?.homeComms;check(selected?.agents.length===size&&selected.summaries.length===size,'Home did not return the expected agents and summaries');
   check(result.statements.length>0,'No actual Home SQL executions were attributed');
   samples.push({agents:selected.agents.length,summaries:selected.summaries.length,sqlExecutions:result.statements.length,statements:[...new Set(result.statements)]});
  }
  home={ok:samples[1].sqlExecutions<=samples[0].sqlExecutions,samples,screenshot};
  home.reason='Home summary SQL executions: '+samples.map(row=>row.agents+' agents → '+row.sqlExecutions).join('; ')+'.';
  if(!home.ok)home.error=home.reason;
 }catch{home={inconclusive:true,reason:'The actual Home growth measurement could not complete.',screenshot};}
 await page.screenshot({path:join(out,screenshot),fullPage:true});
 return{dataHomeGrowth:home,dataReadBounds:readBoundEvidence(sharing,home)};
}
/** A known counterexample survives another selection being unmeasured. */
export function readBoundEvidence(sharing,home){
 const failed=[sharing,home].find(row=>row?.ok===false);
 const reason=[sharing?.reason??sharing?.error,home?.reason??home?.error].filter(Boolean).join(' ');
 return failed?{ok:false,error:reason,screenshot:failed.screenshot}:{inconclusive:true,reason:reason+' Growth checks alone do not establish all filtering, visibility and page-wide read clauses.'};
}
