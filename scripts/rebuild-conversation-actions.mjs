/** Actions in the same real browser/program as the launcher walkthrough.
 * Reads inspect only its disposable example store; writes use visible controls. */
import {join} from 'node:path';
import {commsDeliveryEvidence} from '../dist/rebuild/comms-delivery-evidence.js';
export async function conversationActions({page,app,example,out,open}){
 const activate=async button=>{await button.waitFor({state:'visible'});await button.focus();await button.press('Enter');};
 const select=async tile=>{const heading=tile.getByRole('heading',{name:'Repair the garden pump',exact:true}),row=tile.locator('[data-split-row]:visible').filter({hasText:'Repair the garden pump'});await heading.or(row).first().waitFor({state:'visible'});if(!await heading.isVisible())await activate(row);};
 let phase='';
 let sentWords,validSend=false;
 const evidence={},question='Spend up to 180 example dollars on the pump?';
 const attempt=async(name,run)=>{const started=performance.now();try{phase=name;evidence[name]=await run();}catch(error){const screenshot='action-'+name+'-failed.png';await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});const panes=await page.locator('[aria-label="Comms tile"]').evaluateAll(tiles=>tiles.map(tile=>({hidden:tile.hidden,inert:tile.inert,headings:[...tile.querySelectorAll('h2')].map(h=>h.textContent),text:tile.innerText.slice(0,160)}))).catch(()=>[]);evidence[name]={ok:false,phase,error:String(error),screenshot,panes};}finally{evidence[name].durationMs=Math.round(performance.now()-started);}};
 const response=path=>{const pending=page.waitForResponse(value=>new URL(value.url()).pathname===path&&value.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});return pending;};
 const result=async pending=>{const value=await pending,body=await value.json();if(value.status()!==200||body.ok!==true)throw Error('Browser action was not accepted');return {body:body.value,input:value.request().postDataJSON().input};};
 await attempt('commsSend',async()=>{
  const approvalCountBefore=app.services.approvals.list().length;
  phase='open-comms';let tile=await open('Comms');phase='select-conversation';await select(tile);
  const words='Fictitious walkthrough follow-up: compare the hose again.';
  phase='fill-message';await tile.getByRole('textbox',{name:'Message fern',exact:true}).fill(words);
  phase='send-message';const pending=response('/api/comms/send');await activate(tile.getByRole('button',{name:'Send',exact:true}));const sent=await result(pending);
  phase='sent-message-visible';await tile.getByText(words,{exact:true}).waitFor();
  const {ok,count:inboxCopies}=commsDeliveryEvidence(app.services.comms.db.$client,{thread:example.thread,conversation:example.conversation,agent:'fern'},sent.body);
  const screenshot='action-comms-send.png';await tile.screenshot({path:join(out,screenshot)});
  const approvalCountAfter=app.services.approvals.list().length;sentWords=words;validSend=ok&&approvalCountBefore===approvalCountAfter;return{ok:false,persistedAfterReload:false,inboxCopies,approvalCountBefore,approvalCountAfter,screenshot,error:'Reload persistence has not been observed yet.'};
 });
 await attempt('inboxAnswer',async()=>{
  const tile=await open('Inbox');await activate(tile.getByRole('button',{name:'Go to Inbox',exact:true}));await activate(tile.locator('.loom-split__rows [data-split-row]').filter({has:page.getByText(question,{exact:true})}));
  const pending=response('/api/inbox/answer');await activate(tile.getByRole('button',{name:'Yes',exact:true}));const answered=await result(pending);
  const db=app.services.comms.db.$client,q=db.prepare('SELECT state,answer,answered_by,conversation FROM inbox WHERE id=?').get(answered.input.item);
  const replies=db.prepare('SELECT conversation,to_kind,"to",source FROM inbox WHERE source=\'answer\' AND source_id=?').all(answered.input.item);
  const ok=q?.state==='answered'&&q.answer==='yes'&&q.answered_by==='alex'&&q.conversation===example.conversation&&replies.length===1&&replies[0].conversation===example.conversation&&replies[0].to_kind==='agent'&&replies[0].to==='fern';
  const screenshot='action-inbox-answer.png';await tile.screenshot({path:join(out,screenshot)});
  return{ok,verdict:q?.answer,answeredBy:q?.answered_by,agentAnswerCopies:replies.length,screenshot};
 });
 await attempt('commsAnswer',async()=>{
  phase='reload-send-and-answer';await page.reload();await page.locator('.next-shell').waitFor();
  const tile=await open('Comms');await select(tile);
  if(sentWords){await tile.getByText(sentWords,{exact:true}).waitFor();Object.assign(evidence.commsSend,{ok:validSend,persistedAfterReload:true});delete evidence.commsSend.error;}
  if(!evidence.inboxAnswer?.ok)throw Error('Inbox answer did not complete');
  const card=tile.getByRole('article',{name:'Inbox item',exact:true}).filter({has:page.getByRole('heading',{name:question,exact:true})});
  await card.getByRole('heading',{name:'Answer',exact:true}).waitFor({timeout:4000});
  const ok=await card.getByRole('button',{name:'Allow',exact:true}).count()===0&&await card.getByRole('button',{name:'Deny',exact:true}).count()===0;
  const screenshot='action-comms-answer.png';await tile.screenshot({path:join(out,screenshot)});return{ok,screenshot};
 });
 return evidence;
}
