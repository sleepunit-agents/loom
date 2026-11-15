/** Standing rules, expiry and prepared operations in the actual example home. */
import {join} from 'node:path';
import {tempoSettingsProposals} from '../dist/core/tempo/proposal.js';
export async function approvalRulesAndExpiry({page,tile,app,example,out,clock}){
 const screenshot='action-approvalRulesAndExpiry.png',s=app.services,write=fn=>app.writes.run(fn).value;
 const check=(v,m)=>{if(!v)throw Error(m);};
 try{
  const base={kind:'command',target:'fictitious:inspection',what:'Fictitious expiring inspection',why:'Measure allowance expiry.',agent:'fern',askedFrom:'fictitious-expiry',actingFor:'alex',ask:'Allow a fictitious inspection?',ifYes:'Inspect.',ifNo:'Wait.',minutes:1};
  const expired=write(()=>s.approvals.request(base));write(()=>s.approvals.allow(expired.id,'alex'));
  clock.advance(60_001);
  check(s.approvals.get(expired.id).state==='expired'&&!write(()=>s.approvals.use(expired.id,'fern','command',base.target)).ok,'Expired allowance remained usable');
  const watched=write(()=>s.approvals.request({...base,target:'fictitious:watched-answer',what:'Fictitious watched approval'}));
  const trigger=write(()=>s.tempo.triggers.set({ownerKind:'agent',owner:'fern',sourceKind:'answer',watches:watched.id,lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fern',instructions:'Continue after the fictitious answer.',note:'Fictitious approval continuation'}));
  write(()=>s.approvals.allow(watched.id,'alex'));clock.advance(0);
  const deliveries=()=>s.comms.db.$client.prepare("SELECT count(*) AS n FROM inbox JOIN inbox_refs ON inbox_refs.item=inbox.id WHERE inbox.source='trigger' AND inbox_refs.ref=?").get(trigger.id).n;
  check(deliveries()===1,'Approval answer did not fire its once-only trigger');
  write(()=>s.approvals.use(watched.id,'fern','command',watched.target));clock.advance(0);check(deliveries()===1,'Approval trigger fired twice');
  check(s.approvals.get(example.approval).conversation===example.conversation,'Approval lost its source conversation');
  await tile.getByRole('button',{name:'Go to Approvals',exact:true}).click();
  await tile.locator('button:visible').filter({hasText:/^Rules(?:\d+)?$/}).first().click();
  const form=tile.getByRole('form',{name:'Standing rule',exact:true});await form.getByLabel('Kind',{exact:true}).selectOption('command');await form.getByLabel('Scope',{exact:true}).fill('fictitious:*');
  for(const tier of ['ask','tell','do']){
   await form.getByLabel('Answer',{exact:true}).selectOption(tier);
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/setRule'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
   await form.getByRole('button',{name:'Save rule',exact:true}).click();const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Standing rule was refused');
   check(s.approvalRules.resolve({kind:'command',target:base.target,actingFor:'alex'})?.tier===tier,'Standing answer did not match its scope');
  }
  let denied=false;try{write(()=>s.approvalRules.set({kind:'command',scope:'fictitious:*',tier:'tell'},'robin'));}catch{denied=true;}check(denied,'A nonowner edited standing rules');
  write(()=>{s.approvalRules.set({kind:'command',scope:'fictitious:*',tier:'tell'},'alex');s.approvalRules.set({kind:'command',scope:'fictitious:named',person:'robin',tier:'do'},'alex');});
  check(s.approvalRules.resolve({kind:'command',target:'fictitious:named',actingFor:'robin'})?.person==='robin','Named-person rule was not scoped to that person');
  const reported=write(()=>{const card=s.approvals.request({...base,what:'Fictitious reported inspection'});s.approvals.allow(card.id,'alex','Standing tell rule fictitious:* for alex, set by alex');s.approvals.use(card.id,'fern','command',card.target);s.approvals.reportUsed(card.id,'fern','Fern performed the fictitious inspection.');return card;});
  await tile.locator('button:visible').filter({hasText:/^Reported steps(?:\d+)?$/}).first().click();
  await tile.getByText('Fern performed the fictitious inspection.',{exact:true}).waitFor();
  check(s.approvals.record(reported.id).map(row=>row.event).join(',')==='request,allow,use,use','Reported step lost its permanent request/answer/use history');
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {approvalRulesAndExpiry:{ok:true,screenshot}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {approvalRulesAndExpiry:{ok:false,error:String(error),screenshot}};}
}

export async function approvalPreparedChanges({page,tile,app,example,out,clock}){
 const screenshot='action-approvalPreparedChanges.png',s=app.services,write=fn=>app.writes.run(fn).value,who={kind:'person',id:'alex'};
 const check=(v,m)=>{if(!v)throw Error(m);};
 try{
  const context={agent:'fern',askedFrom:example.conversation,actingFor:'alex',conversation:example.conversation,member:'alex',why:'Requested in the fictitious conversation.'};
  const answer=async(card,button)=>{
   const active=tile.getByRole('article').filter({has:page.getByRole('heading',{name:card.ask,exact:true})}).filter({has:page.getByRole('button',{name:button,exact:true})}).last();
   await active.getByRole('heading',{name:card.ask,exact:true}).waitFor({timeout:4000});
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
   await active.getByRole('button',{name:button,exact:true}).click();const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Prepared operation answer refused');
  };
  const before=s.tempo.volume.timings(who).settleSeconds;clock.advance(1);
  const setting=write(()=>tempoSettingsProposals(s.comms.db,clock).request(s.approvals,who,{settleSeconds:before+1},context));
  const change=tile.getByRole('region',{name:'Tempo settings change',exact:true}).last();
  await change.getByRole('region',{name:'Before',exact:true}).getByText(`${before} seconds`,{exact:true}).waitFor({timeout:4000});
  await change.getByRole('region',{name:'After',exact:true}).getByText(`${before+1} seconds`,{exact:true}).waitFor();
  check(s.tempo.volume.timings(who).settleSeconds===before,'Proposing settings applied them early');
  await answer(setting,'Allow');
  check(s.tempo.volume.timings(who).settleSeconds===before+1&&s.approvals.get(setting.id).state==='used','Allow did not apply the prepared settings itself');
  check(s.approvals.record(setting.id).map(row=>row.event).join(',')==='request,allow,use','Prepared settings record incomplete');
  const draft=write(()=>s.tasks.create({title:'Fictitious order draft',goal:'Discard an unused draft only on approval.',why:'Prove a prepared dangerous action.',owner:{kind:'household'}},{kind:'member',id:'alex'}));
  const propose=()=>{clock.advance(1);return write(()=>s.approvals.request({...context,kind:'dangerous',target:`example:discard-draft:${draft.id}`,operation:'example.discardDraft',changeSummary:`Draft ${draft.id}: open → cancelled`,what:'Discard the fictitious order draft',ask:'Discard the fictitious order draft?',ifYes:'Loom cancels this draft.',ifNo:'Loom keeps the draft.'}));};
  const denied=propose();await tile.getByText(`Draft ${draft.id}: open → cancelled`,{exact:true}).first().waitFor();await answer(denied,'Deny');check(s.tasks.get(draft.id).status==='open','Deny changed the draft');
  const allowed=propose();await answer(allowed,'Allow');
  check(s.tasks.get(draft.id).status==='closed'&&s.tasks.get(draft.id).closeReason==='cancelled'&&s.approvals.get(allowed.id).state==='used','Allow did not perform the exact dangerous action');
  const merge=write(()=>s.approvals.request({...context,kind:'merge',target:`${example.change}@${s.changes.get(example.change).headCommit}`,what:'Fictitious exact-head merge',ask:'Merge the fictitious head?',ifYes:'Fern merges it.',ifNo:'Leave it open.'}));
  check(['command','merge','setting','dangerous'].every(kind=>s.approvals.list().some(card=>card.kind===kind)),'Not all four approval kinds were represented');
  write(()=>s.approvals.withdraw(merge.id,'fern'));
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {approvalPreparedChanges:{ok:true,screenshot}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {approvalPreparedChanges:{ok:false,error:String(error),screenshot}};}
}
