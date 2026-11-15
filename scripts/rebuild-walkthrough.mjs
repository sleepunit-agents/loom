/** Real built startup and first-run sign-in. No seeded session or mock transport. */
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {workVisibility} from './rebuild-work-visibility.mjs';
import {changeActions,changeInline} from './rebuild-change-actions.mjs';
import {bridgeSettingsAction} from './rebuild-bridge-actions.mjs';
import {taskStructure} from './rebuild-task-structure.mjs';
import {taskActions} from './rebuild-task-actions.mjs';
import {conversationActions} from './rebuild-conversation-actions.mjs';
import {knowledgeActions} from './rebuild-memory-actions.mjs';
import {rebuildReport} from './rebuild-report.mjs';
import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

export const redact=text=>String(text).replace(/(\/login\/)[^\s"'<>\\)]+/g,'$1[redacted]').replace(/(Bearer\s+|loom_ui=)[^\s;"'<>\\)]+/gi,'$1[redacted]').replace(/AGE-SECRET-KEY-[A-Z0-9-]+/g,'[private key redacted]');
export const safeReport=report=>JSON.parse(JSON.stringify(report,(_key,value)=>typeof value==='string'?redact(value):value));
/** Browser HTTP/WS may reach only this newly started loopback listener. */
export function localRequest(url,origin){try{return new URL(url).origin===origin||/^(data:|blob:|about:)/.test(url);}catch{return false;}}
/** A second disposable loopback listener proves both browser guards before
 * the sign-in link is opened. It contains no data and receives no credentials. */
async function verifyIsolation(page){
 let http=0,websocket=0;
 const trap=createServer((_request,response)=>{http++;response.setHeader('access-control-allow-origin','*');response.end('local isolation trap');});
 const ws=new WebSocketServer({server:trap});ws.on('connection',socket=>{websocket++;socket.close();});
 await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
 try{
  const origin=`http://127.0.0.1:${trap.address().port}`;
  await page.evaluate(async origin=>{
   console.error('Walkthrough console capture probe');
   await new Promise(resolve=>{const socket=new WebSocket(origin.replace(/^http/,'ws'));socket.onerror=()=>resolve();socket.onclose=()=>resolve();socket.onopen=()=>{socket.close();resolve();};});
  },origin);
  await page.goto(origin).catch(()=>{});
  if(http||websocket)throw Error('Browser isolation failed: a request reached the second local listener');
  return {http:'blocked',websocket:'blocked'};
 }finally{ws.close();trap.closeAllConnections();await new Promise(resolve=>trap.close(resolve));}
}
export async function* walkthroughSteps(output) {
 const out=resolve(output);mkdirSync(out,{recursive:true});
 const parent=mkdtempSync(join(tmpdir(),'loom-walkthrough-')),home=join(parent,'home');
 const report={version:1,source:{commit:process.env.GITHUB_SHA??null,ref:process.env.GITHUB_REF??null,repository:process.env.GITHUB_REPOSITORY??null,run:process.env.GITHUB_RUN_ID??null,attempt:process.env.GITHUB_RUN_ATTEMPT??null},startedAt:new Date().toISOString(),example:{gaps:[]},signin:{ok:false},apps:[],errors:[]};
 let app,browser,page,phase='first-run',navigation=0;
 const sockets=[];
 const consoleErrors=[],pageErrors=[],networkErrors=[],frames=[],subscriptions=[],connections=new Set();
 const save=()=>writeFileSync(join(out,'walkthrough.json'),JSON.stringify(safeReport(report),null,2)+'\n');
 try {
  report.example=await exampleHome(home);
  let link='';app=await startSharedHome({home,port:0,stdout:text=>{link=text.trim();},reportError:error=>report.errors.push(String(error))});
  browser=await chromium.launch({headless:true,...(process.env.LOOM_TEST_CHROME?{executablePath:process.env.LOOM_TEST_CHROME}:{})});
  const context=await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'block'});
  await context.route('**/*',route=>localRequest(route.request().url(),app.url)?route.continue():route.abort('blockedbyclient'));
  const socketOrigin=app.url.replace(/^http/,'ws');
  await context.routeWebSocket(url=>new URL(url).origin!==socketOrigin,route=>route.close({code:1008,reason:'Walkthrough is local only'}));
  page=await context.newPage();page.setDefaultTimeout(8000);
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigation++;});
  page.on('websocket',socket=>{const row={path:new URL(socket.url()).pathname,phase,navigation,closeObserved:false,errorObserved:false};sockets.push(row);socket.on('socketerror',()=>{row.errorObserved=true;});connections.add(socket);socket.on('close',()=>{row.closeObserved=true;connections.delete(socket);});});
  page.on('console',event=>{if(event.type()==='error')consoleErrors.push(event.text());});
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('requestfailed',request=>{const url=new URL(request.url());networkErrors.push({path:url.pathname.startsWith('/login/')?'/login/[redacted]':url.pathname,error:request.failure()?.errorText});});
  page.on('websocket',socket=>{if(new URL(socket.url()).pathname!=='/graphql')return;socket.on('framesent',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.type==='subscribe')subscriptions.push({id:frame.id,query:frame.payload?.variables?.query??frame.payload?.query});}catch{}});socket.on('framereceived',event=>{try{const frame=JSON.parse(String(event.payload));frames.push({type:frame.type,id:frame.id,hasData:!!frame.payload?.data,errors:frame.payload?.errors??(frame.type==='error'?frame.payload:undefined)});}catch{frames.push({type:'unparseable'});}});});
  const isolationErrors=consoleErrors.length;
  const probe=await context.newPage();probe.on('console',event=>{if(event.type()==='error')consoleErrors.push(event.text());});
  try{report.isolation=await verifyIsolation(probe);}finally{await probe.close();}
  report.isolation.consoleErrors=consoleErrors.splice(isolationErrors);
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
  yield {phase:'ready',report:safeReport(report)};
  const ready=label=>{const tile=[...document.querySelectorAll('[data-tile]')].find(node=>node.getAttribute('aria-label')===label);const body=tile?.querySelector('.next-page');return !!body?.textContent?.trim()&&!/Opening [^\n]*…|Loading[^\n]*…|Connecting[^\n]*…/.test(body.textContent);};
  const details={'Tasks':['Goal'],'Approvals':['Exactly what this allows'],'Changes':['Description'],'Inbox':['If yes'],'Tempo':['Words'],'Comms':['Spend up to 180 example dollars on the pump?'],'Agents':['DESCRIPTION']};
  const selections={'Tasks':'Measure the hose','Approvals':'Inspect the example pump','Changes':'Plan the pump repair (t-1)','Inbox':'Spend up to 180 example dollars on the pump?','Tempo':'Continue the pump inspection','Comms':'Repair the garden pump','Agents':'Fern'};
  for(const [index,title] of titles.entries()) {
   phase=title;
   const start={console:consoleErrors.length,page:pageErrors.length,network:networkErrors.length,frames:frames.length};
   const row={title,opened:false,text:'',consoleErrors:[],pageErrors:[],networkErrors:[],live:{frames:[]},screenshot:`${String(index+2).padStart(2,'0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`};
   try {
    await openLauncher();
    const button=title==='Your account'?launcher.getByRole('button',{name:'Open your account',exact:true}):launcher.locator('.loom-lapp').filter({has:page.locator('.loom-lapp__nm',{hasText:new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`)})});
    await button.click();
    const tile=page.getByRole('region',{name:`${title} tile`,exact:true});await tile.waitFor();
    await page.waitForFunction(ready,`${title} tile`);
    row.opened=true;row.text=await tile.innerText();row.path=new URL(page.url()).pathname;
    row.unavailable=/unavailable|couldn.t load/i.test(row.text);
    if(selections[title]){
     row.selection=selections[title];
     try{
      await tile.getByText(selections[title],{exact:true}).first().click();
      await page.waitForFunction(ready,`${title} tile`);
      for(const text of details[title]??[])await tile.getByText(text,{exact:true}).first().waitFor();
      if(title==='Comms')await tile.getByRole('region',{name:'Work in this conversation',exact:true}).getByText('Compare garden pumps',{exact:false}).waitFor();
     }catch(error){row.selectionError=String(error);}
     row.detailText=await tile.innerText();
    }
    if(title==='Bridges'){row.action=await bridgeSettingsAction({page,tile,out});report.actions={...report.actions,bridgeSettings:row.action};}
    if(title==='Knowledge')row.action=await knowledgeActions({page,tile,out,connections});
    await page.screenshot({path:join(out,row.screenshot),fullPage:true});
   }catch(error){row.error=String(error);row.text=await page.locator('.next-tile[data-focused] .next-page').innerText().catch(()=>page.locator('body').innerText());await page.screenshot({path:join(out,row.screenshot),fullPage:true}).catch(()=>{});}
   if(title==='Changes'&&row.opened)report.actions={...report.actions,...await changeActions({page,tile:page.getByRole('region',{name:'Changes tile',exact:true}),app,example:report.example,out})};
   if(title==='Comms'&&row.opened)report.actions={...report.actions,...await changeInline({page,tile:page.getByRole('region',{name:'Comms tile',exact:true}),app,example:report.example,out})};
   if(title==='Changes'&&row.opened)report.actions={...report.actions,...await workVisibility({page,app,example:report.example,out})};
   if(title==='Tasks'&&row.opened){report.actions={...report.actions,...await taskActions({page,tile:page.getByRole('region',{name:'Tasks tile',exact:true}),app,example:report.example,out}),...await taskStructure({page,tile:page.getByRole('region',{name:'Tasks tile',exact:true}),app,example:report.example,out})};}
   row.consoleErrors=consoleErrors.slice(start.console);row.pageErrors=pageErrors.slice(start.page);row.networkErrors=networkErrors.slice(start.network);
   const visitFrames=frames.slice(start.frames);
   row.live={frames:visitFrames,subscriptions:subscriptions.filter(sub=>visitFrames.some(frame=>frame.id===sub.id)),scope:'Connection activity during this visit, including shell and other tiles; not app-specific proof',connectionDataReceived:visitFrames.some(frame=>frame.hasData),errors:visitFrames.flatMap(frame=>frame.errors??[])};
   report.apps.push(row);save();yield {phase:'app',row:safeReport(row),report:safeReport(report)};
  }
  phase='conversation actions';
  report.actions={...report.actions,...await conversationActions({page,app,example:report.example,out,open:async title=>{await openLauncher();const button=launcher.locator('.loom-lapp').filter({has:page.locator('.loom-lapp__nm',{hasText:new RegExp('^'+title+'$')})});await button.waitFor({state:'visible'});await button.focus();await page.keyboard.press('Enter');await launcher.waitFor({state:'hidden'});const tile=page.getByRole('region',{name:title+' tile',exact:true});await tile.waitFor({state:'visible'});return tile;}})};
  save();yield {phase:'actions',actions:safeReport(report.actions)};
 }catch(error){report.fatal=String(error);}
 finally{report.transport={sockets};report.consoleErrors=consoleErrors;report.pageErrors=pageErrors;report.networkErrors=networkErrors;report.live={frames:frames.length,dataFrames:frames.filter(frame=>frame.hasData).length,errors:frames.flatMap(frame=>frame.errors??[]),subscriptions};await browser?.close().catch(error=>report.errors.push(String(error)));await app?.close().catch(error=>report.errors.push(String(error)));rmSync(parent,{recursive:true,force:true});report.finishedAt=new Date().toISOString();save();rebuildReport(safeReport(report),out);}
 return safeReport(report);
}
export async function walkthrough(output){
 const steps=walkthroughSteps(output);let step;
 do{step=await steps.next();}while(!step.done);
 return step.value;
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const report=await walkthrough(process.argv[2]??'walkthrough-artifacts');
 console.log(JSON.stringify({signin:report.signin,apps:report.apps.map(({title,opened,unavailable,error})=>({title,opened,unavailable,error})),live:report.live?{frames:report.live.frames,dataFrames:report.live.dataFrames,errors:report.live.errors}:undefined,fatal:report.fatal},null,2));
 if(report.fatal||!report.apps.length)process.exitCode=1;
}
