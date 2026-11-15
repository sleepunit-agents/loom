/** Follow a task question to its source; finish the task through its real form. */
import {join} from 'node:path';
import {redactSignin} from './rebuild-conversation-visibility.mjs';
class ObservedSourceFailure extends Error {}
const check=(yes,message)=>{if(!yes)throw new ObservedSourceFailure(message);};
export async function inboxTaskSource({page,tile,app,example,out,approval,open}){
 const pending=()=>({inconclusive:true,reason:'The task-source observation did not complete.'});
 const evidence={inboxTaskArrival:pending(),inboxTaskSettlement:pending()};let stage='inboxTaskArrival';
 try{
  const actor={kind:'agent',id:'fern'},title='Finish the fictional source-linked task',ask='Is the fictional source task complete?';
  const task=app.writes.run(()=>{
   const created=app.services.tasks.create({title,goal:'Exercise a source-owned outcome.',why:'Measure the Inbox-to-Tasks path.',owner:actor,source:{kind:'conversation',id:example.conversation}},actor);
   app.services.tasks.ask(created.id,{to:{kind:'member',id:'alex'},ask,ifYes:'Fern continues.',ifNo:'Fern waits.',answers:'yes-no'},actor);return created;
  }).value;
  const db=app.services.comms.db.$client;
  // source_id identifies this question's revision; waits_on_id names the task.
  const items=db.prepare('SELECT * FROM inbox WHERE source=\'task\' AND waits_on_kind=\'task\' AND waits_on_id=? AND to_kind=\'person\' AND "to"=\'alex\'').all(task.id);
  check(items.length===1&&items[0].state==='waiting'&&items[0].waits_on_id===task.id,'The task did not produce one linked waiting question for Alex');
  const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
  await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();
  await tile.locator('[data-split-row]:visible').filter({hasText:ask}).click();
  await tile.getByRole('heading',{name:ask,exact:true}).waitFor();
  await tile.getByRole('region',{name:'Answer task question',exact:true}).waitFor();
  const source=tile.getByRole('button',{name:'Open task',exact:true});let tasks;
  if(await source.count()){
   await source.first().click();tasks=page.getByRole('region',{name:'Tasks tile',exact:true});await tasks.getByRole('heading',{name:title,exact:true}).waitFor();
   check(new URL(page.url()).pathname==='/p/tasks-preview/task/'+encodeURIComponent(task.id),'The source link opened a different task');
   evidence.inboxTaskArrival={ok:true,reason:'One waiting question for Alex opened its exact task through the Inbox source link.',task:task.id,item:items[0].id};
  }else{
   const screenshot='action-inboxTaskSource-missing-link.png';let captured=false;
   try{await page.screenshot({path:join(out,screenshot),fullPage:true});captured=true;}catch{}
   evidence.inboxTaskArrival={ok:false,error:'The task question rendered its inline answer controls but did not offer a source link.',task:task.id,item:items[0].id,...(captured?{screenshot}:{})};
   // An ordinary manual visit can still measure outcome settlement. It is not
   // evidence that the missing Inbox source navigation worked.
   tasks=await open('Tasks');const back=tasks.locator('.loom-split__back:visible');if(await back.count())await back.click();
   await tasks.getByRole('button',{name:/^All open(?:\s|$)/}).first().click();
   await tasks.getByText(title,{exact:true}).first().click();await tasks.getByRole('heading',{name:title,exact:true}).waitFor();
  }
  stage='inboxTaskSettlement';
  await tasks.getByRole('button',{name:'Close',exact:true}).click();
  const form=page.getByRole('dialog').getByRole('form');await form.waitFor();
  const reason='The fictional source task was completed.';
  await form.getByLabel('Reason (cancelled marks it cancelled)',{exact:true}).fill(reason);
  await form.getByRole('button',{name:'Close task',exact:true}).click();await form.waitFor({state:'hidden'});
  await tasks.getByText('Closed because',{exact:true}).waitFor();await tasks.getByText(reason,{exact:true}).waitFor();
  // The rendered outcome and actual stored task must agree before its linked
  // Inbox resolution can receive a verdict. No synthetic completion callback.
  const closed=app.services.tasks.get(task.id);if(closed.status!=='closed'||closed.closeReason!==reason)throw Error('Task completion was not observed');
  const settled=db.prepare('SELECT * FROM inbox WHERE id=?').get(items[0].id);
  check(settled.state==='resolved'&&settled.resolution===reason,'Completing the named task did not resolve its Inbox question with the outcome reason');
  const screenshot='action-inboxTaskSource.png';await page.screenshot({path:join(out,screenshot),fullPage:true});
  evidence.inboxTaskSettlement={ok:true,reason:'Completing the task through its form resolved the original question with the exact completion reason.',task:task.id,item:items[0].id,screenshot};
 }catch(error){evidence[stage]=error instanceof ObservedSourceFailure?{ok:false,error:redactSignin(error)}:{inconclusive:true,reason:'The task-source observation could not complete.',error:redactSignin(error)};}
 evidence.inboxSourceTargets=approval?.ok===true&&evidence.inboxTaskArrival.ok===true?{ok:true,reason:'The actual approval and task questions each opened their exact source from Inbox.'}:{inconclusive:true,reason:'Both source navigation paths were not confirmed.'};
 evidence.inboxSourceOutcome=evidence.inboxTaskSettlement.ok===false?evidence.inboxTaskSettlement:approval?.ok===true&&evidence.inboxTaskSettlement.ok===true?{ok:true,reason:'Answering the named approval and completing the named task each resolved the original Inbox item and recorded why.'}:{inconclusive:true,reason:'Both source-owned settlement paths were not confirmed.'};
 return evidence;
}
