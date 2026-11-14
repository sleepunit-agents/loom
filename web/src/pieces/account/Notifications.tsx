import { useEffect, useSyncExternalStore } from 'react';
import { useRecords, type LiveRecord } from '../../data';
import { Button, Loading, Error as ErrorView } from '../../kit';
import { frozen, idle } from '../../data/mutation';
import { mutation, submitAccountChange } from './model';
import { notificationController } from './notifications';
export const notifications=notificationController();
interface Devices extends LiveRecord { member:string; devices:Array<{ref:string;session:string;device?:string;at:number;seenAt?:number}> }
export default function Notifications({enabled}:{enabled:boolean}){
  const feed=useRecords<Devices>('notifications.devices'),record=feed.status==='denied'?undefined:feed.records[0];
  const state=useSyncExternalStore(notifications.subscribe,notifications.getSnapshot);
  const held=useSyncExternalStore(mutation.subscribe,mutation.getSnapshot);
  const request=useSyncExternalStore(held.request?.subscribe??(()=>()=>{}),held.request?.getSnapshot??(()=>idle));
  const connected=enabled&&feed.status==='live'&&!!record;
  const can=connected&&!state.busy&&!frozen(request);
  useEffect(()=>{notifications.setEnabled(connected);return()=>notifications.setEnabled(false);},[connected]);
  return <section aria-label="Notifications" className="grid min-w-0 gap-4">
    <h2 className="text-xl font-semibold">Notifications</h2>
    <p>Notifications belong to you and stay enabled after ordinary sign-out. Signing out a browser from the list above stops its notifications. Notification delivery is not available yet.</p>
    {feed.status==='loading'?<Loading label="Opening notification devices…"/>:!record?<p>Notification devices are unavailable.</p>:<>
      {held.label?.startsWith('notifications.')&&<section aria-live="polite">{request.pending?<Loading label="Saving notification change…"/>:request.result?.ok?<p role="status">Saved</p>:request.result&&<><ErrorView text={request.result.message}/>{request.result.code==='unavailable'&&<Button disabled={!connected} onClick={()=>{if(connected)held.request?.retry?.();}}>Retry this change</Button>}</>}</section>}
      {feed.status!=='live'&&<ErrorView text="Connection lost. Notification changes are disabled."/>}
      {!state.supported?<p>This browser cannot receive notifications. On iPhone or iPad, add loom to the Home Screen and open it there.</p>:<>
        <p>This browser: {state.permission==='denied'?'Blocked in browser settings':state.on&&record.devices.some(d=>d.ref===state.ref)?'Enabled':'Off'}</p>
        <div className="flex flex-wrap gap-2"><Button disabled={!can||state.permission==='denied'} onClick={()=>void notifications.enable()}>Enable notifications on this browser</Button><Button disabled={!can||!state.on} variant="outline" onClick={()=>void notifications.disable()}>Turn off notifications on this browser</Button></div>
      </>}
      {state.busy&&<Loading label="Updating browser notifications…"/>}{state.message&&<p role="status">{state.message}</p>}
      {!record.devices.length&&<p>No notification devices yet.</p>}
      {record.devices.map(d=><form key={d.ref} aria-label={`Remove notification device ${d.ref}`} className="grid min-w-0 gap-2 rounded-xl border p-4" onSubmit={event=>{event.preventDefault();if(!can||notifications.getSnapshot().busy)return;submitAccountChange('notifications.remove',{ref:d.ref},()=>event.currentTarget.reset());}}>
        <h3 className="font-semibold">{d.device??'Browser'}</h3><p className="break-all">Device reference: {d.ref}</p><p className="break-all">Browser reference: {d.session}</p><p>Enabled {new Date(d.at*1000).toLocaleString()}{d.seenAt!==undefined?` · Last seen ${new Date(d.seenAt*1000).toLocaleString()}`:''}</p>
        <fieldset disabled={!can} className="grid gap-2"><label><input type="checkbox" required/> I confirm removing this notification device</label><Button type="submit" variant="outline">Remove notification device</Button></fieldset>
      </form>)}
    </>}
  </section>;
}
