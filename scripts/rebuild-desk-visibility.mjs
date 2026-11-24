import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {auditDataDoor,installDataProbe} from './rebuild-data-actions.mjs';
import {redactSignin} from './rebuild-conversation-visibility.mjs';

// Only ordinary, fictional data. Disabled bridge connections cannot open provider sockets.
async function addControls(app){
 const s=app.services,write=fn=>app.writes.run(fn).value;
 await s.secrets.values.set({member:'alex',id:randomUUID(),name:'FICTIONAL',description:'Fictitious connector credential',value:'fictional-panel-value',mode:'add'});
 for(const agent of ['fern','moss']){
  const issued=write(()=>s.signin.issue({kind:'agent',agent,label:'Fictitious panel author'}));
  const command=async(name,input)=>{
   const response=await app.http.request('/api/'+name,{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({input,id:randomUUID()})});
   assert.equal((await response.json()).ok,true,name);
  };
  try{
   await command('memory/personWrite',{slug:'panel-'+agent,name:agent+' sample contact',summary:'Fictitious contact'});
   await command('memory/projectWrite',{slug:'panel-'+agent,name:agent+' sample project',summary:'Fictitious project'});
   if(agent==='fern')await command('mind/knowledgeAdd',{title:'Sample orchid fact',domain:'fictional',body:'A fictitious orchid.'});
  }finally{write(()=>s.signin.revoke(issued.fingerprint));}
  s.bridges.settings.change({action:'connection',id:'sample-'+agent,platform:'discord',agent,workspace:agent+' sample workspace',botUser:agent+'-bot',appSecret:null,tokenSecret:'FICTIONAL',enabled:false,only:[],ignore:[]});
 }
 const memberToken=write(()=>s.signin.issue({kind:'owner',member:'robin',label:'Fictitious preference editor'}));
 try{
  const saved=await app.http.request('/api/household/setPreferences',{method:'POST',headers:{authorization:'Bearer '+memberToken.token,'content-type':'application/json'},body:JSON.stringify({input:{ground:'contours'},id:randomUUID()})});
  assert.equal((await saved.json()).ok,true,'Save Robin’s personal background');
 }finally{write(()=>s.signin.revoke(memberToken.fingerprint));}
 const repository='github:example-house/archive';
 write(()=>s.projects.save({id:'archive',name:'Fictitious private archive',members:['alex'],agents:['fern'],repositories:[repository]}));
 const at=new Date().toISOString();
 const change=s.changes.put({id:repository+'#1',repo:repository,number:1,page:'',title:'Archive panel change',body:'Fictitious archived pump drawing',url:'https://github.com/example-house/archive/pull/1',state:'open',draft:false,author:{login:'example-fern'},created:at,updated:at,closed:null,head:{ref:'archive',id:'a'.repeat(40)},base:{ref:'next'},checks:{state:'none',failing:[],running:[],total:0},review:{state:'not_required',by:[]},mergeable:'yes',conflicts:false,people:[]});
 assert.equal(change.project,'archive');
 write(()=>s.tempo.triggers.set({ownerKind:'member',owner:'robin',sourceKind:'answer',watches:'approval:fixture-rain-gauge',lifespan:'once',
  targetKind:'inbox',toKind:'person',to:'robin',instructions:'Check the rain gauge.',note:'Robin rain gauge reminder'}));
 const thread=write(()=>s.comms.threads.open({member:'robin',agent:'moss',title:'Robin panel conversation'}));
 await s.comms.ask(thread.id,'moss','panel-question',{words:'Robin panel question?',answers:'yes-no',ifYes:'Proceed fictitiously.',ifNo:'Wait fictitiously.'});
 write(()=>s.tasks.create({title:'Alex panel task',goal:'A fictitious personal task.',why:'Check visibility.',owner:{kind:'member',id:'alex'}},{kind:'member',id:'alex'}));
}

// The first two columns name a visible control for each principal. The remaining
// columns are words which the respective principal must never see in that tile.
const panels={
 Tasks:['Alex panel task','Measure the hose',[],['Alex panel task']],
 Approvals:['Inspect the example pump','No approvals here',[],['Inspect the example pump']],
 Sharing:['Example garden','Household owners manage sharing',[],['Example garden']],
 Changes:['Archive panel change','Plan the pump repair',[],['Archive panel change']],
 Inbox:['Spend up to 180','Robin panel question?',['Robin panel question?'],['Spend up to 180']],
 Tempo:['Continue the pump inspection','Robin rain gauge reminder',[],['Continue the pump inspection']],
 Home:['Fern','Moss',[],['Repair the garden pump']],
 Projects:['fern sample project','moss sample project',[],['fern sample project']],
 Activity:['Repair the garden pump','Inspect the shared garden path',[],['Repair the garden pump']],
 'Job usage':['Inspect the example shed','Inspect the shared garden path',[],['Inspect the example shed']],
 Comms:['Repair the garden pump','Robin panel conversation',['Robin panel conversation'],['Repair the garden pump']],
 Agents:['Fern','Moss',[],['Fern']],
 People:['fern sample contact','moss sample contact',[],['fern sample contact']],
 Knowledge:['Sample orchid fact','access to Knowledge',[],['Sample orchid fact']],
 Bridges:['fern sample workspace','moss sample workspace',[],['fern sample workspace']],
 'Machines and jobs':['Example workshop','No machines',[],['Example workshop']],
 Subscriptions:['Weekly usage across subscriptions','Shared summaries',[],['Weekly usage across subscriptions']],
 Settings:['Fictitious connector credential','Household owners manage Settings',[],['Fictitious connector credential']],
 'Household setup':['Machine alerts','Household owners manage setup',[],['Machine alerts']],
 'Your account':['alex','robin',['robin'],['alex']],
 Appearance:['Pixel faces','Pixel faces'],
};

async function inspectPanels(browser,app,member,out){
 const context=await browser.newContext({viewport:{width:1500,height:940},serviceWorkers:'block',reducedMotion:'reduce'});
 try{
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  page.setDefaultTimeout(6000);
  await installDataProbe(page);
  await page.goto(app.signinLink(member));await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  const launcher=page.getByRole('dialog',{name:'Apps',exact:true});
  const open=async()=>{await page.keyboard.press('Control+Shift+Space');await launcher.waitFor();};
  await open();
  const titles=[...new Set([...await launcher.locator('.loom-lapp__nm').allTextContents(),'Your account'])];
  assert.deepEqual(titles.slice().sort(),Object.keys(panels).sort(),'Installed panels need explicit controls');
  const checked=[];
  for(const [index,title] of titles.entries()){
   if(index)await open();
   await launcher.getByRole('button',{name:title==='Your account'?'Open your account':title,exact:true}).click();
   const tile=page.getByRole('region',{name:title+' tile',exact:true});await tile.waitFor();
   const {selectionSeen,graphql,other}=await auditDataDoor(page,title);
   assert.ok(selectionSeen&&graphql===1&&!other.length,member+' '+title+' live selection');
   const [owner,peer,ownerAbsent=[],peerAbsent=[]]=panels[title],positive=member==='alex'?owner:peer;
   if(title==='Tasks')await tile.getByRole('button',{name:/^All open/}).click();
   await tile.getByText(positive,{exact:false}).first().waitFor();
   if(title==='Bridges'&&member==='alex'){
    await tile.getByText('moss sample workspace',{exact:false}).first().waitFor();
   }
   if(title==='Appearance'){
    const selected=tile.getByRole('radiogroup',{name:'Desk background'}).getByRole('radio',{checked:true});
    assert.equal(await selected.innerText(),member==='alex'?'Depth':'Contours');
   }
   const rendered=(await tile.innerText()).toLowerCase();
   for(const marker of member==='alex'?ownerAbsent:peerAbsent)assert.ok(!rendered.includes(marker.toLowerCase()),member+' saw restricted words in '+title);
   if(title==='Settings'&&member==='robin')await tile.screenshot({path:join(out,'action-deskPanelVisibility.png')});
   checked.push(title);
   await tile.getByRole('button',{name:'Close '+title,exact:true}).click();await tile.waitFor({state:'detached'});
  }
  // Check delivered data as well as rendered DOM. Global check uses content
  // markers, never IDs that a legitimately shared row may reference.
  const forbidden=member==='alex'?['Robin panel question?','Robin panel conversation']:
   ['Continue the pump inspection','Alex panel task','Archive panel change','Spend up to 180 example dollars','Inspect the example shed','fern sample workspace','fern sample project','Sample orchid fact','Fictitious connector credential'];
  const exposed=await page.evaluate(markers=>{
   const state=globalThis.__loomDataProbe;
   return markers.filter(marker=>state.sockets.some(socket=>state.entries.get(socket).frames.some(frame=>JSON.stringify(frame.patches).includes(marker))));
  },forbidden);
  assert.deepEqual(exposed,[],member+' received restricted words');
  return checked;
 }finally{await context.close();}
}

export async function deskPanelVisibility({browser,out}){
 const root=await mkdtemp(join(tmpdir(),'loom-desk-visibility-')),home=join(root,'home');let app;
 try{
  await exampleHome(home);
  const config=join(home,'program.json');
  await writeFile(config,JSON.stringify({...JSON.parse(await readFile(config,'utf8')),secretHolder:true}));
  app=await startSharedHome({home,port:0,stdout(){}});
  await addControls(app);
  const owner=await inspectPanels(browser,app,'alex',out);
  const projectMember=await inspectPanels(browser,app,'robin',out);
  return {ok:true,owner,projectMember,screenshot:'action-deskPanelVisibility.png'};
 }catch(error){return {ok:false,error:redactSignin(error)};}
 finally{try{await app?.close();}finally{await rm(root,{recursive:true,force:true});}}
}
