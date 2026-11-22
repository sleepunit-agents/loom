/** All answers use real Inbox controls; each variant has its own bounded step. */
import {join} from 'node:path';
import {responseForAction} from './rebuild-response-capture.mjs';
export async function* inboxActionSteps({page,tile,app,example,out}){
 const evidence={},created=[],db=app.services.comms.db.$client;
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await page.screenshot({path:join(out,screenshot),fullPage:true});};
 try{
  await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();
  for(const answer of ['yes','no','words']){
   const name='inboxDecision'+answer[0].toUpperCase()+answer.slice(1);
   await attempt(name,async()=>{
    const question=`Fictitious Inbox ${answer} decision?`;
    const ifYes=`Fern proceeds with the example ${answer} decision.`,ifNo=`Fern waits on the example ${answer} decision.`;
    const commit=await app.services.comms.prepareAsk(example.thread,'fern',`walkthrough-inbox-${answer}`,{words:question,answers:answer==='words'?'words':'yes-no',why:'Only the disposable example garden is affected.',ifYes,ifNo,refs:[example.tasks[0],example.change]});
    const message=app.writes.run(commit).value,item={question,answer,item:message.inboxItem};created.push(item);
    const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
    await tile.locator('[data-split-row]:visible').filter({hasText:item.question}).click();
    await tile.getByRole('heading',{name:item.question,exact:true}).waitFor();
    if(answer!=='words'){
     const reader=tile.locator('[aria-label="Inbox item"]');
     for(const [label,value] of [['If yes',ifYes],['If no',ifNo]]){
      const term=reader.getByText(label,{exact:true});
      await term.waitFor();
      const definition=term.locator('xpath=following-sibling::*[1][self::dd]');
      await definition.waitFor();
      check(await definition.textContent()===value,label+' showed the wrong consequence');
     }
     if(answer==='yes')await page.screenshot({path:join(out,'action-inboxConsequences.png'),fullPage:true});
    }
    const text=await tile.innerText();check(text.includes(example.tasks[0])&&text.includes(example.change),'Question omitted its task/PR references');
    if(answer==='words')await tile.getByRole('textbox',{name:'Answer in your own words',exact:true}).fill('Use the fictional blue hose.');
    const result=await responseForAction(page,r=>new URL(r.url()).pathname==='/api/inbox/answer'&&r.method()==='POST',()=>tile.getByRole('button',{name:answer==='words'?'Record answer':answer==='yes'?'Yes':'No',exact:true}).click());
    const body=await result.json();check(result.ok()&&body.ok===true,'Browser answer was refused');
    await tile.getByRole('heading',{name:'Answer',exact:true}).waitFor();
    const row=db.prepare('SELECT * FROM inbox WHERE id=?').get(item.item);
    check(row.state==='answered'&&row.answer===answer&&row.answered_by==='alex'&&!!row.answered_at,'Answer, actor or time was not stored');
    const replies=db.prepare('SELECT * FROM inbox WHERE source=\'answer\' AND source_id=?').all(item.item);
    check(replies.length===1&&replies[0].conversation===example.conversation&&replies[0].to_kind==='agent'&&replies[0].to==='fern','Answer did not create exactly one same-conversation item for Fern');
    check(await app.services.comms.words(replies[0].thread,replies[0].message_seq)===(answer==='words'?'Use the fictional blue hose.':answer),'The agent answer did not carry the chosen words');
    return{item:item.item,answer};
   });
   yield{phase:'inbox-decision',answer,actions:{...evidence}};
  }
  const variants=['inboxDecisionYes','inboxDecisionNo','inboxDecisionWords'].map(name=>evidence[name]);
  const binary=variants.slice(0,2);
  evidence.inboxConsequences=binary.every(row=>row.ok)?{ok:true,reason:'Alex opened two questions in Needs you and saw each supplied consequence beside the corresponding If yes or If no label before answering.',screenshot:'action-inboxConsequences.png'}:{ok:false,error:binary.find(row=>!row.ok)?.error};
  evidence.inboxDecisions=variants.every(row=>row.ok)?{ok:true,reason:'Yes, No and written answers each stored Alex/time and delivered one same-conversation answer with the correct words to Fern.',items:created.map(item=>item.item),variants,screenshot:variants.at(-1).screenshot}:{ok:false,error:variants.find(row=>!row.ok)?.error,variants};
  await attempt('inboxHistory',async()=>{
   check(evidence.inboxDecisions.ok&&created.length===3,'Answer scenarios did not complete');
   for(const item of created){const read=db.prepare('SELECT * FROM inbox_reads WHERE item=? AND member=?').all(item.item,'alex');check(read.length===1&&!!read[0].read_at,'Opening a question did not mark it read for Alex');}
   const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
   await tile.getByRole('button',{name:/^Answered(?:\s|$)/}).first().click();
   for(const item of created)await tile.locator('[data-split-row]:visible').filter({hasText:item.question}).waitFor();
   return{reason:'Opening each question stored Alex’s read mark; all three answered questions remained visible in Answered with their task/PR references checked before answering.',items:created.map(item=>item.item)};
  });
  yield{phase:'inbox-history',actions:{...evidence}};
 }finally{
  const needs=tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first();if(await needs.count())await needs.click();
 }
}
