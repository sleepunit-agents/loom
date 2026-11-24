import assert from 'node:assert/strict';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {auditDataDoor,installDataProbe} from './rebuild-data-actions.mjs';

const folderTiles=['Tasks','Approvals','Changes','Inbox','Tempo','Projects','Activity','Comms','People','Knowledge','Bridges','Settings'];
const readerTiles=['Tasks','Approvals','Changes','Inbox','Tempo','Activity','Comms'];

/** Inspect requests across a single signed-in document, including sockets which close between app selections. */
export async function deskDataDoor({browser,home,device,inventory}) {
 const phone=device==='phone';
 await exampleHome(home);
 const app=await startSharedHome({home,port:0,stdout(){}});
 let context,stage='sign-in';
 try {
  context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1500,height:940},isMobile:phone,hasTouch:phone,reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  page.setDefaultTimeout(8000);
  if(phone){
   // The startup notice overlaps tile controls on a phone. Use its normal close button.
   const dismiss=page.getByRole('button',{name:'Dismiss Inbox notification',exact:true});
   await page.addLocatorHandler(dismiss,button=>button.tap());
  }
  await installDataProbe(page);
  const sockets=[],unexpected=[],acks=[],folders=[],readers=[],tiles=[];
  const expectedSocket=app.url.replace(/^http/,'ws')+'/graphql';
  page.on('websocket',socket=>{
   const record={graphql:socket.url()===expectedSocket,closed:false,selections:0,received:0};
   sockets.push(record);
   socket.on('close',()=>{record.closed=true;});
   if(!record.graphql)return;
   socket.on('framesent',({payload})=>{
    const frame=JSON.parse(String(payload));
    if(frame.type==='subscribe') {
     if(!/\bobserve\s*\(/.test(frame.payload?.query??'') || !frame.payload?.variables?.query)unexpected.push({stage,transport:'socket',type:'unrecognized subscription'});
     record.selections++;
    }
   });
   socket.on('framereceived',({payload})=>{
    const frame=JSON.parse(String(payload));
    if(frame.type==='next'&&frame.payload?.data?.observe)record.received++;
   });
  });
  context.on('request',request=>{
   const url=new URL(request.url()),path=url.pathname,type=request.resourceType();
   if(!['fetch','xhr','eventsource','webtransport'].includes(type)&&!/^\/(?:api\/|graphql\b|live\b)/.test(path))return;
   if(url.origin===app.url&&path==='/auth/session'&&request.method()==='GET'&&!url.search)return;
   if(url.origin===app.url&&!url.search&&request.method()==='POST'&&['/api/inbox/read','/api/comms/change'].includes(path)){
    const input=request.postDataJSON()?.input;
    if((path==='/api/inbox/read'&&typeof input?.item==='string')||(path==='/api/comms/change'&&input?.change==='read')){
     acks.push({stage,path});return;
    }
   }
   unexpected.push({stage,path,type,method:request.method()});
  });
  await page.goto(app.signinLink('alex'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  const initialDocument=await page.evaluate(()=>performance.timeOrigin);
  const launcher=page.getByRole('dialog',{name:'Apps',exact:true});
  const openLauncher=async()=>{
   if(phone)await page.getByRole('button',{name:'All apps',exact:true}).tap();
   else await page.keyboard.press('Control+Shift+Space');
   await launcher.waitFor();
  };
  const openTile=async title=>{
   const button=launcher.getByRole('button',{name:title==='Your account'?'Open your account':title,exact:true});
   await button.click();
   const tile=page.getByRole('region',{name:title+' tile',exact:true});
   await tile.waitFor();
   const evidence=await auditDataDoor(page,title);
   assert.deepEqual({graphql:evidence.graphql,other:evidence.other,selected:evidence.selectionSeen},{graphql:1,other:[],selected:true},device+' '+title);
   return tile;
  };
  await openLauncher();
  const titles=await launcher.locator('.loom-lapp__nm').allTextContents();
  if(!titles.includes('Your account'))titles.push('Your account');
  assert.deepEqual([...titles].sort(),[...inventory].sort());
  for(const [i,title] of titles.entries()){
   stage=title;
   if(i)await openLauncher();
   const tile=await openTile(title);
   tiles.push(title);
   const back=tile.locator('.loom-split__back:visible').first();
   if(await back.count())await back.click();
   const row=tile.locator('.loom-split__rows [data-split-row]:visible:not([aria-current="true"])').first();
   if(readerTiles.includes(title))await row.waitFor();
   if(await row.count()){
    await row.click();
    await tile.locator('.loom-split[data-open] .loom-split__reader:visible').waitFor();
    readers.push(title);
    if(await back.count())await back.click();
   }
   const filter=tile.locator('summary:visible').filter({hasText:'Filter activity'});
   if(title==='Activity'&&await filter.count()){
    await filter.click();
    await tile.getByRole('group',{name:'Where',exact:true}).getByRole('button').first().click();
    folders.push(title);
   }else{
    const folder=tile.locator('.loom-split__folder:visible:not([aria-current="true"]):not([aria-pressed="true"]), .loom-split__chips button:visible[aria-pressed="false"]').first();
    if(folderTiles.includes(title))await folder.waitFor();
    if(await folder.count()){
     await folder.click();
     await tile.locator('.loom-split__rows:not([aria-busy=true])').waitFor();
     folders.push(title);
    }
   }
   await tile.getByRole('button',{name:'Close '+title,exact:true}).click();
   await tile.waitFor({state:'detached'});
  }
  assert.deepEqual(sockets.map(s=>[s.graphql,s.closed]),[[true,false]]);
  stage='Inbox live update';
  await openLauncher();
  const tile=await openTile('Inbox');
  await tile.getByRole('button',{name:/^FYI\b/i}).first().click();
  const notice='The fictional '+device+' network sensor restarted.';
  const sourceId='walkthrough-desk-connection';
  const send=()=>app.services.conversations.send({toKind:'person',to:'alex',member:'alex',source:'notice',sourceId,fromKind:'unknown',words:notice});
  const noticeId=app.writes.run(send).value.id;
  const row=tile.locator('[data-split-row]').filter({hasText:notice});
  await row.click();
  const reader=tile.getByRole('article',{name:'Inbox item',exact:true});
  await reader.getByRole('heading',{name:notice,exact:true}).waitFor();
  stage='reconnect';
  await page.evaluate(()=>globalThis.__loomDataProbe.sockets.find(s=>s.readyState===WebSocket.OPEN).close(4000,'Fixture disconnect'));
  await page.waitForFunction(id=>{
   const probe=globalThis.__loomDataProbe,socket=probe.sockets[1];
   if(socket?.readyState!==WebSocket.OPEN)return false;
   const entry=probe.entries.get(socket);
   const live=[...entry.active.values()].filter(query=>entry.frames.some(frame=>frame.id===query.id));
   return live.some(query=>/query\s+InboxItem\b/.test(query.query)&&query.variables.id===id)
    &&live.some(query=>/query\s+Inbox\b/.test(query.query)&&query.variables.folder==='fyi');
  },noticeId);
  await reader.getByRole('heading',{name:notice,exact:true}).waitFor();
  const settled='The fictional sensor is reporting again.';
  assert.equal(app.writes.run(()=>app.services.conversations.resolveSource('notice',sourceId,settled,{kind:'person',id:'alex'})).value.length,1);
  await reader.getByText(settled,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>performance.timeOrigin),initialDocument);
  assert.deepEqual(sockets.map(s=>[s.graphql,s.closed]),[[true,true],[true,false]]);
  assert.ok(sockets.every(s=>s.selections>0&&s.received>0));
  assert.deepEqual(unexpected,[],'Unexpected requests '+JSON.stringify(unexpected));
  return {ok:true,device,tiles,folders,readers,acknowledgments:acks,sockets:sockets.map(({selections,received})=>({selections,received})),restoredSelection:true,liveReaderUpdate:true};
 }catch(error){throw Error(device+' '+stage+': '+error.message,{cause:error});}
 finally{
  try{await context?.close();}finally{await app.close();}
 }
}
