import {join} from 'node:path';
import {browserRead} from './rebuild-conversation-visibility.mjs';

export async function deskTicker({page,app,out}) {
 const screenshot='action-deskTicker.png';
 const ticker=page.locator('.loom-tick__line:not([aria-hidden])');
 const shows=text=>ticker.getByText(text,{exact:true}).waitFor();
 const taskCounts=(active,ready)=>shows(`Tasks · ${active} in progress · ${ready} ready`);
 try {
  const data=await browserRead(page,`{
   tasks(where:{status:{eq:in_progress}}){isShelved} readyTasks{id}
   triggers{enabled state} agentPauses{agent} changes(where:{state:{eq:open}}){checks}
   bridgeConnections{enabled} boxes{id revokedAt} boxReadings(where:{level:{ne:ok}}){box}
  }`);
  const active=data.tasks.filter(row=>!row.isShelved).length, ready=data.readyTasks.length;
  const plural=(n,word)=>n+' '+word+(n===1?'':'s');
  const triggers=data.triggers.filter(t=>t.enabled&&['standing','due','firing','held'].includes(t.state)).length;
  const failed=data.triggers.filter(t=>t.state==='failed').length;
  const red=data.changes.filter(c=>c.checks==='failing').length;
  const boxes=data.boxes.filter(b=>b.revokedAt===null);
  const trouble=boxes.filter(b=>data.boxReadings.some(r=>r.box===b.id)).length;
  const parts=[
   'Tempo · '+plural(triggers,'active trigger')+' · '+plural(data.agentPauses.length,'paused agent')+(failed?' · '+failed+' failed':''),
   'Bridges · '+plural(data.bridgeConnections.filter(c=>c.enabled).length,'enabled connection'),
   'Changes · '+data.changes.length+' open'+(red?' · '+red+' CI red':''),
   boxes.length+' enrolled '+(boxes.length===1?'box':'boxes')+(trouble?' · '+trouble+(trouble===1?' needs':' need')+' a look':'')
  ];
  for(const part of parts)await shows(part);
  await taskCounts(active,ready);
  const actor={kind:'member',id:'alex'};
  const task=app.writes.run(()=>app.services.tasks.create({title:'Count spare fittings',goal:'Exercise the desk ticker.',why:'Check counts as work moves.',owner:actor},actor)).value;
  try {
   await taskCounts(active,ready+1);
   app.writes.run(()=>app.services.tasks.claim(task.id,actor));
   await taskCounts(active+1,ready);
   await page.screenshot({path:join(out,screenshot),fullPage:true});
  } finally {app.writes.run(()=>app.services.tasks.close(task.id,'Desk ticker check complete.'));}
  await taskCounts(active,ready);
  return {ok:true,screenshot,parts,active,ready,reason:'The ticker matched the signed-in member’s Tasks, Tempo, Bridges, Changes and Boxes counts. A new ready task moved to in progress when claimed, and closing it restored both counts.'};
 }catch(error){return{ok:false,error:String(error)};}
}
