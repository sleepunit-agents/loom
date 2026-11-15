/** Read-only evidence for the fixture's launcher actions; no app data or credentials. */
export async function startDeskLaunchTrace(page) {
 await page.evaluate(()=>{
  const events=[];
  const read=(kind,event)=>{
   const input=document.querySelector('input[aria-label="Find an app"]'),route=history.state?.loomNext;
   const target=event?.target,active=document.activeElement;
   events.push({kind,key:event?.key,prevented:event?.defaultPrevented,
    path:location.pathname.replace(/\/login\/[^/]+/,'/login/[redacted]'),width:innerWidth,height:innerHeight,oneWindow:document.documentElement.dataset.oneWindow,
    query:input?.value,inputCount:document.querySelectorAll('input[aria-label="Find an app"]').length,
    first:[...document.querySelectorAll('.loom-lapp__nm')].slice(0,3).map(node=>node.textContent),
    activeTag:active?.tagName,activeTile:active?.closest('[data-tile]')?.getAttribute('data-tile'),inputFocused:active===input,
    targetTag:target?.tagName,targetTile:target?.closest?.('[data-tile]')?.getAttribute('data-tile'),targetIsInput:target===input,eventQuery:target?.matches?.('input[aria-label="Find an app"]')?target.value:undefined,
    focused:route?.focused,tiles:Array.isArray(route?.tiles)?route.tiles.map(tile=>({id:tile.id,minimized:!!tile.minimized,pinned:!!tile.pinned,used:tile.used})):undefined,
    shown:[...document.querySelectorAll('[data-tile]')].filter(node=>node.getClientRects().length).map(node=>node.getAttribute('data-tile'))});
   if(events.length>24)events.shift();
  };
  const listener=event=>{if(event.type==='keydown'&&event.key!=='Enter')return;read(event.type,event);if(event.type==='keydown')queueMicrotask(()=>read('after-keydown',event));};
  document.addEventListener('keydown',listener,true);document.addEventListener('focusin',listener,true);
  window.__deskLaunchTrace={events,read,listener};read('started');
 });
}
export async function deskLaunchSnapshot(page,kind) {
 await page.evaluate(kind=>window.__deskLaunchTrace?.read(kind),kind);
}
export async function stopDeskLaunchTrace(page) {
 return page.evaluate(()=>{
  const trace=window.__deskLaunchTrace;if(!trace)return {lost:true,events:[]};trace.read('finished');
  document.removeEventListener('keydown',trace.listener,true);document.removeEventListener('focusin',trace.listener,true);
  delete window.__deskLaunchTrace;return {lost:false,events:trace.events};
 });
}
