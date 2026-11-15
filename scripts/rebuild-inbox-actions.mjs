/** All answers use the real Inbox controls; private words stay in Comms. */
import {join} from 'node:path';
export async function inboxActions({page,tile,app,example,out}){
 const evidence={},created=[],db=app.services.comms.db.$client;
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await page.screenshot({path:join(out,screenshot),fullPage:true});};
 for(const answer of ['yes','no','words']){
  const question=`Fictitious Inbox ${answer} decision?`;
  const commit=await app.services.comms.prepareAsk(example.thread,'fern',`walkthrough-inbox-${answer}`,{words:question,answers:answer==='words'?'words':'yes-no',why:'Only the disposable example garden is affected.',ifYes:'Fern proceeds with the example.',ifNo:'Fern waits.',refs:[example.tasks[0],example.change]});
  const message=app.writes.run(commit).value;created.push({question,answer,item:message.inboxItem});
 }
 await attempt('inboxDecisions',async()=>{
  for(const item of created){
   const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
   await tile.locator('[data-split-row]:visible').filter({hasText:item.question}).click();
   await tile.getByRole('heading',{name:item.question,exact:true}).waitFor();
   const text=await tile.innerText();check(text.includes(example.tasks[0])&&text.includes(example.change),'Question omitted its task/PR references');
   if(item.answer==='words')await tile.getByRole('textbox',{name:'Answer in your own words',exact:true}).fill('Use the fictional blue hose.');
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/inbox/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
   await tile.getByRole('button',{name:item.answer==='words'?'Record answer':item.answer==='yes'?'Yes':'No',exact:true}).click();
   const result=await pending,body=await result.json();check(result.ok()&&body.ok===true,'Browser answer was refused');
   await tile.getByRole('heading',{name:'Answer',exact:true}).waitFor();
   const row=db.prepare('SELECT * FROM inbox WHERE id=?').get(item.item);
   check(row.state==='answered'&&row.answer===item.answer&&row.answered_by==='alex'&&!!row.answered_at,'Answer, actor or time was not stored');
   const replies=db.prepare('SELECT * FROM inbox WHERE source=\'answer\' AND source_id=?').all(item.item);
   check(replies.length===1&&replies[0].conversation===example.conversation&&replies[0].to_kind==='agent'&&replies[0].to==='fern','Answer did not create exactly one same-conversation item for Fern');
   check(await app.services.comms.words(replies[0].thread,replies[0].message_seq)===(item.answer==='words'?'Use the fictional blue hose.':item.answer),'The agent answer did not carry the chosen words');
  }
  return{reason:'Yes, No and written answers each stored Alex/time and delivered one same-conversation answer with the correct words to Fern.',items:created.map(item=>item.item)};
 });
 await attempt('inboxHistory',async()=>{
  check(evidence.inboxDecisions?.ok,'Answer scenarios did not complete');
  for(const item of created){const read=db.prepare('SELECT * FROM inbox_reads WHERE item=? AND member=?').all(item.item,'alex');check(read.length===1&&!!read[0].read_at,'Opening a question did not mark it read for Alex');}
  const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
  await tile.getByRole('button',{name:/^Answered(?:\s|$)/}).first().click();
  for(const item of created)await tile.locator('[data-split-row]:visible').filter({hasText:item.question}).waitFor();
  return{reason:'Opening each question stored Alex’s read mark; all three answered questions remained visible in Answered with their task/PR references checked before answering.',items:created.map(item=>item.item)};
 });
 const needs=tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first();if(await needs.count())await needs.click();
 return evidence;
}
