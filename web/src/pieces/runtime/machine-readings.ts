import {briefTime} from '../../kit/time';
import {READING_OLD_MS} from '../../../../src/runtime/machine-reading-time';
/** What a machine's worker last read on it, as the short lines "Your machines" shows. The numbers and the
 * level are loom's (`boxReadings`); nothing is judged here. */
export type Reading = {box:string; kind:'disk'|'memory'|'containers'; thing:string; disk?:string|null; usedPercent:number|null; sizeMib:number|null; freeMib:number|null; answers:boolean|null; level:'ok'|'raised'|'urgent'; readAt:string|null; unknownSince:string|null; stale:boolean};

/** An amount of room, in the binary units `df -h` writes. The same rounding as the notice loom sends. */
export function room(mib:number):string {
 if(mib<1024)return `${mib} MB`;
 const gb=mib/1024;
 return `${gb<100?Math.floor(gb*10)/10:Math.floor(gb)} GB`;
}
/** How old a reading is, where that needs saying: nothing for one just read. A number the machine can no
 * longer read, or has not sent for a while, is never shown as if it were current. */
export function readingAge(reading:Reading,now:number,zone?:string):string {
 if(!reading.readAt)return '';
 if(reading.stale)return ` (not read since ${briefTime(reading.readAt,zone,now)})`;
 const age=now-Date.parse(reading.readAt);
 return reading.unknownSince||!(age<=READING_OLD_MS)?` (as of ${briefTime(reading.readAt,zone,now)})`:'';
}
/** One reading, quietly. A disk is named by its path only when the machine has more than one watched. */
export function readingLine(reading:Reading,disks:number,now:number,zone?:string):string {
 if(!reading.readAt)return `Disk ${reading.thing} unreadable`;
 const said=reading.kind==='containers'?(reading.answers?'Container runtime answering':'Container runtime not answering')
  :reading.kind==='memory'?`Memory ${room(reading.freeMib??0)} available`
  :`Disk${disks>1?' '+reading.thing:''} ${reading.usedPercent??0}% · ${room(reading.freeMib??0)} free`;
 return said+readingAge(reading,now,zone);
}
/** An open condition, plainly. Nothing for a reading that is fine. */
export function conditionLine(reading:Reading):string|undefined {
 if(reading.level==='ok')return undefined;
 if(reading.kind==='containers')return 'The container runtime is not answering.';
 if(reading.kind==='memory')return `Low memory: ${room(reading.freeMib??0)} available.`;
 return `${reading.thing} is ${reading.level==='urgent'?'almost out of room':'running out of room'}: ${reading.usedPercent??0}% full, ${room(reading.freeMib??0)} free.`;
}
const order={disk:0,memory:1,containers:2};
/** A machine's readings in the order they are shown: disks by path, then memory, then the container runtime. */
export const readingsOf=(readings:readonly Reading[]|undefined,box:string)=>(readings??[]).filter(reading=>reading.box===box)
 .sort((a,b)=>order[a.kind]-order[b.kind]||(a.thing<b.thing?-1:a.thing>b.thing?1:0));
