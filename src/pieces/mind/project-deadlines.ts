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
