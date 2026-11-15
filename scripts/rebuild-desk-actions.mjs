/** Measure the approved desk through the running shell; never import its layout rule. */
import {join} from 'node:path';
export async function deskActions({page,out,inventory}) {
 const evidence={};let phase;
 const attempt=async(name,run)=>{
  const screenshot=`action-${name}.png`;
  try{const facts=await run();evidence[name]={ok:true,...facts,screenshot};}
  catch(error){evidence[name]={ok:false,phase,error:String(error),screenshot};}
  await page.screenshot({path:join(out,screenshot),fullPage:true});
 };
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const launcher=page.getByRole('dialog',{name:'Apps',exact:true});
 const tile=name=>page.getByRole('region',{name:`${name} tile`,exact:true});
 const launch=async name=>{
  phase='launch '+name+' from '+new URL(page.url()).pathname;
  await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+Space');await launcher.waitFor();
  await launcher.getByRole('textbox',{name:'Find an app',exact:true}).fill(name);
  const matches=await launcher.locator('.loom-lapp__nm').allTextContents();
  check(matches[0]===name,`First launcher match for ${name}: ${JSON.stringify(matches)}`);
  await launcher.getByRole('textbox',{name:'Find an app',exact:true}).press('Enter');await launcher.waitFor({state:'hidden'});await tile(name).waitFor();
 };
 const clear=async()=>{
  await page.keyboard.press('Escape');
  for(const name of await page.locator('[data-tile]:visible').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label').replace(/ tile$/,''))))await tile(name).getByRole('button',{name:`Close ${name}`,exact:true}).click();
 };
 const boxes=()=>page.locator('[data-tile]:visible').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{name:n.getAttribute('aria-label'),x:r.x,y:r.y,w:r.width,h:r.height};}));
 const snapshot=async()=>{
  await page.locator('[data-tile]:visible').evaluateAll(nodes=>Promise.all(nodes.flatMap(node=>node.getAnimations().map(animation=>animation.finished.catch(()=>{})))));
  const rows=await boxes();check(rows.length>0,'No visible tiles');
  const ground=await page.locator('.next-ground').boundingBox();
  for(const a of rows){
   check(a.w>0&&a.h>0&&a.x>=ground.x-1&&a.y>=ground.y-1&&a.x+a.w<=ground.x+ground.width+1&&a.y+a.h<=ground.y+ground.height+1,`Tile outside the desk: ${JSON.stringify(a)}`);
   for(const b of rows)if(a!==b)check(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)<=1||Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)<=1,`Overlapping tiles: ${a.name}, ${b.name}`);
  }
  const right=Math.max(...rows.map(a=>a.x+a.w)),bottom=Math.max(...rows.map(a=>a.y+a.h));
  const railNode=page.getByRole('complementary',{name:'Your agents',exact:true});
  const rail=await railNode.count()?await railNode.boundingBox():null;
  const edgeNode=page.getByRole('button',{name:'Show agents rail',exact:true});
  const edge=await edgeNode.count()?await edgeNode.boundingBox():null;
  const expectedRight=rail?rail.x-10:edge?edge.x-10:ground.x+ground.width;
  check(Math.abs(Math.min(...rows.map(a=>a.x))-ground.x)<=1&&Math.abs(Math.min(...rows.map(a=>a.y))-ground.y)<=1&&Math.abs(right-expectedRight)<=1&&Math.abs(bottom-(ground.y+ground.height))<=1,'Tiles do not fill the available desk bounds');
  return rows;
 };
 await attempt('deskLauncher',async()=>{
  await clear();await page.keyboard.press('Control+Shift+Space');await launcher.waitFor();
  const groups=await launcher.locator('.loom-lsec').count();check(groups>1,'Launcher apps are not grouped');
  await page.keyboard.press('Escape');await launcher.waitFor({state:'hidden'});
  const missing=[];
  for(const name of inventory){const label=name==='Home'?'Home':`Open ${name}`;if(!await page.locator('.next-dock').getByRole('button',{name:label,exact:true}).count())missing.push(name);}
  check(!missing.length,`Apps missing from dock: ${missing.join(', ')}`);
  await page.keyboard.press('Escape');await launch('Tasks');
  return{reason:'Launcher groups and dock inventory matched; typing Tasks and pressing Enter opened its tile.',groups,inventory,search:'Tasks',enterOpened:'Tasks'};
 });
 await attempt('deskLayout',async()=>{
  await clear();await page.setViewportSize({width:1920,height:900});
  await launch('Tasks');await launch('Inbox');
  await page.waitForFunction(()=>{const a=document.querySelector('[aria-label="Tasks tile"]')?.getBoundingClientRect(),b=document.querySelector('[aria-label="Inbox tile"]')?.getBoundingClientRect();return a&&b&&a.right<=b.left;});
  const wide=await snapshot();
  await page.setViewportSize({width:1100,height:1500});
  await page.waitForFunction(()=>{const a=document.querySelector('[aria-label="Tasks tile"]')?.getBoundingClientRect(),b=document.querySelector('[aria-label="Inbox tile"]')?.getBoundingClientRect();return a&&b&&a.bottom<=b.top;});
  const tall=await snapshot();
  const geometryShot='action-deskGeometry.png';await page.screenshot({path:join(out,geometryShot),fullPage:true});
  evidence.deskGeometry={ok:true,reason:'Wide and tall tile bounds filled the available desk without overlap.',wide,tall,screenshot:geometryShot};
  await page.setViewportSize({width:1920,height:900});
  await tile('Inbox').getByRole('button',{name:'Make Inbox big',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Inbox tile"]').getBoundingClientRect().left<document.querySelector('[aria-label="Tasks tile"]').getBoundingClientRect().left);
  const promoted=await snapshot();
  phase='minimize Inbox';await tile('Inbox').getByRole('button',{name:'Minimize Inbox',exact:true}).click();await tile('Inbox').waitFor({state:'hidden'});
  phase='restore Inbox from dock';await page.locator('.next-dock').getByRole('button',{name:'Open Inbox',exact:true}).click();await tile('Inbox').waitFor();
  phase='close Inbox';await tile('Inbox').getByRole('button',{name:'Close Inbox',exact:true}).click();await tile('Inbox').waitFor({state:'detached'});
  // A two-tile screen: make Tasks older than Inbox, then open a third app.
  phase='start eviction';await page.setViewportSize({width:1100,height:1500});await launch('Inbox');await launch('Approvals');
  await tile('Tasks').waitFor({state:'hidden'});check(await tile('Inbox').isVisible()&&await tile('Approvals').isVisible(),'The most recently used tiles did not remain');
  const evicted=await snapshot();phase='restore evicted Tasks';await page.locator('.next-dock').getByRole('button',{name:'Open Tasks',exact:true}).click();await tile('Tasks').waitFor();
  return{reason:'Wide and tall tile bounds filled the desk without overlap; promotion, minimize/restore, close, and least-recently-used eviction worked.',wide,tall,promoted,minimizedRestored:true,closedRemoved:true,leastRecentlyUsed:'Tasks',evicted};
 });
 if(!evidence.deskGeometry)evidence.deskGeometry={ok:false,error:evidence.deskLayout?.error,phase:evidence.deskLayout?.phase,screenshot:evidence.deskLayout?.screenshot};
 await page.setViewportSize({width:1600,height:1000});
 return evidence;
}
