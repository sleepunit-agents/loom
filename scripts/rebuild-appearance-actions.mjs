/** Actual Appearance controls, application saves and a browser reload. */
import {join} from 'node:path';
export async function appearanceActions({page,app,out}){
 const evidence={};
 const attempt=async(name,run)=>{const screenshot=`action-${name}.png`;try{evidence[name]={ok:true,...await run(),screenshot};}catch(error){evidence[name]={ok:false,error:String(error),screenshot};}await page.screenshot({path:join(out,screenshot),fullPage:true});};
 const check=(yes,message)=>{if(!yes)throw Error(message);};
 const panel=page.getByLabel('Appearance settings',{exact:true});
 const open=async()=>{if(!await panel.isVisible())await page.locator('.next-preferences > summary').click();await panel.waitFor();};
 const save=async change=>{
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/household/setPreferences'&&r.request().method()==='POST',{timeout:4000});void response.catch(()=>{});
  await change();const result=await response,body=await result.json();check(result.ok()&&body.ok===true,'Appearance save was refused');
  await panel.getByRole('combobox',{name:'Look',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Appearance settings"] select')?.disabled);
 };
 await attempt('deskLooks',async()=>{
  await open();const looks=[];
  for(const [value,label] of [['lowlight','Low Light'],['daylight','Daylight'],['neon','Neon Noir']]){
   await save(()=>panel.getByRole('combobox',{name:'Look',exact:true}).selectOption(value));
   await page.waitForFunction(value=>document.documentElement.dataset.look===value,value);
   const shown=await page.evaluate(()=>({look:document.documentElement.dataset.look,canvas:getComputedStyle(document.documentElement).getPropertyValue('--v-canvas').trim(),shells:document.querySelectorAll('.next-shell').length,grounds:document.querySelectorAll('.next-ground').length,docks:document.querySelectorAll('.next-dock-bar').length}));
   check(shown.shells===1&&shown.grounds===1&&shown.docks===1,`${label} replaced the desk structure`);looks.push({label,...shown});
   await page.screenshot({path:join(out,`look-${value}.png`),fullPage:true});
  }
  check(new Set(looks.map(row=>row.canvas)).size===3,'The three looks did not apply distinct canvas colours');
  return{reason:'Neon Noir, Low Light and Daylight applied distinct colours through saved UI choices over the same desk structure.',looks};
 });
 await attempt('deskAppearance',async()=>{
  await open();
  for(const ground of ['contours','depth','wash']){
   await save(()=>panel.getByRole('combobox',{name:'Ground',exact:true}).selectOption(ground));
   await page.waitForFunction(ground=>document.documentElement.dataset.ground===ground,ground);
  }
  await save(()=>panel.getByRole('combobox',{name:'Reduce motion',exact:true}).selectOption('on'));
  await save(()=>panel.getByRole('combobox',{name:'Higher contrast',exact:true}).selectOption('on'));
  await save(()=>panel.getByRole('checkbox',{name:'One window at a time',exact:true}).check());
  await page.reload();await page.locator('.next-shell').waitFor();
  await page.waitForFunction(()=>{const d=document.documentElement.dataset;return d.ground==='wash'&&d.motion==='reduce'&&d.contrast==='more'&&d.oneWindow==='on';});
  const row=app.services.comms.db.$client.prepare('SELECT * FROM member_preferences WHERE member=?').get('alex');
  check(row?.ground==='wash'&&row.motion==='on'&&row.contrast==='on'&&row.one_window===1,'Appearance choices did not persist for Alex');
  check(await page.locator('[data-tile]:visible').count()===1,'One-window choice did not present one tile');
  return{reason:'All three backgrounds applied; reduced motion, higher contrast and one-window choices survived reload and were stored for Alex.',member:'alex',backgrounds:['contours','depth','wash'],persistedAfterReload:true};
 });
 return evidence;
}
