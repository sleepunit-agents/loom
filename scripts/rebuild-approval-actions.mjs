/** Approval answers in the real browser; only its fictitious household is used. */
import {join} from 'node:path';
export async function approvalActions({page,tile,app,example,out}){
 const evidence={},db=app.services.comms.db.$client;
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await page.screenshot({path:join(out,screenshot),fullPage:true});};
 const created=[];
 // Requests enter through the program's own trusted operation, as the seed does.
 for(const answer of ['allow','deny'])created.push(app.writes.run(()=>app.services.approvals.request({kind:'command',target:`example-worker:browser-${answer}`,what:`Browser ${answer} example`,why:'Measure the approved page using fictional work.',agent:'fern',askedFrom:example.conversation,actingFor:'alex',conversation:example.conversation,member:'alex',ask:`${answer==='allow'?'Allow':'Deny'} the fictional inspection?`,ifYes:'Fern may inspect this exact fictional target.',ifNo:'Fern waits and nothing runs.'})).value);
 await attempt('approvalOrigins',async()=>{
  for(const card of created){
   check(card.conversation===example.conversation&&card.agent==='fern'&&card.member==='alex','Approval lost its source labels');
   const mail=db.prepare('SELECT * FROM inbox WHERE source=\'approval\' AND source_id=? AND to_kind=\'person\' AND "to"=\'alex\'').all(card.id);
   check(mail.length===1&&mail[0].state==='waiting'&&mail[0].waits_on_kind==='approval'&&mail[0].waits_on_id===card.id,'Pending request did not produce exactly one linked waiting item for Alex');
  }
  return{reason:'Both requests retained their source conversation and produced one waiting approval item addressed to Alex.',requests:created.map(card=>card.id)};
 });
 await attempt('approvalAnswers',async()=>{
  for(const [index,answer] of ['allow','deny'].entries()){
   const card=created[index],back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
   await tile.locator('[data-split-row]:visible').filter({hasText:card.what}).click();
   await tile.getByRole('heading',{name:card.ask,exact:true}).waitFor();
   for(const text of [card.target,card.why,card.ifYes,card.ifNo])check((await tile.innerText()).includes(text),`Approval card omitted ${text}`);
   const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:4000});void response.catch(()=>{});
   await tile.getByRole('button',{name:answer==='allow'?'Allow':'Deny',exact:true}).click();
   const result=await response,body=await result.json();check(result.ok()&&body.ok===true,'Browser approval answer was not accepted');
   await tile.getByText('Answered by alex',{exact:true}).waitFor();
   const row=db.prepare('SELECT * FROM approvals WHERE id=?').get(card.id);
   check(row.state===(answer==='allow'?'allowed':'denied')&&row.decided_by==='alex'&&!!row.decided_at&&row.target===card.target,'Answer, actor, time or exact target was not persisted');
   const record=db.prepare('SELECT event FROM approval_record WHERE approval=? ORDER BY seq').all(card.id).map(row=>row.event);
   check(JSON.stringify(record)===JSON.stringify(['request',answer]),'Permanent record lost or rewrote the request/answer');
   check(!await tile.getByRole('group',{name:'Answer approval',exact:true}).count(),'Answered request still offers an answer');
  }
  return{reason:'Allow and Deny each persisted Alex, time, exact target and ordered request/answer records; answered cards removed their controls.',requests:created.map(card=>card.id)};
 });
 return evidence;
}
