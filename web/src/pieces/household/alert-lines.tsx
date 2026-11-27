import {useState} from 'react';
import {Button, Field, Fields, Input, Section} from '../../kit';

import {alertControls as controls, alertPatch, type AlertLines} from './alert-lines-model';
export type {AlertLines} from './alert-lines-model';

export function MachineAlertLines({lines,enabled,save}:{lines:AlertLines;enabled:boolean;save(patch:Partial<AlertLines>):void}) {
  const [error,setError]=useState('');
  return <Section label="Machine alerts">
    <p>These thresholds apply to all machines on their next reading.</p>
    <form aria-label="Machine alert thresholds" onSubmit={event=>{
      event.preventDefault();
      if(!enabled)return;
      const form=new FormData(event.currentTarget), checked=alertPatch(lines,key=>form.get(key));
      if('error' in checked){setError(checked.error);return;}
      const patch=checked.patch;
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
