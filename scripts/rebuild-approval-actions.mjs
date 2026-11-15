/** Real approval answers against the disposable running household. */
import {join} from 'node:path';
export async function approvalActions({page,tile,app,example,out}){
 const evidence={},s=app.services.approvals,write=fn=>app.writes.run(fn).value;
 const check=(v,m)=>{if(!v)throw Error(m);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{await run();await page.screenshot({path:join(out,screenshot),fullPage:true});evidence[name]={ok:true,screenshot};}catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});evidence[name]={ok:false,error:String(error),screenshot};}};
 const request=(name,extra={})=>write(()=>s.request({kind:'command',target:`example-worker:${name}`,what:`Fictitious ${name}`,why:'Measure a real approval answer.',agent:'fern',askedFrom:example.conversation,actingFor:'alex',conversation:example.conversation,member:'alex',ask:`Allow fictitious ${name}?`,ifYes:'Fern performs this exact step.',ifNo:'Fern leaves it alone.',...extra}));
 const answer=async(card,button)=>{
  const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.click();
  await tile.getByText(card.what,{exact:true}).first().click();
  const reader=tile.getByRole('region',{name:'Approvals: the open item',exact:true});
  await reader.getByText(card.target,{exact:false}).waitFor();
  await reader.getByText(card.ifYes,{exact:true}).waitFor();await reader.getByText(card.ifNo,{exact:true}).waitFor();
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await reader.getByRole('button',{name:button,exact:true}).click();
  const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Approval browser answer refused');
 };
 await attempt('approvalDecisions',async()=>{
  const allowed=request('allowed-inspection'),denied=request('denied-inspection');
  const db=app.services.comms.db.$client;
  for(const card of [allowed,denied])check(db.prepare("SELECT count(*) AS n FROM inbox WHERE source='approval' AND source_id=? AND to_kind='person' AND \"to\"='alex'").get(card.id).n===1,'Pending approval missing from owner Inbox');
  await answer(allowed,'Allow');
  const row=s.get(allowed.id);check(row.state==='allowed'&&row.decidedBy==='alex'&&Date.parse(row.expiresAt)-Date.parse(row.decidedAt)===row.minutes*60000,'Allowance identity or duration missing');
  const before=s.record(allowed.id);check(before.map(r=>r.event).join(',')==='request,allow','Request/answer record missing');
  check(write(()=>s.use(allowed.id,'fern','command',allowed.target)).ok,'Exact allowance could not be spent');
  check(!write(()=>s.use(allowed.id,'fern','command',allowed.target)).ok,'Allowance could be spent twice');
  check(JSON.stringify(s.record(allowed.id).slice(0,before.length))===JSON.stringify(before),'Permanent history changed');
  await answer(denied,'Deny');check(s.get(denied.id).state==='denied'&&s.get(denied.id).decidedBy==='alex','Denial missing');
  check(s.record(denied.id).map(r=>r.event).join(',')==='request,deny','Denial record missing');
  const withdrawn=request('withdrawn-inspection');write(()=>s.withdraw(withdrawn.id,'fern'));check(s.get(withdrawn.id).state==='withdrawn','Withdrawal missing');
 });
 return evidence;
}
