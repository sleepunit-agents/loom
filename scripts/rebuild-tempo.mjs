/** Behavioral observations on the one real built-program Tempo visit. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function tempoWalkthrough({page,tile,url,clock,example,checks,capture}) {
 const query=async(query,variables={})=>{
  const response=await page.request.post(url+'/graphql',{headers:{origin:url},data:{query,variables},maxRedirects:0});
  assert.equal(response.status(),200);const result=await response.json();assert.equal(result.errors,undefined);return result.data;
 };
 const trigger=async id=>{
  const result=await query('query Trigger($id:String!){triggers(where:{id:{eq:$id}},limit:1){id state enabled lastFiredAt sourceKind watches lifespan} triggerLog(where:{trigger:{eq:$id}},limit:100){event}}',{id});
  assert.equal(result.triggers.length,1);return {row:result.triggers[0],events:result.triggerLog.map(row=>row.event)};
 };
 const inbox=async()=> (await query('{inboxItems(limit:100){id toKind to source sourceId refs state volume body{words}}}')).inboxItems;
 const notice=async()=> (await query('{settledInboxNotice{id count needs fyi}}')).settledInboxNotice;
 const observe=async(name,work)=>{
  try{const facts=await work(),screenshot=await capture(name);checks[name]={ok:true,facts,screenshot};}
  catch(error){const failed={ok:false,error:String(error)};try{failed.screenshot=await capture(name+'-failed');}catch{}checks[name]=failed;throw error;}
 };
 await observe('held',async()=>{
  await tile.getByRole('button',{name:'Pause agent',exact:true}).click();
  await tile.getByRole('button',{name:'Resume agent',exact:true}).waitFor();
  const response=await page.request.post(url+'/api/approvals/answer',{headers:{origin:url},data:{id:randomUUID(),input:{id:example.approval,answer:'allow'}},maxRedirects:0});
  assert.equal(response.status(),200);assert.equal((await response.json()).ok,true);
  const current=await trigger(example.trigger);assert.equal(current.row.state,'held');assert.equal(current.row.lastFiredAt,null);assert.equal(current.events.filter(event=>event==='observed').length,1);assert.equal(current.events.filter(event=>event==='fired').length,0);
  return {state:current.row.state,observedAnswers:1,firedEvents:0,source:'An actual owner answer arrived while the agent was paused.'};
 });
 await observe('resumed',async()=>{
  await tile.getByRole('button',{name:'Resume agent',exact:true}).click();
  await tile.getByText(/answer · once · fired/).waitFor();
  const current=await trigger(example.trigger);assert.equal(current.row.state,'fired');assert.equal(current.events.filter(event=>event==='fired').length,1);
  assert.equal(current.row.sourceKind,'answer');assert.equal(current.row.watches,'approval:'+example.approval);assert.equal(current.row.lifespan,'once');assert.equal(current.row.enabled,false);
  return {state:current.row.state,firedEvents:1,sourceKind:current.row.sourceKind,watches:current.row.watches,lifespan:current.row.lifespan,enabled:current.row.enabled};
 });
 const create=async(label,words)=>{
  const back=tile.getByRole('region',{name:'Tempo: the open item',exact:true}).getByRole('button',{name:'Tempo',exact:true});if(await back.isVisible())await back.click();
  await tile.getByRole('button',{name:'Create trigger',exact:true}).click();const form=tile.getByRole('form',{name:'Create trigger'});
  await form.getByLabel('Label',{exact:true}).fill(label);await form.getByLabel(/^Time \(/).fill(new Date(clock.now()+60_000).toISOString());
  await form.getByLabel('Set by',{exact:true}).selectOption('member');await form.getByLabel('Person',{exact:true}).fill(example.members[0]);await form.getByLabel('Recipient kind',{exact:true}).selectOption('person');
  await form.getByLabel('Recipient',{exact:true}).fill(example.members[0]);await form.getByLabel('Words',{exact:true}).fill(words);
  await form.getByRole('button',{name:'Create trigger',exact:true}).click();await form.waitFor({state:'hidden'});
  await tile.getByRole('button',{name:new RegExp(label)}).click();
  const result=await query('query Created($note:String!){triggers(where:{note:{eq:$note}},limit:2){id state enabled}}',{note:label});assert.equal(result.triggers.length,1);return result.triggers[0].id;
 };
 let runNowId;
 await observe('settled',async()=>{
  const previousNotice=(await notice())?.id??null;
  const words='Walkthrough one-off notice',id=await create('Walkthrough Run now',words);
  runNowId=id;
  assert.equal((await inbox()).filter(item=>item.refs.includes(id)).length,0);assert.equal((await notice())?.id??null,previousNotice);
  clock.advance(2000);
  await tile.getByRole('button',{name:'Run now',exact:true}).click();await tile.getByText(/time · once · fired/).waitFor();
  const items=await inbox(),delivered=items.filter(item=>item.refs.includes(id));
  assert.equal(delivered.length,1);assert.equal(delivered[0].source,'trigger');assert.ok(delivered[0].sourceId.startsWith(id+':'));assert.equal(delivered[0].toKind,'person');assert.equal(delivered[0].to,example.members[0]);assert.equal(delivered[0].body.words,words);
  clock.advance(4999);assert.equal((await notice())?.id??null,previousNotice);
  clock.advance(1);const settled=await notice();assert.notEqual(settled?.id,previousNotice);const waiting=items.filter(item=>item.state==='waiting'&&item.volume==='full').length;
  assert.equal(settled.count,waiting);assert.ok(waiting>0);
  const notification=page.getByRole('status',{name:'Inbox notification'});await notification.waitFor();const label=await notification.innerText();if(settled.fyi)assert.ok(label.includes(`${settled.fyi} FYI`));if(settled.needs)assert.ok(label.includes('your response'));
  return {delivered:1,source:'trigger',recipient:example.members[0],noticeBeforeDeadline:previousNotice,settleMilliseconds:5000,notifiedItems:waiting};
 });
 await observe('cancelled',async()=>{
  const id=await create('Walkthrough cancel future work','This cancelled notice must not arrive');
  await tile.getByRole('button',{name:'Cancel',exact:true}).click();await tile.getByText(/time · once · stopped/).waitFor();
  clock.advance(60_001);const current=await trigger(id);assert.equal(current.row.state,'stopped');assert.equal(current.row.enabled,false);assert.equal(current.row.lastFiredAt,null);
  const delivered=await inbox();assert.equal(delivered.filter(item=>item.refs.includes(id)).length,0);
  assert.equal(delivered.filter(item=>item.refs.includes(runNowId)).length,1);
  const once=await trigger(example.trigger);assert.equal(once.row.enabled,false);assert.equal(once.events.filter(event=>event==='fired').length,1);checks.resumed.facts.stillOnceAfterLaterDeadline=true;
  return {state:current.row.state,afterDeadline:true,delivered:0};
 });
}
