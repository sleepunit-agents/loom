/** Evidence is narrower than a page: an unexercised promise stays unknown. */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function evaluate(promise,run){
 const p=promise.probe;
 if(!p)return {status:'not checkable yet',reason:'No behavioral probe for this promise in the walkthrough. Opening an app is not proof.'};
 if(p.kind==='signin')return {status:run.signin?.ok?'met':'not met',reason:run.signin?.ok?'Normal first-run link signed in the browser.':'Normal first-run browser sign-in did not complete.',evidence:'00-signin.png'};
 if(p.kind==='live')return {status:run.live?.dataFrames>0&&!run.live.errors.length?'met':'not met',reason:`GraphQL data frames: ${run.live?.dataFrames??0}; GraphQL errors: ${run.live?.errors?.length??0}.`,evidence:'walkthrough.json#live'};
 if(p.kind==='launcher')return {status:run.inventory?.length&&run.apps.length===run.inventory.length&&run.apps.every(app=>app.opened)?'met':'not met',reason:`${run.apps.filter(app=>app.opened).length} of ${run.inventory?.length??0} launcher apps opened.`,evidence:'walkthrough.json#apps'};
 if(p.kind==='action'){
  const action=run.actions?.[p.action];
  if(!action)return {status:'not checkable yet',reason:run.fatal??'The browser action did not run.'};
  return {status:action.ok===true?'met':'not met',reason:action.ok===true?(action.reason??'The browser action and its persisted result were verified.'):action.error??'The browser action result differed from the expected record.',evidence:action.screenshot??'walkthrough.json#actions'};
 }
 if(p.kind==='ui'){
  const app=run.apps.find(app=>app.title===p.app);
  if(!app?.opened)return {status:run.fatal?'not checkable yet':'not met',reason:app?.error??run.fatal??`${p.app} was not reached from the launcher.`};
  const text=[app.text,app.detailText].filter(Boolean).join('\n'),missing=p.contains.filter(value=>!text.includes(value));
  const failed=missing.length>0||!p.contains.length&&app.unavailable;
  return {status:failed?'not met':'met',reason:failed?(missing.length?`Not displayed: ${missing.join('; ')}`:text.split('\n').filter(line=>/unavailable|couldn.t load/i.test(line)).join(' ')):`Displayed ${p.contains.length?p.contains.join('; '):'the app without an unavailable screen'}. This checks visibility only.`,evidence:app.screenshot};
 }
 throw Error(`Unknown probe kind: ${p.kind}`);
}
const emptyCounts=()=>({'met':0,'not met':0,'not checkable yet':0});
export function summarizePages(pages){
 return pages.map(page=>{
  const counts=emptyCounts();for(const promise of page.promises)counts[promise.status]++;
  return {page:page.page,title:page.title,ownerTask:page.ownerTask,counts,
   status:counts['not met']?'not met':counts['not checkable yet']?'not checkable yet':'met'};
 });
}
export function rebuildReport(run,out){
 const dir=join(root,'docs/rebuild-checklists'),pages=[];
 for(const file of readdirSync(dir).filter(file=>file.endsWith('.json')).sort()){
  const page=JSON.parse(readFileSync(join(dir,file),'utf8'));
  const current=hash(readFileSync(join(root,`docs/how-it-works/site/${page.page}.html`)));
  const stale=current!==page.sourceSha256;
  pages.push({...page,stale,promises:page.promises.map(p=>({...p,...(stale?{status:'not checkable yet',reason:'Approved source page changed; refresh its checklist before measuring.'}:evaluate(p,run))}))});
 }
 const summary=summarizePages(pages),counts=emptyCounts();
 for(const page of summary)for(const status of Object.keys(counts))counts[status]+=page.counts[status];
 const report={version:1,source:run.source??null,startedAt:run.startedAt,finishedAt:run.finishedAt,counts,summary,exampleGaps:run.example.gaps,fatal:run.fatal,pages};
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 const escape=text=>String(text).replace(/\|/g,'\\|').replace(/\n/g,' ');
 const lines=['# Rebuild against the approved site','',`Met: **${counts.met}** · Not met: **${counts['not met']}** · Not checkable yet: **${counts['not checkable yet']}**`,'','This is a measurement, not a release gate. Unexercised behavior remains unknown.','The JSON and screenshots beside this report are the evidence. Broad prose is kept whole;','a visible control does not prove that its action works. Source hashes detect page drift.','',`Started: ${run.startedAt}. Finished: ${run.finishedAt??'interrupted'}.`,'',`Tested commit: ${escape(run.source?.commit??'not recorded')} · Ref: ${escape(run.source?.ref??'not recorded')} · Run: ${escape(run.source?.run??'not recorded')} · Attempt: ${escape(run.source?.attempt??'not recorded')}`,'','## Example-data gaps','',...run.example.gaps.map(g=>`- **${g.page}**: ${g.promise}. ${g.reason}`),'','## Browser errors','',...['consoleErrors','pageErrors','networkErrors','errors'].map(key=>`- ${key}: ${JSON.stringify(run[key]??[])}`),''];
 lines.push('## Page summary','',
  'Read **Not met** as an observed failure and **Not checkable yet** as a coverage gap, not a pass.',
  'A page is met only when every listed promise is met. One failed promise makes it not met;',
  'otherwise any untested promise leaves the page not checkable yet. Counts are promises, not percentages.',
  'Follow a page below for the exact promises and their screenshot or raw evidence. Send failures to its owning task.','',
  '| Site page | Owning task | Page result | Met | Not met | Not checkable yet |',
  '| --- | --- | --- | ---: | ---: | ---: |',
  ...summary.map(page=>`| [${escape(page.title)}](#page-${page.page}) | ${page.ownerTask} | ${page.status} | ${page.counts.met} | ${page.counts['not met']} | ${page.counts['not checkable yet']} |`),'');
 for(const page of pages){
  lines.push(`<a id="page-${page.page}"></a>`,'',`## ${page.title}`,'',`Source: [approved page](https://github.com/sleepunit-agents/loom/blob/next/docs/how-it-works/site/${page.page}.html) · Owning task: ${page.ownerTask}${page.stale?' · SOURCE CHANGED':''}`,'','| Status | Promise | Evidence / limit |','| --- | --- | --- |',...page.promises.map(p=>`| ${p.status} | ${escape(p.promise)} | ${escape(p.reason)}${p.evidence?` ([evidence](${p.evidence}))`:''} |`),'');
 }
 writeFileSync(join(out,'report.md'),lines.join('\n'));
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=resolve(process.argv[2]??'walkthrough-artifacts');const run=JSON.parse(readFileSync(join(out,'walkthrough.json'),'utf8'));
 console.log(JSON.stringify(rebuildReport(run,out).counts));
}
