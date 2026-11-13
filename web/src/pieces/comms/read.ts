/** Track only a message number. Failed marks retry when the visible page returns or on the next tick. */
export function bindThreadRead(seq:number,read:(seq:number)=>Promise<boolean>){
 let closed=false,pending=false,done=false;
 const check=()=>{
  if(closed||done||pending||seq<=0||document.visibilityState!=='visible'||!document.hasFocus())return;
  pending=true;
  void Promise.resolve().then(()=>closed?false:read(seq)).then(ok=>{if(!closed)done=ok;},()=>{}).finally(()=>{pending=false;});
 };
 document.addEventListener('visibilitychange',check);window.addEventListener('focus',check);
 const timer=setInterval(check,30000);check();
 return()=>{closed=true;clearInterval(timer);document.removeEventListener('visibilitychange',check);window.removeEventListener('focus',check);};
}
