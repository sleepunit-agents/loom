/** A query may discover a closer deadline after its initial execution or a
 * source change. Notify composition once after the synchronous reads settle. */
export class QueryDeadlines {
 private deadlines=new Map<string,number>();
 private listeners=new Set<()=>void>();
 private pending=false;
 private closed=false;
 constructor(private now:()=>number){}
 set(key:string,at:number|undefined){
  if(this.closed)return;
  const before=this.deadlines.get(key);
  if(at!==undefined&&Number.isFinite(at)&&at>this.now())this.deadlines.set(key,at);else this.deadlines.delete(key);
  if(before===this.deadlines.get(key)||this.pending)return;
  this.pending=true;queueMicrotask(()=>{this.pending=false;if(!this.closed)for(const fn of this.listeners)fn();});
 }
 nextDeadline(){let next=Infinity;const now=this.now();for(const [key,at] of this.deadlines){if(at<=now)this.deadlines.delete(key);else next=Math.min(next,at);}return next===Infinity?undefined:next;}
 observe(fn:()=>void){if(this.closed)return()=>{};this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 close(){this.closed=true;this.deadlines.clear();this.listeners.clear();}
}
