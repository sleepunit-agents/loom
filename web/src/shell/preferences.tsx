import { useEffect, useRef, useState } from 'react';
import { memberOperation } from '../data/operation';
import { LOOKS, keep, lookOf, wearLook, type Prefs } from '../look';
import { wearContrast, wearMotion } from '../access';
import { allowZoom } from '../immersion';
import { Button } from '../kit';

import { useMemberPreferences } from './member-preferences';

/** Server records are authoritative. Device storage only warms the next first paint. */
export function wearPreferences(prefs: Prefs): void {
  const look = lookOf(prefs.look, prefs.mode);
  wearLook(look); keep('loom-look', look);
  const motion = prefs.motion ?? 'follow', contrast = prefs.contrast ?? 'follow';
  wearMotion(motion); keep('loom-motion', motion);
  wearContrast(contrast); keep('loom-contrast', contrast);
  allowZoom(prefs.zoom === true); keep('loom-zoom', prefs.zoom ? 'on' : 'off');
}

export default function Preferences() {
  const snapshot = useMemberPreferences();
  const prefs = snapshot.status === 'live' ? snapshot.records[0]?.prefs : undefined;
  const [state, setState] = useState<{pending:boolean;message?:string;saved?:boolean}>({pending:false});
  const locked=useRef(false), mounted=useRef(true), retry=useRef<Prefs|undefined>(undefined);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(() => {
    if (snapshot.status === 'live') wearPreferences(prefs ?? {});
    else if (snapshot.status === 'denied') wearPreferences({});
  }, [prefs, snapshot.status]);
  const disabled = snapshot.status !== 'live' || state.pending;
  async function save(patch:Prefs) {
    if(snapshot.status!=='live'||locked.current)return;
    locked.current=true;retry.current=patch;setState({pending:true});
    try {
      await memberOperation('household.setPreferences',patch);
      if(mounted.current){retry.current=undefined;setState({pending:false,saved:true});}
    } catch {
      if(mounted.current)setState({pending:false,message:'Could not confirm the save. Your live choices are still shown.'});
    } finally {locked.current=false;}
  }
  return <details className="next-preferences">
    <summary>Appearance</summary>
    <div className="next-preferences-panel" aria-label="Appearance settings">
      <label>Look<select aria-label="Look" value={lookOf(prefs?.look, prefs?.mode)} disabled={disabled}
        onChange={e => {void save({ look: e.target.value as Prefs['look'] });}}>
        {LOOKS.map(look => <option key={look.look} value={look.look}>{look.name}</option>)}
      </select></label>
      <label>Ground<select aria-label="Ground" value={prefs?.ground ?? 'depth'} disabled={disabled}
        onChange={e => {void save({ ground: e.target.value as Prefs['ground'] });}}>
        <option value="depth">Depth</option><option value="contours">Contours</option><option value="wash">Wash</option>
      </select></label>
      {(['motion', 'contrast'] as const).map(key => <label key={key}>{key === 'motion' ? 'Reduce motion' : 'Higher contrast'}
        <select aria-label={key === 'motion' ? 'Reduce motion' : 'Higher contrast'} value={prefs?.[key] ?? 'follow'} disabled={disabled}
          onChange={e => {void save({ [key]: e.target.value });}}>
          <option value="follow">Follow this device</option><option value="on">On</option><option value="off">Off</option>
        </select>
      </label>)}
      {([
        ['sound', 'Sound', false], ['pixel', 'Pixel faces', true],
        ['icons', 'Pixel icons', false], ['haptics', 'Haptics', true],
        ['oneWindow', 'One window at a time', false], ['zoom', 'Allow zoom', false],
      ] as const).map(([key, label, fallback]) => <label key={key}><input type="checkbox" aria-label={label} checked={prefs?.[key] ?? fallback} disabled={disabled}
        onChange={e => {void save({ [key]: e.target.checked });}} />{label}</label>)}
      <p role="status">{snapshot.status === 'denied' ? 'Sign in again to change appearance.'
        : snapshot.status === 'offline' ? 'Offline. Reconnect before changing appearance.'
        : snapshot.status === 'loading' ? 'Loading appearance…'
        : state.pending ? 'Saving…' : state.message ?? (state.saved ? 'Saved.' : '')}</p>
      {state.message && <Button size="sm" disabled={snapshot.status !== 'live'||state.pending} onClick={() => {if(retry.current)void save(retry.current);}}>Retry save</Button>}
    </div>
  </details>;
}
