/** Follow a managed Inbox item back to its real app, on fictitious work only. */
import {join} from 'node:path';
export async function inboxSources({page,tile,app,example,out}){
 const evidence={},db=app.services.comms.db.$client,question='Choose the fictional hose colour?';
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await page.screenshot({path:join(out,screenshot),fullPage:true});};
 const actor={kind:'agent',id:'fern'};
 const task=app.writes.run(()=>app.services.tasks.create({title:'Decide the fictional hose colour',goal:'The example hose has a chosen colour.',why:'Measure the task-to-Inbox link.',owner:{kind:'agent',id:'fern'},source:{kind:'conversation',id:example.conversation}},actor)).value;
 app.writes.run(()=>app.services.tasks.ask(task.id,{to:{kind:'member',id:'alex'},ask:question,ifYes:'Fern uses blue.',ifNo:'Fern keeps the old hose.'},actor));
 const open=async title=>{await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+Space');const launcher=page.getByRole('dialog',{name:'Apps',exact:true});await launcher.waitFor();const button=launcher.locator('.loom-lapp').filter({has:page.locator('.loom-lapp__nm',{hasText:new RegExp('^'+title+'$')})});await button.focus();await button.press('Enter');await launcher.waitFor({state:'hidden'});const tile=page.getByRole('region',{name:`${title} tile`,exact:true});await tile.waitFor();return tile;};
 const list=async()=>{tile=await open('Inbox');const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();};
 await attempt('taskQuestionInbox',async()=>{
  await list();await tile.locator('[data-split-row]:visible').filter({hasText:question}).click();await tile.getByRole('heading',{name:question,exact:true}).waitFor();
  const mail=db.prepare('SELECT * FROM inbox WHERE source=\'task\' AND waits_on_id=? AND "to"=?').all(task.id,'alex');
  check(mail.length===1&&mail[0].to_kind==='person'&&mail[0].state==='waiting'&&mail[0].conversation===example.conversation,'Question did not reach Alex in its source conversation');
  check((await tile.innerText()).includes('Fern uses blue.')&&(await tile.innerText()).includes('Fern keeps the old hose.'),'Inbox lost the task question outcomes');
  return{reason:'The task question appeared in Alex’s waiting Inbox with its outcomes, one delivery and the source conversation.',task:task.id,item:mail[0].id};
 });
 await attempt('inboxSourceLinks',async()=>{
  check(evidence.taskQuestionInbox?.ok,'Task question was not reached');
  await tile.getByRole('button',{name:'Open task',exact:true}).click();
  const tasks=page.getByRole('region',{name:'Tasks tile',exact:true});await tasks.getByRole('heading',{name:task.title,exact:true}).waitFor();
  await tasks.getByText(question,{exact:true}).waitFor();
  await list();await tile.locator('[data-split-row]:visible').filter({hasText:'Inspect the example pump?'}).click();
  await tile.getByRole('button',{name:'Open Approvals',exact:true}).click();
  const approvals=page.getByRole('region',{name:'Approvals tile',exact:true});await approvals.getByRole('heading',{name:'Inspect the example pump?',exact:true}).waitFor();
  return{reason:'Open task and Open Approvals each navigated to the exact source record in the corresponding app.',task:task.id,approval:example.approval};
 });
 await attempt('taskQuestionAnswer',async()=>{
  const tasks=await open('Tasks');await tasks.getByRole('heading',{name:task.title,exact:true}).waitFor();
  const yes=tasks.getByRole('button',{name:'Yes',exact:true}),no=tasks.getByRole('button',{name:'No',exact:true});
  check(await yes.isVisible()&&await no.isVisible(),'The source task displays its question but provides no Yes/No answer controls');
  // Do not turn controls into a pass: prove that the answer commits at its source.
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/tasks/'),{timeout:4000});void response.catch(()=>{});
  await yes.click();const result=await response,body=await result.json();check(result.ok()&&body.ok===true,'Task answer was refused');
  check(!app.services.tasks.get(task.id).ask,'Answer did not settle the task question');
  return{reason:'The task source accepted Yes and cleared its question.',task:task.id};
 });
 await list();
 return evidence;
}
