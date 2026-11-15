/** Exercise trusted task operations and their live browser projection together. */
import {join} from 'node:path';
export async function taskStructure({page,tile,app,example,out}){
 const s=app.services.tasks,write=fn=>app.writes.run(fn).value,actor={kind:'agent',id:'fern'};
 const check=(v,m)=>{if(!v)throw Error(m);};
 const evidence={};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{await run();await page.screenshot({path:join(out,screenshot),fullPage:true});evidence[name]={ok:true,screenshot};}catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});evidence[name]={ok:false,error:String(error),screenshot};}};
 const make=(title,extra={})=>s.create({title,goal:'Prove the garden work queue.',why:'A fictitious walkthrough.',owner:{kind:'agent',id:'fern'},source:{kind:'conversation',id:example.conversation},...extra},actor);
 let epic,urgent,later,blocked;
 await attempt('taskStructure',async()=>{
  write(()=>{epic=make('Restore the fictitious garden',{type:'epic'});urgent=make('Urgent hose inspection',{priority:0,parent:epic.id});later=make('Later hose inspection',{priority:4});blocked=make('Wait for both inspections',{priority:1,parent:epic.id});s.link(blocked.id,urgent.id,'blocks');s.link(blocked.id,later.id,'blocks');});
  await tile.locator('button:visible').filter({hasText:/^Ready/}).first().click();
  await tile.getByText(urgent.title,{exact:true}).waitFor();await tile.getByText(later.title,{exact:true}).waitFor();
  const titles=await tile.locator('[data-split-row]:visible').allTextContents();
  check(titles.length===2&&titles[0].includes(urgent.title)&&titles[1].includes(later.title),'Ready is not urgent-first or includes epic/blocked work');
  await tile.getByText(urgent.title,{exact:true}).click();
  const reader=tile.getByRole('region',{name:'Tasks: the open item',exact:true});
  await reader.getByText(epic.title,{exact:true}).waitFor();await reader.getByRole('button',{name:'From conversation',exact:true}).waitFor();
  let refused=false;try{write(()=>s.link(urgent.id,later.id,'parent-child'));}catch{refused=true;}
  check(refused&&s.get(urgent.id).links.filter(l=>l.type==='parent-child').length===1,'A second parent was accepted');
  write(()=>{s.close(urgent.id,'Inspected.');});
  check(!s.ready().some(t=>t.id===blocked.id),'One remaining blocker did not hold back work');
  write(()=>s.close(later.id,'Inspected.'));
  await tile.getByText(blocked.title,{exact:true}).waitFor();
  check(s.ready().some(t=>t.id===blocked.id),'Closing both blockers did not release work');
  await tile.getByText(blocked.title,{exact:true}).click();
  await reader.getByText(epic.title,{exact:true}).waitFor();
 });
 await attempt('taskComments',async()=>{
  check(!!blocked,'Structure fixture missing');
  write(()=>{s.claim(blocked.id,actor);s.comment(blocked.id,'Fern checked the hose.',actor);s.comment(blocked.id,'Alex confirmed the hose.',{kind:'member',id:'alex'});});
  const reader=tile.getByRole('region',{name:'Tasks: the open item',exact:true});
  await reader.getByText('Alex confirmed the hose.',{exact:true}).waitFor();
  const comments=reader.locator('section').filter({has:page.getByRole('heading',{name:'Comments',exact:true})});
  const text=await comments.innerText();
  check(text.indexOf('Fern checked the hose.')<text.indexOf('Alex confirmed the hose.')&&text.includes('agent fern')&&text.includes('member alex'),'Comment order/actors missing');
  check(await comments.locator('time[datetime]').count()===2,'Comment times missing');
  check(s.get(blocked.id).assignee==='fern','Agent claim missing');
 });
 // Leave no new ready work to disturb subsequent app visits.
 write(()=>{for(const task of [epic,urgent,later,blocked])if(task&&s.get(task.id).status!=='closed')s.close(task.id,'Walkthrough evidence complete.');});
 return evidence;
}
