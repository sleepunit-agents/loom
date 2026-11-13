/** Track only a message number; renew foreground presence even after a successful read. */
export function bindThreadRead(seq:number,read:(seq:number)=>Promise<boolean>){
 let closed=false,pending=false;
 const check=()=>{
  if(closed||pending||seq<=0||document.visibilityState!=='visible'||!document.hasFocus())return;
  pending=true;
  void Promise.resolve().then(()=>closed?false:read(seq)).catch(()=>{}).finally(()=>{pending=false;});
 };
 document.addEventListener('visibilitychange',check);window.addEventListener('focus',check);
 const timer=setInterval(check,30000);check();
 return()=>{closed=true;clearInterval(timer);document.removeEventListener('visibilitychange',check);window.removeEventListener('focus',check);};
}
