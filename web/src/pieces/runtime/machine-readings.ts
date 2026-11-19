/** What a machine's worker last read on it, as the short lines "Your machines" shows. The numbers and the
 * level are loom's (`boxReadings`); nothing is judged here. */
export type Reading = {box:string; kind:'disk'|'memory'|'containers'; thing:string; usedPercent:number|null; sizeMib:number|null; freeMib:number|null; answers:boolean|null; level:'ok'|'raised'|'urgent'};

/** An amount of room, in the binary units `df -h` writes. The same rounding as the notice loom sends. */
export function room(mib:number):string {
 if(mib<1024)return `${mib} MB`;
 const gb=mib/1024;
 return `${gb<10?Math.floor(gb*10)/10:Math.floor(gb)} GB`;
}
/** One reading, quietly. A disk is named by its path only when the machine has more than one watched. */
export function readingLine(reading:Reading,disks:number):string {
 if(reading.kind==='containers')return reading.answers?'Container runtime answering':'Container runtime not answering';
 if(reading.kind==='memory')return `Memory ${room(reading.freeMib??0)} available`;
 return `Disk${disks>1?' '+reading.thing:''} ${reading.usedPercent??0}% · ${room(reading.freeMib??0)} free`;
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
