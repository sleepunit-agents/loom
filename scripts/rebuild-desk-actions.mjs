/** Measure the approved desk through the running shell; never import its layout rule. */
import {join} from 'node:path';
export async function deskActions({page,out,inventory}) {
 const evidence={};
 const attempt=async(name,run)=>{
  const screenshot=`action-${name}.png`;
  try{const facts=await run();evidence[name]={ok:true,...facts,screenshot};}
  catch(error){evidence[name]={ok:false,error:String(error),screenshot};}
  await page.screenshot({path:join(out,screenshot),fullPage:true});
 };
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const launcher=page.getByRole('dialog',{name:'Apps',exact:true});
 const tile=name=>page.getByRole('region',{name:`${name} tile`,exact:true});
 const launch=async name=>{
  await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+Space');await launcher.waitFor();
  await launcher.getByRole('textbox',{name:'Find an app',exact:true}).fill(name);
  const matches=await launcher.locator('.loom-lapp__nm').allTextContents();
  check(matches[0]===name,`First launcher match for ${name}: ${JSON.stringify(matches)}`);
  await page.keyboard.press('Enter');await launcher.waitFor({state:'hidden'});await tile(name).waitFor();
 };
 const clear=async()=>{
  await page.keyboard.press('Escape');
  for(const name of await page.locator('[data-tile]:visible').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label').replace(/ tile$/,''))))await tile(name).getByRole('button',{name:`Close ${name}`,exact:true}).click();
 };
 const boxes=()=>page.locator('[data-tile]:visible').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{name:n.getAttribute('aria-label'),x:r.x,y:r.y,w:r.width,h:r.height};}));
 const snapshot=async()=>{
  const rows=await boxes();check(rows.length>0,'No visible tiles');
  const ground=await page.locator('.next-ground').boundingBox();
  for(const a of rows){
   check(a.w>0&&a.h>0&&a.x>=ground.x-1&&a.y>=ground.y-1&&a.x+a.w<=ground.x+ground.width+1&&a.y+a.h<=ground.y+ground.height+1,`Tile outside the desk: ${JSON.stringify(a)}`);
   for(const b of rows)if(a!==b)check(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)<=1||Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)<=1,`Overlapping tiles: ${a.name}, ${b.name}`);
  }
  const right=Math.max(...rows.map(a=>a.x+a.w)),bottom=Math.max(...rows.map(a=>a.y+a.h));
  const rail=await page.getByRole('complementary',{name:'Your agents',exact:true}).boundingBox();
  const expectedRight=rail?rail.x-10:ground.x+ground.width;
  check(Math.abs(Math.min(...rows.map(a=>a.x))-ground.x)<=1&&Math.abs(Math.min(...rows.map(a=>a.y))-ground.y)<=1&&Math.abs(right-expectedRight)<=1&&Math.abs(bottom-(ground.y+ground.height))<=1,'Tiles do not fill the available desk bounds');
  return rows;
 };
 await attempt('deskLauncher',async()=>{
  await clear();await page.keyboard.press('Control+Shift+Space');await launcher.waitFor();
  const groups=await launcher.locator('.loom-lsec').count();check(groups>1,'Launcher apps are not grouped');
  const missing=[];
  for(const name of inventory){const label=name==='Home'?'Home':`Open ${name}`;if(!await page.locator('.next-dock').getByRole('button',{name:label,exact:true}).count())missing.push(name);}
  check(!missing.length,`Apps missing from dock: ${missing.join(', ')}`);
  await page.keyboard.press('Escape');await launch('Tasks');
  return{groups,inventory,search:'Tasks',enterOpened:'Tasks'};
 });
 await attempt('deskLayout',async()=>{
  await clear();await page.setViewportSize({width:1920,height:900});
  await launch('Tasks');await launch('Inbox');
  await page.waitForFunction(()=>{const a=document.querySelector('[aria-label="Tasks tile"]')?.getBoundingClientRect(),b=document.querySelector('[aria-label="Inbox tile"]')?.getBoundingClientRect();return a&&b&&a.right<=b.left;});
  const wide=await snapshot();
  await page.setViewportSize({width:1100,height:1500});
  await page.waitForFunction(()=>{const a=document.querySelector('[aria-label="Tasks tile"]')?.getBoundingClientRect(),b=document.querySelector('[aria-label="Inbox tile"]')?.getBoundingClientRect();return a&&b&&a.bottom<=b.top;});
  const tall=await snapshot();
  await page.setViewportSize({width:1920,height:900});
  await tile('Inbox').getByRole('button',{name:'Make Inbox big',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Inbox tile"]').getBoundingClientRect().left<document.querySelector('[aria-label="Tasks tile"]').getBoundingClientRect().left);
  const promoted=await snapshot();
  await tile('Inbox').getByRole('button',{name:'Minimize Inbox',exact:true}).click();await tile('Inbox').waitFor({state:'hidden'});
  await page.locator('.next-dock').getByRole('button',{name:'Open Inbox',exact:true}).click();await tile('Inbox').waitFor();
  await tile('Inbox').getByRole('button',{name:'Close Inbox',exact:true}).click();await tile('Inbox').waitFor({state:'detached'});
  // A two-tile screen: make Tasks older than Inbox, then open a third app.
  await page.setViewportSize({width:1100,height:1500});await launch('Inbox');await launch('Approvals');
  await tile('Tasks').waitFor({state:'hidden'});check(await tile('Inbox').isVisible()&&await tile('Approvals').isVisible(),'The most recently used tiles did not remain');
  const evicted=await snapshot();await page.locator('.next-dock').getByRole('button',{name:'Open Tasks',exact:true}).click();await tile('Tasks').waitFor();
  return{wide,tall,promoted,minimizedRestored:true,closedRemoved:true,leastRecentlyUsed:'Tasks',evicted};
 });
 await page.setViewportSize({width:1600,height:1000});
 return evidence;
}
