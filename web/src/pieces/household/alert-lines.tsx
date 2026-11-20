import {useState} from 'react';
import {Button, Field, Fields, Input, Section} from '../../kit';

const controls = [
  {key:'diskPercent',label:'Disk usage alert (%)',min:10,max:99},
  {key:'diskUrgentPercent',label:'Urgent disk usage alert (%)',min:11,max:100},
  {key:'diskFreeMib',label:'Minimum free disk space (MiB)',min:0,max:1_000_000_000},
  {key:'memoryFreeMib',label:'Minimum free memory (MiB)',min:0,max:1_000_000_000},
] as const;
export type AlertLines = Record<typeof controls[number]['key'],number>;

export function MachineAlertLines({lines,enabled,save}:{lines:AlertLines;enabled:boolean;save(patch:Partial<AlertLines>):void}) {
  const [error,setError]=useState('');
  return <Section label="Machine alerts">
    <p>These thresholds apply to all machines on their next reading.</p>
    <form aria-label="Machine alert thresholds" onSubmit={event=>{
      event.preventDefault();
      if(!enabled)return;
      const form=new FormData(event.currentTarget), patch:Partial<AlertLines>={};
      for(const {key,min,max,label} of controls){
        const raw=form.get(key), value=Number(raw);
        if(typeof raw!=='string'||!raw.trim()||!Number.isInteger(value)||value<min||value>max){
          setError(`${label} must be a whole number from ${min} to ${max}.`);return;
        }
        if(value!==lines[key])patch[key]=value;
      }
      const next={...lines,...patch};
      if(next.diskUrgentPercent<=next.diskPercent){setError('The urgent disk threshold must be higher than the disk alert threshold.');return;}
      setError('');
      if(Object.keys(patch).length)save(patch);
    }}>
      <Fields disabled={!enabled}>
        {controls.map(({key,label,min,max})=><Field key={key} label={label}>
          <Input key={lines[key]} type="number" name={key} defaultValue={lines[key]} min={min} max={max} step={1} required/>
        </Field>)}
        {error&&<p role="alert">{error}</p>}
        <Button type="submit" disabled={!enabled}>Save thresholds</Button>
      </Fields>
    </form>
  </Section>;
}
