import {join} from 'node:path';
import {responseForAction} from './rebuild-response-capture.mjs';
import {maskCredentialScreenshots} from './rebuild-credential-evidence.mjs';

export async function approvalCaution({page,app,example,out}){
 const browser=await page.context().newPage();
 maskCredentialScreenshots(browser);
 const screenshot='action-approvalCaution.png',services=app.services;
 const who={kind:'agent',id:'moss'},volume=services.tempo.volume;
 const original=volume.timings(who).settleSeconds;
 const write=fn=>app.writes.run(fn).value;
 const set=value=>write(()=>volume.setTimings(who,{settleSeconds:value}));
 let phase='file';
 try{
  const card=write(()=>services.setup.propose('fern',{change:'tempoTimings',input:{who,settleSeconds:original+1},why:'Measure an advisory on a fictional timing change.'},{conversation:example.conversation,member:'alex',project:null}));
  const preview=request=>new URL(request.url()).pathname==='/api/household/proposalPreview'&&request.postDataJSON()?.input?.id===card.id;
  phase='open card';
  await responseForAction(browser,preview,()=>browser.goto(new URL('/p/approvals-preview/approval/'+encodeURIComponent(card.id),app.url).href),15000);
  const tile=browser.getByRole('region',{name:'Approvals tile',exact:true});
  const caution=tile.getByRole('note').filter({hasText:'The request has been refreshed.'});
  const group=tile.getByRole('group',{name:'Answer approval'});
  const allow=group.getByRole('button',{name:'Allow',exact:true});
  const deny=group.getByRole('button',{name:'Deny',exact:true});
  await allow.waitFor();
  phase='timer';
  const seconds=value=>value+' '+(value===1?'second':'seconds');
  const timing=before=>tile.getByText(seconds(before)+' → '+seconds(original+1),{exact:true});
  await timing(original).waitFor();
  await caution.waitFor({state:'hidden'});
  set(original+2);
  // Leave the card untouched for its minute refresh. Check what the owner actually sees.
  await caution.waitFor({timeout:90_000});
  await timing(original+2).waitFor();
  if(!await allow.isEnabled()||!await deny.isEnabled())throw Error('An advisory disabled an owner decision');
  phase='focus';
  set(original);
  await responseForAction(browser,preview,()=>browser.evaluate(()=>window.dispatchEvent(new Event('focus'))));
  await caution.waitFor({state:'hidden'});
  set(original+2);
  const answer=request=>new URL(request.url()).pathname==='/api/approvals/answer'&&request.postDataJSON()?.input?.id===card.id;
  phase='refused allow';
  let refused;
  await responseForAction(browser,preview,async()=>{refused=await responseForAction(browser,answer,()=>allow.click());});
  if((await refused.json()).ok!==false||services.approvals.get(card.id).state!=='pending'||volume.timings(who).settleSeconds!==original+2)throw Error('A stale proposal changed the fixture or was settled');
  await caution.waitFor();
  await browser.screenshot({path:join(out,screenshot)});
  phase='reviewed allow';
  const accepted=await responseForAction(browser,answer,()=>allow.click());
  if(!(await accepted.json()).ok||services.approvals.get(card.id).state!=='used'||volume.timings(who).settleSeconds!==original+1)throw Error('The reviewed change was not applied');
  if(services.approvals.record(card.id).filter(event=>event.event==='use').length!==1)throw Error('Duplicate application');
  return {ok:true,screenshot};
 }catch(error){await browser.screenshot({path:join(out,screenshot)}).catch(()=>{});return {ok:false,phase,error:String(error),screenshot};}
 finally{set(original);await browser.close();}
}
