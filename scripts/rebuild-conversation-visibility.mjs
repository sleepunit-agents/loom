/** Two ordinary browser sign-ins against only the freshly created example home. */
import {join} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {requestLocalLink} from '../dist/core/signin/operator.js';
import {maskCredentialScreenshots} from './rebuild-credential-evidence.mjs';
export function visibleTo(member,row){return member.role==='owner'||(row.member?row.member===member.id:member.projects.includes(row.project)||member.agents.includes(row.agent));}
const ids=rows=>rows.map(row=>row.id).sort();
export class ObservedVisibilityFailure extends Error {constructor(message,domain='conversationVisibility'){super(message);this.domain=domain;}}
export const visibilityDomains=['conversationLabels','conversationVisibility','commsPrivacy','inboxVisibility','inboxRecipients'];
export function visibilityFailure(error){return Object.fromEntries(visibilityDomains.map(domain=>[domain,error instanceof ObservedVisibilityFailure&&error.domain===domain?{ok:false,error:redactSignin(error)}:{inconclusive:true,reason:'The '+domain+' measurement did not complete.'}]));}
export function redactSignin(error){return String(error).replace(/\/login\/[^\s"'<>]+/g,'/login/[redacted]').replace(/(Bearer\s+|loom_ui=)[^\s;"'<>]+/gi,'$1[redacted]');}
export async function restoreAndClose(restore,close){try{return restore();}finally{await close();}}
const check=(value,message,domain)=>{if(!value)throw new ObservedVisibilityFailure(message,domain);};
async function browserRead(page,query){const answer=await page.evaluate(async query=>{const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});return{status:response.status,body:await response.json()};},query);if(answer.status!==200||answer.body.errors)throw Error('Visibility selection was unavailable');return answer.body.data;}
export async function conversationVisibilityActions({page,browser,app,home,out,verifyIsolation}){
 const screenshot='action-conversationVisibility.png',s=app.services,db=s.comms.db.$client,write=fn=>app.writes.run(fn).value;
 const robin=s.household.members().find(member=>member.id==='robin'),garden=s.projects.read().projects.find(project=>project.id==='garden');let context,outcome,secretPath;const contextsBefore=browser.contexts().length;
 try{
  write(()=>s.projects.save({id:'visibility-only',name:'Fictitious Alex project',members:['alex'],agents:['fern','moss'],repositories:[]}));
  const own=write(()=>s.comms.threads.open({member:'robin',agent:'moss',title:'Fictitious Robin private visibility'}));
  const other=write(()=>s.comms.threads.open({member:'alex',agent:'moss',title:'Fictitious Alex private visibility'}));
  const shared=write(()=>s.conversations.open({agent:'fern',venue:'discord',place:'fictitious-visibility-garden',label:'Fictitious shared conversation',project:'garden'}));
  const owned=write(()=>s.conversations.open({agent:'moss',venue:'wake',place:'fictitious-visibility-owned',label:'Fictitious owned-agent conversation',project:'visibility-only'}));
  const hidden=write(()=>s.conversations.open({agent:'fern',venue:'wake',place:'fictitious-visibility-hidden',label:'Fictitious other conversation',project:'visibility-only'}));
  const privateItems=[];
  for(const thread of [own,other]){const commit=await s.comms.prepareAsk(thread.id,'moss','visibility-'+thread.id,{words:'Fictitious private visibility question?',answers:'yes-no',ifYes:'Proceed fictitiously.',ifNo:'Wait fictitiously.'});privateItems.push(write(commit).inboxItem);}
  const send=(conversation,toKind,to)=>write(()=>s.conversations.send({conversation:conversation.id,toKind,to,source:'notice',sourceId:'visibility-'+conversation.id+'-'+to,fromKind:'agent',fromId:conversation.agent,words:'Fictitious scope notice.'}));
  const items=[...privateItems,...[send(shared,'person','robin'),send(shared,'person','alex'),send(shared,'agent','fern'),send(owned,'person','robin'),send(hidden,'person','robin')].map(item=>item.id)];
  for(const conversation of [shared,owned,hidden])write(()=>{s.conversations.turn({conversation:conversation.id,kind:'note',fromKind:'agent',fromId:conversation.agent,run:'fictitious-visibility'});s.conversations.digest({conversation:conversation.id,run:'fictitious-visibility',summary:'A fictitious visibility summary.',items:[{kind:'decision',text:'Fictitious decision.'}]});});
  context=await browser.newContext({viewport:{width:1600,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===app.url||['data:','blob:','about:'].includes(url.protocol)?route.continue():route.abort('blockedbyclient');});
  await context.routeWebSocket(url=>new URL(url).origin!==app.url.replace(/^http/,'ws'),route=>route.close({code:1008,reason:'Example home only'}));
  const isolationPage=await context.newPage();let isolation;try{isolation=await verifyIsolation(isolationPage);}finally{await isolationPage.close();}
  const memberPage=await context.newPage();maskCredentialScreenshots(memberPage);memberPage.setDefaultTimeout(4000);
  const link=await requestLocalLink(home,{request:'link',member:'robin',label:'Fictitious visibility browser'});if(new URL(link.url).origin!==app.url)throw Error('Local sign-in origin differed');
  secretPath=link.path;await memberPage.goto(new URL(link.path,link.url).href);await memberPage.getByRole('button',{name:'Sign in',exact:true}).click();await memberPage.locator('.next-shell').waitFor();
  const query='{ conversations(limit:1000){id agent project member} commsThreads {id conversation agent project member} turns(limit:1000){conversation seq} digests(limit:1000){id conversation} digestItems(limit:1000){digest} inboxItems(state:"waiting",limit:100){id toKind to state volume} '+items.map((id,i)=>'i'+i+':inboxItem(id:'+JSON.stringify(id)+'){id toKind to agent project member}').join(' ')+' }';
  const inspect=async(who,reading)=>{
   const member={...s.household.members().find(row=>row.id===who),projects:s.projects.read().projects.filter(row=>row.members.includes(who)).map(row=>row.id)};
   const conversations=db.prepare('SELECT id,agent,project,member FROM conversations').all(),visible=conversations.filter(row=>visibleTo(member,row));
   check(same(ids(reading.conversations),ids(visible)),who+' received different conversation IDs from the page scope');
   check(reading.conversations.every(row=>same(row,conversations.find(expected=>expected.id===row.id))),who+' received different conversation labels','conversationLabels');
   const threads=db.prepare('SELECT id,conversation,agent,project,member FROM threads').all();check(same(ids(reading.commsThreads),ids(threads.filter(row=>visibleTo(member,row)))),who+' received a hidden or missing private Comms thread','commsPrivacy');
   const allowed=new Set(visible.map(row=>row.id));const pairs=rows=>rows.map(row=>row.conversation+':'+row.seq).sort();check(same(pairs(reading.turns),pairs(db.prepare('SELECT conversation,seq FROM turns').all().filter(row=>allowed.has(row.conversation)))),who+' received hidden or missing turns');const digests=db.prepare('SELECT id,conversation FROM digests').all().filter(row=>allowed.has(row.conversation));check(same(ids(reading.digests),ids(digests)),who+' received hidden or missing digests');check(reading.turns.every(row=>allowed.has(row.conversation))&&reading.digests.every(row=>allowed.has(row.conversation)),who+' received hidden history');
   const digestIDs=new Set(reading.digests.map(row=>row.id));const childIDs=rows=>rows.map(row=>row.digest).sort();check(same(childIDs(reading.digestItems),childIDs(db.prepare('SELECT digest FROM digest_items').all().filter(row=>digestIDs.has(row.digest)))),who+' received hidden or missing digest children');check(reading.digestItems.every(row=>digestIDs.has(row.digest)),who+' received a hidden digest child');
   for(let i=0;i<items.length;i++){const stored=s.conversations.item(items[i]),actual=reading['i'+i];check(!!actual===visibleTo(member,stored),who+' received a hidden or missing Inbox item','inboxVisibility');if(actual)check(same(actual,Object.fromEntries(['id','toKind','to','agent','project','member'].map(key=>[key,stored[key]]))),who+' received incorrect Inbox labels','inboxVisibility');}
   const people=new Set(s.household.members().map(row=>row.id)),agents=new Set(db.prepare('SELECT id FROM agents').all().map(row=>row.id));check(db.prepare('SELECT to_kind AS kind,\"to\" AS recipient FROM inbox').all().every(row=>row.kind==='person'?people.has(row.recipient):row.kind==='agent'&&agents.has(row.recipient)),'An Inbox item had no single registered recipient','inboxRecipients');
   check(reading.inboxItems.every(row=>row.toKind==='person'&&row.to===who&&row.state==='waiting'&&row.volume!=='mute'),who+' personal Inbox contained another recipient or a nonwaiting item','inboxRecipients');
   const sourceAllowed=row=>{try{if(row.waitsOnKind==='approval')return visibleTo(member,s.approvals.get(row.waitsOnId));if(row.waitsOnKind==='task'){const task=s.tasks.get(row.waitsOnId);return member.role==='owner'||(task.project?member.projects.includes(task.project):task.ownerKind==='member'?task.owner===who:task.ownerKind==='agent'&&member.agents.includes(task.owner));}return row.waitsOnKind==null&&row.waitsOnId==null;}catch{return false;}};
   const expectedItems=db.prepare('SELECT id,to_kind AS toKind,"to",project,agent,member,state,volume,waits_on_kind AS waitsOnKind,waits_on_id AS waitsOnId FROM inbox').all().filter(row=>row.toKind==='person'&&row.to===who&&row.state==='waiting'&&row.volume!=='mute'&&visibleTo(member,row)&&sourceAllowed(row));if(expectedItems.length>100)throw Error('Mailbox exceeds the measured page');check(same(ids(reading.inboxItems),ids(expectedItems)),who+' personal Inbox omitted waiting items','inboxRecipients');
   return{conversations:reading.conversations.length,threads:reading.commsThreads.length,mailbox:reading.inboxItems.length};
  };
  const first={owner:await inspect('alex',await browserRead(page,query)),member:await inspect('robin',await browserRead(memberPage,query))};
  write(()=>{s.household.setMember({id:robin.id,role:robin.role,fullOwner:robin.fullOwner,agents:[]});s.projects.save({...garden,members:garden.members.filter(id=>id!=='robin')});});
  const revoked=await inspect('robin',await browserRead(memberPage,query));
  await memberPage.screenshot({path:join(out,screenshot),fullPage:true});
  const facts={ok:true,screenshot,reason:'Normal owner/member browser sign-ins saw exact labelled conversation and Comms IDs, scoped history and Inbox items, and only their own waiting mailbox; retained member sign-in lost revoked project and agent access.',first,revoked,isolation};
  outcome=Object.fromEntries(visibilityDomains.map(domain=>[domain,{...facts}]));return outcome;
 }catch(error){outcome=visibilityFailure(error);await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});for(const value of Object.values(outcome))value.screenshot=screenshot;return outcome;}
 finally{
  let restored=false,closed=false;
  try{restored=await restoreAndClose(()=>{write(()=>{s.household.setMember({id:robin.id,role:robin.role,fullOwner:robin.fullOwner,agents:robin.agents});s.projects.save(garden);});const current=s.household.members().find(row=>row.id===robin.id);return same(current,robin)&&same(s.projects.read().projects.find(row=>row.id===garden.id),garden);},async()=>{await context?.close();closed=browser.contexts().length===contextsBefore;});}
  catch{for(const value of Object.values(outcome??{})){delete value.ok;value.inconclusive=true;value.reason='Visibility fixture cleanup failed.';}}
  for(const value of Object.values(outcome??{})){value.cleanup={restored,contextClosed:closed,credentialAbsent:!secretPath||!JSON.stringify(outcome).includes(secretPath)};if(!restored||!closed||!value.cleanup.credentialAbsent){delete value.ok;value.inconclusive=true;value.reason='Visibility fixture cleanup could not be verified.';}}
 }
}
