/** Timer metadata from a computed hub; no content or persistent store of its own. */
import type {ProjectRecord} from './projects-model.js';
const day=86400000;
export function projectDeadline(record:ProjectRecord,now:number):number|undefined {
 const deadlines=Object.values(record.card.where).flatMap(field=>field.verified_at?[
  Date.parse(field.verified_at)+(field.stale_after_days??14)*day+1,
  Date.parse(field.verified_at)+(Math.floor((now-Date.parse(field.verified_at))/day)+1)*day,
 ]:[]);
 for(const section of record.sections){
  if(section.expires!==undefined)deadlines.push(section.expires);
  if(section.activity)deadlines.push(Date.parse(section.activity)+7*day);
  for(const item of [...(section.items??[]),...(section.groups??[]).flatMap(group=>group.items)]){
   if(item.when)deadlines.push(...Array.from({length:8},(_,n)=>Date.parse(item.when!)+n*day));
   if(item.changed)deadlines.push(Date.parse(item.changed)+7*day);
  }
 }
 return deadlines.filter(at=>Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0];
}
/** A query may discover a closer deadline after its initial execution or a
 * source change. Notify composition once after the synchronous reads settle. */
export class ProjectDeadlines {
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
