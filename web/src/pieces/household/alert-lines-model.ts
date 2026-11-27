/** The household's machine alert lines: each one's label and bounds, and the check of a typed change. No
 * component; the desktop's form (./alert-lines.tsx) and the boards page's `machines` brick both use it. */
export const alertControls = [
  {key:'diskPercent',label:'Disk usage alert (%)',min:10,max:99},
  {key:'diskUrgentPercent',label:'Urgent disk usage alert (%)',min:11,max:100},
  {key:'diskFreeMib',label:'Minimum free disk space (MiB)',min:0,max:1_000_000_000},
  {key:'memoryFreeMib',label:'Minimum free memory (MiB)',min:0,max:1_000_000_000},
] as const;
export type AlertLines = Record<typeof alertControls[number]['key'],number>;
export const alertLinesSelection = 'boxAlertSettings(limit:1) { diskPercent diskUrgentPercent diskFreeMib memoryFreeMib }';

/** What was typed for each line, checked: the lines that differ from the stored ones, or why it cannot be saved. */
export function alertPatch(lines:AlertLines,typed:(key:keyof AlertLines)=>unknown):{error:string}|{patch:Partial<AlertLines>} {
  const patch:Partial<AlertLines>={};
  for(const {key,min,max,label} of alertControls){
    const raw=typed(key), value=Number(raw);
    if(typeof raw!=='string'||!raw.trim()||!Number.isInteger(value)||value<min||value>max)
      return {error:`${label} must be a whole number from ${min} to ${max}.`};
    if(value!==lines[key])patch[key]=value;
  }
  const next={...lines,...patch};
  if(next.diskUrgentPercent<=next.diskPercent)return {error:'The urgent disk threshold must be higher than the disk alert threshold.'};
  return {patch};
}
