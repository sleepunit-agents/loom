/** Behavioral observations on the one real built-program Tempo visit. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function tempoWalkthrough({page,tile,url,clock,example,checks,capture}) {
 const query=async(query,variables={})=>{
  const response=await page.request.post(url+'/graphql',{headers:{origin:url},data:{query,variables},maxRedirects:0});
  assert.equal(response.status(),200);const result=await response.json();assert.equal(result.errors,undefined);return result.data;
 };
 const trigger=async id=>{
  const result=await query('query Trigger($id:String!){triggers(where:{id:{eq:$id}},limit:1){id state enabled lastFiredAt} triggerLog(where:{trigger:{eq:$id}},limit:100){event}}',{id});
  assert.equal(result.triggers.length,1);return {row:result.triggers[0],events:result.triggerLog.map(row=>row.event)};
 };
 const inbox=async()=> (await query('{inboxItems(limit:100){id toKind to source sourceId state volume body{words}}}')).inboxItems;
 const notice=async()=> (await query('{settledInboxNotice{id count}}')).settledInboxNotice;
 const observe=async(name,work)=>{
  try{const facts=await work(),evidence=await capture(name);checks[name]={ok:true,facts,evidence};}
  catch(error){checks[name]={ok:false,error:String(error)};throw error;}
 };
 await observe('held',async()=>{
  await tile.getByRole('button',{name:'Pause agent',exact:true}).click();
  await tile.getByRole('button',{name:'Resume agent',exact:true}).waitFor();
  const response=await page.request.post(url+'/api/approvals/answer',{headers:{origin:url},data:{id:randomUUID(),input:{id:example.approval,answer:'allow'}},maxRedirects:0});
  assert.equal(response.status(),200);assert.equal((await response.json()).ok,true);
  const current=await trigger(example.trigger);assert.equal(current.row.state,'held');assert.equal(current.row.lastFiredAt,null);assert.equal(current.events.filter(event=>event==='fired').length,0);
  return {state:current.row.state,firedEvents:0,source:'An actual owner answer arrived while the agent was paused.'};
 });
 await observe('resumed',async()=>{
  await tile.getByRole('button',{name:'Resume agent',exact:true}).click();
  await tile.getByText(/answer · once · fired/).waitFor();
  const current=await trigger(example.trigger);assert.equal(current.row.state,'fired');assert.equal(current.events.filter(event=>event==='fired').length,1);
  return {state:current.row.state,firedEvents:1};
 });
 const create=async(label,words)=>{
  const back=tile.getByRole('region',{name:'Tempo: the open item',exact:true}).getByRole('button',{name:'Tempo',exact:true});if(await back.isVisible())await back.click();
  await tile.getByRole('button',{name:'Create trigger',exact:true}).click();const form=tile.getByRole('form',{name:'Create trigger'});
  await form.getByLabel('Label',{exact:true}).fill(label);await form.getByLabel(/^Time \(/).fill(new Date(clock.now()+60_000).toISOString());
  await form.getByLabel('Set by',{exact:true}).selectOption('household');await form.getByLabel('Recipient kind',{exact:true}).selectOption('person');
  await form.getByLabel('Recipient',{exact:true}).fill(example.members[0]);await form.getByLabel('Words',{exact:true}).fill(words);
  await form.getByRole('button',{name:'Create trigger',exact:true}).click();await form.waitFor({state:'hidden'});
  await tile.getByRole('button',{name:new RegExp(label)}).click();
  const result=await query('query Created($note:String!){triggers(where:{note:{eq:$note}},limit:2){id state enabled}}',{note:label});assert.equal(result.triggers.length,1);return result.triggers[0].id;
 };
 await observe('settled',async()=>{
  const words='Walkthrough one-off notice',id=await create('Walkthrough Run now',words);
  assert.equal((await inbox()).filter(item=>item.sourceId===id).length,0);assert.equal(await notice(),null);
  await tile.getByRole('button',{name:'Run now',exact:true}).click();await tile.getByText(/time · once · fired/).waitFor();
  const items=await inbox(),delivered=items.filter(item=>item.sourceId===id);
  assert.equal(delivered.length,1);assert.equal(delivered[0].source,'trigger');assert.equal(delivered[0].toKind,'person');assert.equal(delivered[0].to,example.members[0]);assert.equal(delivered[0].body.words,words);
  clock.advance(4999);assert.equal(await notice(),null);
  clock.advance(1);const settled=await notice(),waiting=items.filter(item=>item.state==='waiting'&&item.volume==='full').length;
  assert.equal(settled.count,waiting);assert.ok(waiting>0);
  const notification=page.getByRole('status',{name:'Inbox notification'});await notification.waitFor();assert.ok((await notification.innerText()).includes(`${waiting} items are waiting in your Inbox`));
  return {delivered:1,source:'trigger',recipient:example.members[0],noticeBeforeDeadline:null,settleMilliseconds:5000,notifiedItems:waiting};
 });
 await observe('cancelled',async()=>{
  const id=await create('Walkthrough cancel future work','This cancelled notice must not arrive');
  await tile.getByRole('button',{name:'Cancel',exact:true}).click();await tile.getByText(/time · once · stopped/).waitFor();
  clock.advance(60_000);const current=await trigger(id);assert.equal(current.row.state,'stopped');assert.equal(current.row.enabled,false);assert.equal(current.row.lastFiredAt,null);
  assert.equal((await inbox()).filter(item=>item.sourceId===id).length,0);
  return {state:current.row.state,afterDeadline:true,delivered:0};
 });
}
