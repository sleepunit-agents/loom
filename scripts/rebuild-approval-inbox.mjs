/** Follow an actual approval item from Inbox to its source and answer there. */
import {join} from 'node:path';
export async function approvalInbox({page,tile,app,example,out}){
 const screenshot='action-approvalInbox.png',db=app.services.comms.db.$client;
 try{
  const check=(yes,message)=>{if(!yes)throw Error(message);};
  const card=app.writes.run(()=>app.services.approvals.request({kind:'command',target:'example-worker:inspect-spare',what:'Inspect the fictional spare pump',why:'Measure the Inbox-to-Approvals path.',agent:'fern',askedFrom:example.conversation,actingFor:'alex',conversation:example.conversation,member:'alex',ask:'Inspect the fictional spare pump?',ifYes:'Fern may inspect only the fictional spare.',ifNo:'Fern waits.'})).value;
  const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
  await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();
  await tile.locator('[data-split-row]:visible').filter({hasText:card.ask}).click();
  await tile.getByRole('heading',{name:card.ask,exact:true}).waitFor();
  const mail=db.prepare('SELECT * FROM inbox WHERE source=\'approval\' AND source_id=? AND "to"=\'alex\'').all(card.id);
  check(mail.length===1&&mail[0].state==='waiting'&&mail[0].waits_on_id===card.id,'Approval did not produce one linked waiting item for Alex');
  await tile.getByRole('button',{name:'Open Approvals',exact:true}).click();
  const approvals=page.getByRole('region',{name:'Approvals tile',exact:true});await approvals.getByRole('heading',{name:card.ask,exact:true}).waitFor();
  check((await approvals.innerText()).includes(card.target),'Inbox opened the wrong approval target');
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await approvals.getByRole('button',{name:'Allow',exact:true}).click();const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Source answer was refused');
  await approvals.getByText('Answered by alex',{exact:true}).waitFor();
  const answered=db.prepare('SELECT * FROM approvals WHERE id=?').get(card.id),settled=db.prepare('SELECT * FROM inbox WHERE id=?').get(mail[0].id);
  check(answered.state==='allowed'&&answered.decided_by==='alex'&&settled.state==='resolved'&&!!settled.resolution,'Source answer did not settle its Inbox item with a reason');
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  return{ok:true,reason:'One waiting approval item opened its exact source; Allow in Approvals persisted Alex’s answer and resolved that Inbox item with a reason.',approval:card.id,item:mail[0].id,screenshot};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true});return{ok:false,error:String(error),screenshot};}
 finally{
  await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+Space');const launcher=page.getByRole('dialog',{name:'Apps',exact:true});await launcher.waitFor();const button=launcher.locator('.loom-lapp').filter({has:page.locator('.loom-lapp__nm',{hasText:/^Inbox$/})});await button.focus();await button.press('Enter');await launcher.waitFor({state:'hidden'});
  const inbox=page.getByRole('region',{name:'Inbox tile',exact:true}),back=inbox.locator('.loom-split__back:visible');if(await back.count())await back.click();await inbox.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();
 }
}
