/** Real normal-home HTTP and receiving SDK; current-job fixtures launch no provider. */
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {boxes,jobs,tokens,conversations,inbox,operationResults,turns,digests} from '../dist/core/data/schema.js';
import {bodyConversationClient} from '../dist/runtime/conversation-client.js';
import {redactSignin} from './rebuild-conversation-visibility.mjs';
class ObservedMailFailure extends Error {}
const check=(yes,message)=>{if(!yes)throw new ObservedMailFailure(message);};
export async function conversationMail({page,app,clock,example,out,open}){
 const pending=()=>({inconclusive:true,reason:'The real conversation-mail observation did not complete.'});
 const evidence={privateConversationBatch:pending(),nativeHandoff:pending(),conversationInboxIngress:pending(),privateConversationQuestion:pending()};
 const db=app.services.comms.db,write=fn=>app.writes.run(fn).value,current=[],clients=[];let stage='privateConversationBatch';
 const now=()=>new Date(clock.now()).toISOString();
 const owner=async(name,input)=>{
  const result=await page.evaluate(async({name,input,id})=>{const response=await fetch('/api/'+name.replace('.','/'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,id})});return {status:response.status,body:await response.json()};},{name,input,id:randomUUID()});
  check(result.status===200&&result.body.ok===true,'Signed-in '+name+' was refused');return result.body.value;
 };
 const body=async cv=>{
  check(!cv.job,'The new fixture conversation already has a job');const box=db.select({id:boxes.id}).from(boxes).get();check(!!box,'The normal example has no configured worker box');
  const id='walkthrough-'+randomUUID(),token='body_'+randomBytes(32).toString('hex');
  write(()=>{
   db.insert(jobs).values({id,agent:cv.agent,box:box.id,member:cv.member,project:cv.project,conversation:cv.id,title:'Fictitious conversation-mail body',state:'running',brief:'',model:'fixture-no-provider',startedByKind:'member',startedBy:'alex',houseRepository:'fictional',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
   db.update(conversations).set({job:id}).where(eq(conversations.id,cv.id)).run();
   db.insert(tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Fictitious body '+id,kind:'agent',agent:cv.agent,job:id,createdAt:now()}).run();
  });current.push(id);
  const client=bodyConversationClient({url:app.url,token,job:id,conversation:cv.id,signal:new AbortController().signal,clock});clients.push(client);
  const call=async(name,input)=>{const response=await fetch(app.url+'/api/'+name.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id:randomUUID()})});const result=await response.json();check(response.status===200&&result.ok===true,'Current body '+name+' was refused');return result.value;};
  return {id,client,call};
 };
 try{
  const opened=await owner('comms.open',{thread:'th:walkthrough-mail-'+randomUUID(),agent:'fern'}),parentCv=app.services.conversations.conversation(opened.conversation),parent=await body(parentCv);
  check(parentCv.member==='alex'&&parentCv.project===null,'The actual Comms conversation is not the intended private projectless context');
  const commsWords='Fictitious private Comms batch message';await owner('comms.send',{thread:opened.thread,clientId:randomUUID(),words:commsWords});
  const actor={kind:'agent',id:'fern'},task=write(()=>{
   const t=app.services.tasks.create({title:'Fictitious private batch task',goal:'Exercise real source-owned delivery.',why:'A project task can be discussed privately.',owner:actor,project:'garden',source:{kind:'conversation',id:parentCv.id}},actor);
   app.services.tasks.ask(t.id,{to:{kind:'member',id:'alex'},ask:'Inspect the fictitious batch task?',ifYes:'Fern inspects it.',ifNo:'Fern waits.',answers:'yes-no'},actor);return t;
  });
  const tq=db.$client.prepare("SELECT id FROM inbox WHERE source='task' AND waits_on_id=? AND state='waiting'").get(task.id);
  check(!!tq,'The real task producer did not create a question');await owner('tasks.command',{action:'answer',id:task.id,question:tq.id,answer:'yes'});
  const approval=write(()=>app.services.approvals.request({kind:'command',target:'fictional:private-batch',what:'Fictitious private batch permission',why:'Exercise real approval reply delivery.',agent:'fern',askedFrom:parentCv.id,actingFor:'alex',conversation:parentCv.id,project:'garden',member:'alex',ask:'Allow the fictitious batch inspection?',ifYes:'Fern inspects it.',ifNo:'Fern waits.'}));
  await owner('approvals.answer',{id:approval.id,answer:'allow'});
  const batch=[];await parent.client.takeAndAccept(async item=>{batch.push({id:item.id,source:item.source,seq:item.seq});if(item.source==='thread')check(item.words===commsWords,'The Comms words did not reach their current private body');else check(item.words?.includes('fictitious'),'The work-source answer words were unavailable');});
  check(batch.length===3&&batch.map(i=>i.source).join(',')==='thread,answer,answer'&&batch.every((i,n)=>n===0||i.seq>batch[n-1].seq),'Private body did not take Comms/task/approval inputs once in sequence');
  check(batch.every(i=>{const row=db.select().from(inbox).where(eq(inbox.id,i.id)).get();return row.state==='done'&&row.member===parentCv.member&&row.project===parentCv.project&&row.agent===parentCv.agent;}),'A source reply did not keep the private conversation labels or acceptance');
  evidence.privateConversationBatch={ok:true,reason:'A current private body accepted and confirmed its real Comms, task-answer and approval-answer batch in sequence with canonical private labels.',sources:batch.map(i=>i.source),currentJobFixtures:true,providerStarted:false};
  stage='nativeHandoff';
  const brief='Compare the fictitious replacement pumps',handoff=await parent.call('conversation.handoff',{agent:'moss',clientId:'walkthrough-delegation',label:'Fictitious pump comparison',words:brief}),childCv=app.services.conversations.conversation(handoff.conversation);
  check(childCv.venue==='handoff'&&childCv.place===parent.id&&childCv.agent==='moss'&&childCv.member===parentCv.member&&childCv.project===parentCv.project,'Native handoff did not derive its exact parent place and labels');
  const child=await body(childCv);let handoffTaken=0;await child.client.takeAndAccept(async item=>{check(item.id===handoff.item&&item.source==='handoff'&&item.words===brief,'The receiving body did not get the actual native handoff brief');handoffTaken++;});check(handoffTaken===1,'The native handoff did not arrive once');
  const stored=db.select().from(inbox).where(eq(inbox.id,handoff.item)).get();check(stored.state==='done'&&stored.words&&!stored.words.includes(brief),'Native handoff was not encrypted and confirmed in the one Inbox');
  evidence.nativeHandoff={ok:true,reason:'The native handoff command created a parent-job conversation and its exact encrypted brief reached the receiving SDK once.',conversation:childCv.id,item:handoff.item,parent:parent.id,currentJobFixtures:true,providerStarted:false};
  stage='conversationInboxIngress';
  const wakeWords='Inspect the fictitious source-driven garden path',trigger=await owner('tempo.set',{ownerKind:'household',sourceKind:'time',times:now(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'moss',instructions:wakeWords,note:'Fictitious conversation-mail wake'});clock.advance(0);
  const wake=db.$client.prepare("SELECT inbox.* FROM inbox JOIN inbox_refs ON inbox_refs.item=inbox.id WHERE source='trigger' AND inbox_refs.ref=?").get(trigger.id);check(!!wake?.conversation,'The real time trigger did not name its conversation');
  const wakeBody=await body(app.services.conversations.conversation(wake.conversation));let wakeTaken=0;await wakeBody.client.takeAndAccept(async item=>{check(item.id===wake.id&&item.source==='trigger'&&item.words===wakeWords,'The real wake did not use the same receiving Inbox client');wakeTaken++;});check(wakeTaken===1,'The real wake did not arrive once');
  evidence.conversationInboxIngress={ok:true,reason:'Actual Comms, time-trigger and native-handoff producers each delivered through the same current-body Inbox SDK.',sources:['thread','trigger','handoff'],currentJobFixtures:true,providerStarted:false};
  stage='privateConversationQuestion';
  const question={to:'alex',answers:'yes-no',words:'May Moss inspect the fictitious delegated pump?',why:'The delegated comparison needs its owner.',ifYes:'Moss inspects the fictitious pump.',ifNo:'Moss leaves the fictitious pump alone.'};
  const digest=await child.call('conversation.digest',{summary:'Fictitious delegated work awaits a decision',question});
  const item=db.select().from(inbox).where(eq(inbox.id,digest.item)).get();check(item?.state==='waiting'&&item.to==='alex'&&item.conversation===childCv.id&&item.thread===null&&item.words&&!item.words.includes(question.words),'Private background digest did not create one encrypted owner question');
  const tile=await open('Inbox'),back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();await tile.getByRole('textbox',{name:'Search asks',exact:true}).fill('');await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();
  await tile.locator('[data-split-row]:visible').filter({hasText:question.words}).click();await tile.getByRole('heading',{name:question.words,exact:true}).waitFor();for(const words of [question.why,question.ifYes,question.ifNo])await tile.getByText(words,{exact:true}).waitFor();
  const yes=tile.getByRole('button',{name:'Yes',exact:true});await yes.focus();await yes.press('Enter');await tile.getByRole('heading',{name:'Answer',exact:true}).waitFor();
  const answered=db.select().from(inbox).where(eq(inbox.id,item.id)).get();check(answered.state==='answered'&&answered.answer==='yes'&&answered.answeredBy==='alex'&&!!answered.answeredAt,'Inbox did not record its real recipient decision and time');
  let answerTaken=0;await child.client.takeAndAccept(async reply=>{check(reply.source==='answer'&&reply.sourceId===item.id&&reply.words==='yes'&&reply.verdict==='yes'&&reply.question?.words===question.words&&reply.question?.ifYes===question.ifYes,'The private receiving body did not learn its recorded answer and retained question');answerTaken++;});check(answerTaken===1,'The owner answer did not return once');
  for(const table of [inbox,jobs,operationResults,turns,digests]){const rows=JSON.stringify(db.select().from(table).all());for(const words of [brief,commsWords,question.words,question.why,question.ifYes,question.ifNo])check(!rows.includes(words),'Private conversation words were copied into generic storage');}
  const screenshot='action-privateConversationQuestion.png';await page.screenshot({path:join(out,screenshot),fullPage:true});evidence.privateConversationQuestion={ok:true,reason:'A private native handoff digest raised an encrypted question, Inbox displayed its outcomes and recorded Alex yes/time, and the actual receiving SDK accepted the matching answer with retained question context.',item:item.id,screenshot,currentJobFixtures:true,providerStarted:false};
 }catch(error){evidence[stage]=error instanceof ObservedMailFailure?{ok:false,error:redactSignin(error)}:{inconclusive:true,reason:'The conversation-mail observation could not complete.',error:redactSignin(error)};}
 finally{for(const client of clients)client.close();for(const id of current.reverse())try{write(()=>app.services.runtime.stop(id,'alex','reset'));}catch{for(const value of Object.values(evidence)){if(value.ok){delete value.ok;value.inconclusive=true;value.reason='Fixture body cleanup could not be verified.';}}}}
 return evidence;
}
