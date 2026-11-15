/** Real built startup and first-run sign-in. No seeded session or mock transport. */
import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

export async function walkthrough(output) {
 const out=resolve(output);mkdirSync(out,{recursive:true});
 const parent=mkdtempSync(join(tmpdir(),'loom-walkthrough-')),home=join(parent,'home');
 const report={version:1,startedAt:new Date().toISOString(),example:await exampleHome(home),signin:{ok:false},apps:[],errors:[]};
 let app,browser,page;
 const save=()=>writeFileSync(join(out,'walkthrough.json'),JSON.stringify(report,null,2)+'\n');
 try {
  let link='';app=await startSharedHome({home,port:0,stdout:text=>{link=text.trim();},reportError:error=>report.errors.push(String(error))});
  browser=await chromium.launch({headless:true,...(process.env.LOOM_TEST_CHROME?{executablePath:process.env.LOOM_TEST_CHROME}:{})});
  const context=await browser.newContext({viewport:{width:1600,height:1000}});page=await context.newPage();page.setDefaultTimeout(8000);
  const consoleErrors=[],pageErrors=[],networkErrors=[],frames=[];
  page.on('console',event=>{if(event.type()==='error')consoleErrors.push(event.text());});
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('requestfailed',request=>{const url=new URL(request.url());networkErrors.push({path:url.pathname.startsWith('/login/')?'/login/[redacted]':url.pathname,error:request.failure()?.errorText});});
  page.on('websocket',socket=>{if(new URL(socket.url()).pathname!=='/graphql')return;socket.on('framereceived',event=>{try{const frame=JSON.parse(String(event.payload));frames.push({type:frame.type,id:frame.id,hasData:!!frame.payload?.data,errors:frame.payload?.errors??(frame.type==='error'?frame.payload:undefined)});}catch{frames.push({type:'unparseable'});}});});
  await page.goto(app.url);await page.getByRole('heading',{name:'Sign in to loom',exact:true}).waitFor();
  await page.screenshot({path:join(out,'00-signin.png'),fullPage:true});
  await page.goto(link);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();report.signin.ok=true;
  await page.screenshot({path:join(out,'01-desk.png'),fullPage:true});
  const openLauncher=async()=>{await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+Space');await page.getByRole('dialog',{name:'Apps',exact:true}).waitFor();};
  await openLauncher();
  const launcher=page.getByRole('dialog',{name:'Apps',exact:true});
  const titles=await launcher.locator('.loom-lapp__nm').allTextContents();
  if(await launcher.getByRole('button',{name:'Open your account',exact:true}).count()&&!titles.includes('Your account'))titles.push('Your account');
  report.inventory=titles;
  await page.keyboard.press('Escape');
  const selections={'Tasks':'Measure the hose','Approvals':'Inspect the example pump','Changes':'Plan the pump repair (t-1)','Inbox':'Spend up to 180 example dollars on the pump?','Tempo':'Continue the pump inspection','Comms':'Repair the garden pump','Agents':'Fern'};
  for(const [index,title] of titles.entries()) {
   const start={console:consoleErrors.length,page:pageErrors.length,network:networkErrors.length,frames:frames.length};
   const row={title,opened:false,text:'',consoleErrors:[],pageErrors:[],networkErrors:[],live:{frames:[]},screenshot:`${String(index+2).padStart(2,'0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`};
   try {
    await openLauncher();
    const button=title==='Your account'?launcher.getByRole('button',{name:'Open your account',exact:true}):launcher.locator('.loom-lapp').filter({has:page.locator('.loom-lapp__nm',{hasText:new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`)})});
    await button.click();
    const tile=page.getByRole('region',{name:`${title} tile`,exact:true});await tile.waitFor();
    // Let React commit its initial subscribed snapshot; no fixed sleep.
    await page.waitForFunction(label=>{const tile=[...document.querySelectorAll('[data-tile]')].find(node=>node.getAttribute('aria-label')===label);return tile&&!/^.*(?:Opening [^\n]*…|Loading[^\n]*…|Connecting[^\n]*…)/s.test(tile.innerText);},`${title} tile`);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    row.opened=true;row.text=await tile.innerText();row.path=new URL(page.url()).pathname;
    row.unavailable=/unavailable|couldn.t load/i.test(row.text);
    if(selections[title]){
     row.selection=selections[title];
     try{
      await tile.getByText(selections[title],{exact:true}).first().click();
      await page.waitForFunction(label=>{const node=[...document.querySelectorAll('[data-tile]')].find(node=>node.getAttribute('aria-label')===label);return node&&!/Opening [^\n]*…|Loading[^\n]*…|Connecting[^\n]*…/.test(node.innerText);},`${title} tile`);
      row.detailText=await tile.innerText();
     }catch(error){row.selectionError=String(error);}
    }
    await page.screenshot({path:join(out,row.screenshot),fullPage:true});
   }catch(error){row.error=String(error);await page.screenshot({path:join(out,row.screenshot),fullPage:true}).catch(()=>{});}
   row.consoleErrors=consoleErrors.slice(start.console);row.pageErrors=pageErrors.slice(start.page);row.networkErrors=networkErrors.slice(start.network);
   row.live={frames:frames.slice(start.frames),dataReceived:frames.slice(start.frames).some(frame=>frame.hasData),errors:frames.slice(start.frames).flatMap(frame=>frame.errors??[])};
   report.apps.push(row);save();
  }
  report.consoleErrors=consoleErrors;report.pageErrors=pageErrors;report.networkErrors=networkErrors;
  report.live={frames:frames.length,dataFrames:frames.filter(frame=>frame.hasData).length,errors:frames.flatMap(frame=>frame.errors??[])};
 }catch(error){report.fatal=String(error);}
 finally{await browser?.close();await app?.close();rmSync(parent,{recursive:true,force:true});report.finishedAt=new Date().toISOString();save();}
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const report=await walkthrough(process.argv[2]??'walkthrough-artifacts');
 console.log(JSON.stringify({signin:report.signin,apps:report.apps.map(({title,opened,unavailable,error})=>({title,opened,unavailable,error})),live:report.live,fatal:report.fatal},null,2));
 if(report.fatal||!report.apps.length)process.exitCode=1;
}
