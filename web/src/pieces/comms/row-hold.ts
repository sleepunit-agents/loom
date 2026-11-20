/** Touch/pen long press pins; mouse and keyboard keep their existing menu. */
export function bindRowHold(row:HTMLElement,canPin:()=>boolean,pin:()=>void){
 let touch:{id:number;x:number;y:number}|undefined,timer:ReturnType<typeof setTimeout>|undefined,swallow=false;
 const cancel=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;touch=undefined;};
 const down=(e:PointerEvent)=>{
  if(touch){cancel();return;} // A second finger cancels, including outside this row.
  if(!e.isPrimary)return;
  swallow=false;
  if(!['touch','pen'].includes(e.pointerType)||e.button!==0||!row.contains(e.target as Node)||!canPin()||getSelection()?.isCollapsed===false)return;
  touch={id:e.pointerId,x:e.clientX,y:e.clientY};
  timer=setTimeout(()=>{timer=undefined;if(!touch||!canPin())return;swallow=true;pin();},550);
 };
 const move=(e:PointerEvent)=>{if(touch&&e.pointerId===touch.id&&Math.hypot(e.clientX-touch.x,e.clientY-touch.y)>10)cancel();};
 const up=(e:PointerEvent)=>{if(touch&&e.pointerId===touch.id)cancel();};
 // Keep the compatibility click out of both the row and Split's navigation.
 const click=(e:MouseEvent)=>{if(swallow&&e.detail>0){swallow=false;e.preventDefault();e.stopImmediatePropagation();}};
 const context=(e:Event)=>{if(touch||swallow){e.preventDefault();e.stopImmediatePropagation();}};
 document.addEventListener('pointerdown',down,true);
 document.addEventListener('pointermove',move,true);
 document.addEventListener('pointerup',up,true);
 document.addEventListener('pointercancel',up,true);
 window.addEventListener('blur',cancel);
 document.addEventListener('visibilitychange',cancel);
 row.addEventListener('click',click,true);
 row.addEventListener('contextmenu',context,true);
 return {cancel,dispose:()=>{
  cancel();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',move,true);
  document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',up,true);
  window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',cancel);
  row.removeEventListener('click',click,true);row.removeEventListener('contextmenu',context,true);
 }};
}
