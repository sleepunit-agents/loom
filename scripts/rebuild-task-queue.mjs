/** Exercise a nontrivial queue through application operations and browser rows. */
import {join} from 'node:path';
export async function taskQueue({page,tile,app,example,out}){
 const evidence={},service=app.services.tasks,actor={kind:'agent',id:'fern'};
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await page.screenshot({path:join(out,screenshot),fullPage:true});};
 const create=(title,priority,type='task',parent)=>app.writes.run(()=>service.create({title,priority,type,goal:'Measure fictional queue behavior.',why:'Exercise the approved Tasks page.',owner:{kind:'agent',id:'fern'},source:{kind:'conversation',id:example.conversation},...(parent?{parent}: {})},actor)).value;
 const parent=create('Fictitious garden work group',0,'epic'),otherParent=create('Other fictitious group',0,'epic');
 const urgent=create('Urgent fictitious hose leak',0),blocker=create('Release the fictitious valve',1),ordinary=create('Paint the fictitious shed',4),child=create('Fit the fictitious hose',2,'task',parent.id);
 app.writes.run(()=>service.link(child.id,blocker.id,'blocks'));
 const back=async()=>{const button=tile.locator('.loom-split__back:visible');if(await button.count())await button.click();};
 const visibleTitles=()=>tile.getByRole('list',{name:'Task list',exact:true}).locator('[data-split-row]:visible .loom-kit-title').allTextContents();
 await attempt('taskQueue',async()=>{
  await back();await tile.getByRole('button',{name:/^Ready(?:\s|$)/}).first().click();
  await tile.getByRole('list',{name:'Task list',exact:true}).locator('[data-split-row]:visible').filter({hasText:urgent.title}).waitFor();
  const before=await visibleTitles();check(JSON.stringify(before)===JSON.stringify([urgent.title,blocker.title,ordinary.title]),`Ready queue order/content differed: ${JSON.stringify(before)}`);
  let refused=false;try{app.writes.run(()=>service.link(child.id,otherParent.id,'parent-child'));}catch{refused=true;}
  check(refused&&service.get(child.id).links.filter(link=>link.type==='parent-child').length===1,'A second parent was accepted');
  await tile.getByRole('list',{name:'Task list',exact:true}).locator('[data-split-row]:visible').filter({hasText:blocker.title}).click();
  await tile.getByRole('button',{name:'Close',exact:true}).click();
  const form=page.getByRole('dialog').getByRole('form');await form.getByLabel('Reason (cancelled marks it cancelled)',{exact:true}).fill('The fictitious valve is released.');
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks/command'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await form.getByRole('button',{name:'Close task',exact:true}).click();const result=await pending,body=await result.json();check(result.ok()&&body.ok===true,'Closing the blocker was refused');await form.waitFor({state:'hidden'});
  await back();await tile.getByRole('list',{name:'Task list',exact:true}).locator('[data-split-row]:visible').filter({hasText:child.title}).waitFor();
  const after=await visibleTitles();check(JSON.stringify(after)===JSON.stringify([urgent.title,child.title,ordinary.title]),`Closing the blocker did not release the child: ${JSON.stringify(after)}`);
  await tile.getByRole('list',{name:'Task list',exact:true}).locator('[data-split-row]:visible').filter({hasText:child.title}).click();
  check((await tile.innerText()).includes(parent.title),'Child did not display its parent');
  return{reason:'Ready was urgency-ordered, excluded epics and blocked work, released the child when its blocker closed, and refused a second parent.',before,after,parent:parent.id,child:child.id};
 });
 await attempt('taskComments',async()=>{
  app.writes.run(()=>{service.comment(child.id,'Fern measured the fictional hose.',actor);service.comment(child.id,'Alex confirmed the fictional measurement.',{kind:'member',id:'alex'});});
  await back();await tile.getByRole('list',{name:'Task list',exact:true}).locator('[data-split-row]:visible').filter({hasText:child.title}).click();
  await tile.getByText('Alex confirmed the fictional measurement.',{exact:true}).waitFor();
  const section=tile.locator('section').filter({has:page.getByRole('heading',{name:'Comments',exact:true})});
  const comments=await section.locator('li').evaluateAll(nodes=>nodes.map(node=>({text:node.innerText,at:node.querySelector('time')?.dateTime})));
  check(comments.length===2&&comments[0].text.includes('agent fern')&&comments[0].text.includes('Fern measured')&&comments[1].text.includes('member alex')&&comments[1].text.includes('Alex confirmed')&&comments.every(row=>Number.isFinite(Date.parse(row.at))),'Comments omitted order, actor or time');
  return{reason:'Agent and member comments displayed oldest first with their respective authors and timestamps.',comments};
 });
 return evidence;
}
