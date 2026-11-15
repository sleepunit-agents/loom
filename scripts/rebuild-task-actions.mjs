/** Task evidence uses the signed-in browser and the disposable program's store.
 * Writes go through visible controls; SQL only checks the persisted result. */
import {join} from 'node:path';
export async function taskActions({page,tile,app,example,out}){
 const evidence={},db=app.services.comms.db.$client;
 const check=(value,message)=>{if(!value)throw Error(message);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{await run();await page.screenshot({path:join(out,screenshot),fullPage:true});evidence[name]={ok:true,screenshot};}catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});evidence[name]={ok:false,error:String(error),screenshot};}};
 const command=async(action,fill)=>{
  await tile.getByRole('button',{name:action,exact:true}).click();
  const form=page.getByRole('dialog').getByRole('form');await form.waitFor();if(fill)await fill(form);
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks/command'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await form.getByRole('button',{name:/^(Claim task|Add comment|Close task)$/}).click();
  const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,JSON.stringify(body));await form.waitFor({state:'hidden'});
 };
 await attempt('taskReady',async()=>{
  await tile.getByText('Measure the hose',{exact:true}).first().waitFor();
  const rows=await tile.locator('[data-split-row]').allTextContents();
  check(rows.length===1&&rows[0].includes('Measure the hose'),'Ready includes blocked, claimed or closed work');
 });
 await attempt('taskLifecycle',async()=>{
  await tile.getByText('Measure the hose',{exact:true}).first().click();
  await command('Claim');
  const task=()=>db.prepare('SELECT * FROM tasks WHERE id=?').get(example.tasks[2]);
  check(task().status==='in_progress'&&task().assignee_kind==='member'&&task().assignee==='alex'&&!!task().started_at,'Claim did not persist the signed-in member');
  await command('Comment',form=>form.getByLabel('Comment',{exact:true}).fill('Measured the fictitious hose in the browser.'));
  await tile.getByText('Measured the fictitious hose in the browser.',{exact:true}).waitFor();
  const comments=db.prepare('SELECT * FROM task_comments WHERE task=? ORDER BY seq').all(example.tasks[2]);
  check(comments.length===1&&comments[0].actor_kind==='member'&&comments[0].actor==='alex'&&!!comments[0].at,'Comment author/time did not persist');
  await command('Close',form=>form.getByLabel('Reason (cancelled marks it cancelled)',{exact:true}).fill('cancelled'));
  await tile.getByText('Closed because',{exact:true}).waitFor();
  check(task().status==='closed'&&task().close_reason==='cancelled'&&!!task().closed_at,'Cancellation did not persist');
 });
 return evidence;
}
