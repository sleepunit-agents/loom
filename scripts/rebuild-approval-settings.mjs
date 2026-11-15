/** Standing rules, expiry and prepared operations in the actual example home. */
import {join} from 'node:path';
import {requestApprovalWithRules} from '../dist/apps/approval-request.js';
import {tempoSettingsProposals} from '../dist/core/tempo/proposal.js';
export async function approvalRulesAndExpiry({page,tile,app,example,out,clock}){
 const screenshot='action-approvalRulesAndExpiry.png',s=app.services,write=fn=>app.writes.run(fn).value;
 const check=(v,m)=>{if(!v)throw Error(m);};
 try{
  const base={kind:'command',target:'fictitious:inspection',what:'Fictitious expiring inspection',why:'Measure allowance expiry.',agent:'fern',askedFrom:'fictitious-expiry',actingFor:'alex',ask:'Allow a fictitious inspection?',ifYes:'Inspect.',ifNo:'Wait.',minutes:1};
  for(const minutes of [1,3]){
   const before=write(()=>s.approvals.request({...base,minutes,target:`fictitious:before-${minutes}`})),after=write(()=>s.approvals.request({...base,minutes,target:`fictitious:after-${minutes}`}));
   write(()=>{s.approvals.allow(before.id,'alex');s.approvals.allow(after.id,'alex');});clock.advance(minutes*60_000-1);
   check(s.approvals.get(before.id).state==='allowed'&&s.approvals.get(after.id).state==='allowed'&&write(()=>s.approvals.use(before.id,'fern','command',before.target)).ok,'Allowance ended before its configured deadline');
   clock.advance(1);check(s.approvals.get(after.id).state==='expired'&&!write(()=>s.approvals.use(after.id,'fern','command',after.target)).ok,'Configured expiry did not refuse use');
  }
  const watched=write(()=>s.approvals.request({...base,target:'fictitious:watched-answer',what:'Fictitious watched approval'}));
  const trigger=write(()=>s.tempo.triggers.set({ownerKind:'agent',owner:'fern',sourceKind:'answer',watches:`approval:${watched.id}`,lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fern',instructions:'Continue after the fictitious answer.',note:'Fictitious approval continuation'}));
  write(()=>s.approvals.allow(watched.id,'alex'));clock.advance(0);
  const deliveries=()=>s.comms.db.$client.prepare("SELECT count(*) AS n FROM inbox JOIN inbox_refs ON inbox_refs.item=inbox.id WHERE inbox.source='trigger' AND inbox_refs.ref=?").get(trigger.id).n;
  check(deliveries()===1,'Approval answer did not fire its once-only trigger');
  clock.advance(1);write(()=>s.approvals.deny(watched.id,'alex'));clock.advance(60_001);check(deliveries()===1,'Once-only trigger fired again on later denial');
  const consumed=write(()=>{const card=s.approvals.request({...base,target:'fictitious:consumed'});s.approvals.allow(card.id,'alex');return card;});
  check(write(()=>s.approvals.use(consumed.id,'fern','command',consumed.target)).ok&&!write(()=>s.approvals.use(consumed.id,'fern','command',consumed.target)).ok,'Allowance was not exactly single-use');
  const deniedAllowance=write(()=>s.approvals.request({...base,target:'fictitious:revoked-allowance'}));write(()=>{s.approvals.allow(deniedAllowance.id,'alex');s.approvals.deny(deniedAllowance.id,'alex');});check(s.approvals.get(deniedAllowance.id).state==='denied'&&!write(()=>s.approvals.use(deniedAllowance.id,'fern','command',deniedAllowance.target)).ok,'A denied allowance remained usable');
  const withdrawn=write(()=>s.approvals.request({...base,target:'fictitious:withdrawn-allowance'}));write(()=>{s.approvals.allow(withdrawn.id,'alex');s.approvals.withdraw(withdrawn.id,'fern');});check(s.approvals.get(withdrawn.id).state==='withdrawn'&&!write(()=>s.approvals.use(withdrawn.id,'fern','command',withdrawn.target)).ok,'A withdrawn allowance remained usable');
  check(s.approvals.get(example.approval).conversation===example.conversation,'Approval lost its source conversation');
  await tile.getByRole('button',{name:'Go to Approvals',exact:true}).click();
  await tile.locator('button:visible').filter({hasText:/^Rules(?:\d+)?$/}).first().click();
  const form=tile.getByRole('form',{name:'Standing rule',exact:true});await form.getByLabel('Kind',{exact:true}).selectOption('command');await form.getByLabel('Scope',{exact:true}).fill('fictitious:*');
  for(const tier of ['ask','tell','do']){
   await form.getByLabel('Answer',{exact:true}).selectOption(tier);
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/setRule'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
   await form.getByRole('button',{name:'Save rule',exact:true}).click();const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Standing rule was refused');
   check(s.approvalRules.resolve({kind:'command',target:base.target,actingFor:'alex'})?.tier===tier,'Standing answer did not match its scope');
   const applied=write(()=>requestApprovalWithRules(s.comms.db,s.approvals,s.approvalRules,{...base,target:`fictitious:rule-${tier}`}));
   check(applied.state===(tier==='ask'?'pending':'allowed'),'The rule-consuming request service did not apply the standing answer');
   check(s.approvalRules.resolve({kind:'command',target:'outside:inspection',actingFor:'alex'})===undefined&&s.approvalRules.resolve({kind:'command',target:base.target,actingFor:'robin'})===undefined,'Standing rule escaped its target or person scope');
  }
  let denied=false;try{write(()=>s.approvalRules.set({kind:'command',scope:'fictitious:*',tier:'tell'},'robin'));}catch{denied=true;}check(denied,'A nonowner edited standing rules');
  write(()=>{s.approvalRules.set({kind:'command',scope:'fictitious:*',tier:'tell'},'alex');s.approvalRules.set({kind:'command',scope:'fictitious:named',person:'robin',tier:'do'},'alex');});
  check(s.approvalRules.resolve({kind:'command',target:'fictitious:named',actingFor:'robin'})?.person==='robin','Named-person rule was not scoped to that person');
  check(s.approvalRules.resolve({kind:'command',target:'fictitious:named',actingFor:'alex'})?.tier==='tell'&&s.approvalRules.resolve({kind:'command',target:'fictitious:named',actingFor:'unknown'})===undefined,'A named-person grant widened to someone else');
  const reported=write(()=>{const card=requestApprovalWithRules(s.comms.db,s.approvals,s.approvalRules,{...base,what:'Fictitious reported inspection'});check(card.state==='allowed','Tell rule did not allow work');s.approvals.use(card.id,'fern','command',card.target);s.approvals.reportUsed(card.id,'fern','Fern performed the fictitious inspection.');return card;});
  await tile.locator('button:visible').filter({hasText:/^Reported steps/}).first().click();
  await tile.getByText('Fern performed the fictitious inspection.',{exact:true}).waitFor();
  check(s.approvals.record(reported.id).map(row=>row.event).join(',')==='request,allow,use,use','Reported step lost its permanent request/answer/use history');
  await tile.locator('button:visible').filter({hasText:/^History/}).first().click();
  await tile.locator('.loom-split__rows [data-split-row]').filter({has:page.getByText('Fictitious reported inspection',{exact:true})}).click();
  const history=tile.locator('section').filter({has:page.getByRole('heading',{name:'Permanent record',exact:true})}).last();
  const words=await history.innerText();check(/\brequest\b/.test(words)&&/\ballow\b/.test(words)&&/\buse\b/.test(words)&&words.includes('Fern performed the fictitious inspection.'),'Browser permanent history omitted request/answer/use/report');
  const draft=write(()=>s.tasks.create({title:'Fictitious order draft',goal:'Discard an unused draft only on approval.',why:'Prove a prepared dangerous action.',owner:{kind:'household'}},{kind:'member',id:'alex'}));
  const deniedDraft=write(()=>s.approvals.request({agent:'fern',askedFrom:example.conversation,actingFor:'alex',conversation:example.conversation,member:'alex',kind:'dangerous',target:`example:discard-draft:${draft.id}`,operation:'example.discardDraft',changeSummary:`Draft ${draft.id}: open → cancelled`,what:'Discard the fictitious order draft',why:'A fictitious prepared change.',ask:'Discard the fictitious order draft?',ifYes:'Loom cancels this draft.',ifNo:'Loom keeps the draft.'}));
  await tile.getByRole('button',{name:'Go to Approvals',exact:true}).click();
  await tile.locator('.loom-split__rows [data-split-row]').filter({has:page.getByText(deniedDraft.what,{exact:true})}).click();
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await tile.getByRole('group',{name:'Answer approval',exact:true}).getByRole('button',{name:'Deny',exact:true}).click();const response=await pending;
  check(response.ok()&&(await response.json()).ok===true&&s.approvals.get(deniedDraft.id).state==='denied'&&s.tasks.get(draft.id).status==='open','Deny changed the prepared draft or answered another card');
  example.preparedDraft=draft.id;example.deniedDraftApproval=deniedDraft.id;
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {approvalRulesAndExpiry:{ok:true,screenshot}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {approvalRulesAndExpiry:{ok:false,error:String(error),screenshot}};}
}

export async function approvalPreparedChanges({page,tile,app,example,out,clock}){
 const activate=async button=>{await button.waitFor({state:'visible'});await button.focus();await button.press('Enter');};
 const screenshot='action-approvalPreparedChanges.png',s=app.services,write=fn=>app.writes.run(fn).value,who={kind:'person',id:'alex'};
 const check=(v,m)=>{if(!v)throw Error(m);};
 try{
  const context={agent:'fern',askedFrom:example.conversation,actingFor:'alex',conversation:example.conversation,member:'alex',why:'Requested in the fictitious conversation.'};
  const answer=async(card,button)=>{
   const active=tile.getByRole('article',{name:card.ask,exact:true}).filter({has:page.getByRole('button',{name:button,exact:true})}).last();
   await active.getByRole('heading',{name:card.ask,exact:true}).first().waitFor({timeout:4000});
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
   await activate(active.getByRole('button',{name:button,exact:true}));const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Prepared operation answer refused');
  };
  const before=s.tempo.volume.timings(who).settleSeconds;clock.advance(1);
  const deniedSetting=write(()=>tempoSettingsProposals(s.comms.db,clock).request(s.approvals,who,{settleSeconds:before+1},context));
  await answer(deniedSetting,'Deny');check(s.tempo.volume.timings(who).settleSeconds===before,'Deny applied a proposed setting');clock.advance(1);
  const setting=write(()=>tempoSettingsProposals(s.comms.db,clock).request(s.approvals,who,{settleSeconds:before+1},context));
  const change=tile.getByRole('region',{name:'Tempo settings change',exact:true}).last();
  await change.getByRole('region',{name:'Before',exact:true}).getByText(`${before} seconds`,{exact:true}).waitFor({timeout:4000});
  await change.getByRole('region',{name:'After',exact:true}).getByText(`${before+1} seconds`,{exact:true}).waitFor();
  check(s.tempo.volume.timings(who).settleSeconds===before,'Proposing settings applied them early');
  await answer(setting,'Allow');
  check(s.tempo.volume.timings(who).settleSeconds===before+1&&s.approvals.get(setting.id).state==='used','Allow did not apply the prepared settings itself');
  check(s.approvals.record(setting.id).map(row=>row.event).join(',')==='request,allow,use','Prepared settings record incomplete');
  const draft=s.tasks.get(example.preparedDraft);check(draft.status==='open'&&s.approvals.get(example.deniedDraftApproval).state==='denied','The tile Deny was not preserved before inline Allow');
  const propose=()=>{clock.advance(1);return write(()=>s.approvals.request({...context,kind:'dangerous',target:`example:discard-draft:${draft.id}`,operation:'example.discardDraft',changeSummary:`Draft ${draft.id}: open → cancelled`,what:'Discard the fictitious order draft',ask:'Discard the fictitious order draft?',ifYes:'Loom cancels this draft.',ifNo:'Loom keeps the draft.'}));};
  const allowed=propose();await tile.getByText(`Draft ${draft.id}: open → cancelled`,{exact:true}).first().waitFor();await answer(allowed,'Allow');
  check(s.tasks.get(draft.id).status==='closed'&&s.tasks.get(draft.id).closeReason==='cancelled'&&s.approvals.get(allowed.id).state==='used','Allow did not perform the exact dangerous action');
  const merge=write(()=>s.approvals.request({...context,kind:'merge',target:`${example.change}@${s.changes.get(example.change).headCommit}`,what:'Fictitious exact-head merge',ask:'Merge the fictitious head?',ifYes:'Fern merges it.',ifNo:'Leave it open.'}));
  check(['command','merge','setting','dangerous'].every(kind=>s.approvals.list().some(card=>card.kind===kind)),'Not all four approval kinds were represented');
  write(()=>s.approvals.withdraw(merge.id,'fern'));check(s.approvals.get(merge.id).state==='withdrawn','Merge request was not withdrawn');
  await tile.screenshot({path:join(out,screenshot)});return {approvalPreparedChanges:{ok:true,screenshot}};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});return {approvalPreparedChanges:{ok:false,error:String(error),screenshot}};}
}
