/** Actions in the same real browser/program as the launcher walkthrough.
 * Reads inspect only its disposable example store; writes use visible controls. */
import {join} from 'node:path';
import {commsDeliveryEvidence} from '../dist/rebuild/comms-delivery-evidence.js';
export async function conversationActions({page,app,example,out,open,actions=['commsSend','inboxAnswer','commsAnswer'],previous={}}){
 const select=async tile=>{
  const heading=tile.getByRole('heading',{name:'Repair the garden pump',exact:true});
  const row=tile.locator('[data-split-row]:visible').filter({hasText:'Repair the garden pump'}).first();
  const back=tile.getByRole('button',{name:/Back to conversations/});
  await heading.or(row).or(back).first().waitFor({state:'visible'});
  if(await heading.isVisible())return;
  if(await back.isVisible())await back.click();
  await row.click();await heading.waitFor({state:'visible'});
 };
 const visibleComms=async()=>{
  const tile=page.getByRole('region',{name:'Comms tile',exact:true});
  return await tile.isVisible()?tile:open('Comms');
 };
 let phase='';
 const evidence={...previous},question='Spend up to 180 example dollars on the pump?';
 const attempt=async(name,run)=>{const start=performance.now();try{phase=name;evidence[name]={...await run(),durationMs:Math.round(performance.now()-start)};}catch(error){const screenshot='action-'+name+'-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});const panes=await page.locator('[aria-label="Comms tile"]').evaluateAll(tiles=>tiles.map(tile=>({hidden:tile.hidden,inert:tile.inert,headings:[...tile.querySelectorAll('h2')].map(h=>h.textContent),text:tile.innerText.slice(0,160)}))).catch(()=>[]);evidence[name]={ok:false,phase,error:String(error),screenshot,panes,durationMs:Math.round(performance.now()-start)};}};
 const response=path=>{const pending=page.waitForResponse(value=>new URL(value.url()).pathname===path&&value.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});return pending;};
 const result=async pending=>{const value=await pending,body=await value.json();if(value.status()!==200||body.ok!==true)throw Error('Browser action was not accepted');return {body:body.value,input:value.request().postDataJSON().input};};
 if(actions.includes('commsSend'))await attempt('commsSend',async()=>{
  phase='open-comms';let tile=await open('Comms');phase='select-conversation';await select(tile);
  const words='Fictitious walkthrough follow-up: compare the hose again.';
  phase='fill-message';await tile.getByRole('textbox',{name:'Message fern',exact:true}).fill(words);
  phase='send-message';const pending=response('/api/comms/send');await tile.getByRole('button',{name:'Send',exact:true}).click();const sent=await result(pending);
  phase='sent-message-visible';await tile.getByText(words,{exact:true}).waitFor();
  phase='reload';await page.reload();await page.locator('.next-shell').waitFor();phase='reopen-after-reload';tile=await visibleComms();phase='select-after-reload';await select(tile);phase='persisted-message-visible';await tile.getByText(words,{exact:true}).waitFor();
  const {ok,count:inboxCopies}=commsDeliveryEvidence(app.services.comms.db.$client,{thread:example.thread,conversation:example.conversation,agent:'fern'},sent.body);
  const screenshot='action-comms-send.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return{ok,persistedAfterReload:true,inboxCopies,screenshot};
 });
 if(actions.includes('inboxAnswer'))await attempt('inboxAnswer',async()=>{
  const tile=await open('Inbox');await tile.getByText(question,{exact:true}).first().click();
  const pending=response('/api/inbox/answer');await tile.getByRole('button',{name:'Yes',exact:true}).click({timeout:4000});const answered=await result(pending);
  const db=app.services.comms.db.$client,q=db.prepare('SELECT state,answer,answered_by,conversation FROM inbox WHERE id=?').get(answered.input.item);
  const replies=db.prepare('SELECT conversation,to_kind,"to",source FROM inbox WHERE source=\'answer\' AND source_id=?').all(answered.input.item);
  const ok=q?.state==='answered'&&q.answer==='yes'&&q.answered_by==='alex'&&q.conversation===example.conversation&&replies.length===1&&replies[0].conversation===example.conversation&&replies[0].to_kind==='agent'&&replies[0].to==='fern';
  const screenshot='action-inbox-answer.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  return{ok,verdict:q?.answer,answeredBy:q?.answered_by,agentAnswerCopies:replies.length,screenshot};
 });
 if(actions.includes('commsAnswer'))await attempt('commsAnswer',async()=>{
  if(!evidence.inboxAnswer?.ok)throw Error('Inbox answer did not complete');
  const tile=await visibleComms();await select(tile);
  const card=tile.getByRole('article',{name:'Inbox item',exact:true}).filter({has:page.getByRole('heading',{name:question,exact:true})});
  const answer=card.getByRole('heading',{name:'Answer',exact:true});
  await answer.waitFor({timeout:4000});await answer.scrollIntoViewIfNeeded();
  const ok=await card.getByRole('button',{name:'Allow',exact:true}).count()===0&&await card.getByRole('button',{name:'Deny',exact:true}).count()===0;
  const screenshot='action-comms-answer.png';await page.screenshot({path:join(out,screenshot),fullPage:true});return{ok,screenshot};
 });
 return evidence;
}
