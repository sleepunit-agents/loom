/** Read-only evidence for the fixture's launcher actions; no app data or credentials. */
export async function startDeskLaunchTrace(page) {
 await page.evaluate(()=>{
  const events=[];
  const read=(kind,event,write)=>{
   const input=document.querySelector('input[aria-label="Find an app"]'),route=history.state?.loomNext;
   const target=event?.target,active=document.activeElement;
   events.push({kind,key:event?.key,prevented:event?.defaultPrevented,write,
    path:location.pathname.replace(/\/login\/[^/]+/,'/login/[redacted]'),width:innerWidth,height:innerHeight,oneWindow:document.documentElement.dataset.oneWindow,
    query:input?.value,hasForm:!!input?.form,inputCount:document.querySelectorAll('input[aria-label="Find an app"]').length,
    first:[...document.querySelectorAll('.loom-lapp__nm')].slice(0,3).map(node=>node.textContent),chosen:[...document.querySelectorAll('.loom-lapp[data-first] .loom-lapp__nm')].map(node=>node.textContent),
    activeTag:active?.tagName,activeTile:active?.closest('[data-tile]')?.getAttribute('data-tile'),inputFocused:active===input,
    clickedApp:target?.closest?.('.loom-lapp')?.querySelector('.loom-lapp__nm')?.textContent,targetTag:target?.tagName,targetTile:target?.closest?.('[data-tile]')?.getAttribute('data-tile'),targetIsInput:target===input,eventQuery:target?.matches?.('input[aria-label="Find an app"]')?target.value:undefined,
    focused:route?.focused,tiles:Array.isArray(route?.tiles)?route.tiles.map(tile=>({id:tile.id,minimized:!!tile.minimized,pinned:!!tile.pinned,used:tile.used})):undefined,
    shown:[...document.querySelectorAll('[data-tile]')].filter(node=>node.getClientRects().length).map(node=>node.getAttribute('data-tile'))});
   if(events.length>24)events.shift();
  };
  const listener=event=>{if(event.type==='keydown'&&event.key!=='Enter')return;read(event.type,event);if(event.type==='keydown')queueMicrotask(()=>read('after-keydown',event));};
  const bubble=event=>{if(event.key==='Enter')read('keydown-bubble',event);};
  const click=event=>read('click',event),pop=()=>read('popstate');
  const original={},wrapped={};
  for(const method of ['pushState','replaceState']){
   original[method]=history[method];
   wrapped[method]=function(...args){
    const route=args[0]?.loomNext;
    const callers=(new Error().stack??'').split('\n').slice(1,6).map(line=>/^\s*at\s+([A-Za-z_$][\w.$]*)\s*\(/.exec(line)?.[1]??'anonymous');
    const requested={focused:route?.focused,tiles:Array.isArray(route?.tiles)?route.tiles.map(tile=>({id:tile.id,minimized:!!tile.minimized,used:tile.used})):undefined};
    const result=original[method].apply(this,args);read('history-'+method,undefined,{callers,requested});return result;
   };
   history[method]=wrapped[method];
  }
  const cleanup=()=>{
   document.removeEventListener('keydown',listener,true);document.removeEventListener('focusin',listener,true);
   document.removeEventListener('keydown',bubble);document.removeEventListener('click',click,true);window.removeEventListener('popstate',pop);
   for(const method of ['pushState','replaceState'])if(history[method]===wrapped[method])history[method]=original[method];
  };
  document.addEventListener('keydown',listener,true);document.addEventListener('focusin',listener,true);
  document.addEventListener('keydown',bubble);document.addEventListener('click',click,true);window.addEventListener('popstate',pop);
  window.__deskLaunchTrace={events,read,listener,cleanup};read('started');
 });
}
export async function deskLaunchSnapshot(page,kind) {
 await page.evaluate(kind=>window.__deskLaunchTrace?.read(kind),kind);
}
export async function stopDeskLaunchTrace(page) {
 return page.evaluate(()=>{
  const trace=window.__deskLaunchTrace;if(!trace)return {lost:true,events:[]};trace.read('finished');
  trace.cleanup();
  delete window.__deskLaunchTrace;return {lost:false,events:trace.events};
 });
}
