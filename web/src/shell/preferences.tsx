import { useEffect, useState, useSyncExternalStore } from 'react';
import { call, type Call, type CallState } from '../data';
import { LOOKS, keep, lookOf, wearLook, type Prefs } from '../look';
import { wearContrast, wearMotion } from '../access';
import { allowZoom } from '../immersion';
import { Button } from '../kit';

import { useMemberPreferences } from './member-preferences';
const idle: CallState<Prefs> = { pending: false, status: 'done' };
const noop = () => () => {};

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
  const [request, setRequest] = useState<Call<Prefs>>();
  const state = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  useEffect(() => {
    if (snapshot.status === 'live') wearPreferences(prefs ?? {});
    else if (snapshot.status === 'denied') wearPreferences({});
  }, [prefs, snapshot.status]);
  const disabled = snapshot.status !== 'live' || state.pending;
  const save = (patch: Prefs) => { if (!disabled) setRequest(call<Prefs>('household.setPreferences', patch)); };
  return <details className="next-preferences">
    <summary>Appearance</summary>
    <div className="next-preferences-panel" aria-label="Appearance settings">
      <label>Look<select aria-label="Look" value={lookOf(prefs?.look, prefs?.mode)} disabled={disabled}
        onChange={e => save({ look: e.target.value as Prefs['look'] })}>
        {LOOKS.map(look => <option key={look.look} value={look.look}>{look.name}</option>)}
      </select></label>
      <label>Ground<select aria-label="Ground" value={prefs?.ground ?? 'depth'} disabled={disabled}
        onChange={e => save({ ground: e.target.value as Prefs['ground'] })}>
        <option value="depth">Depth</option><option value="contours">Contours</option><option value="wash">Wash</option>
      </select></label>
      {(['motion', 'contrast'] as const).map(key => <label key={key}>{key === 'motion' ? 'Reduce motion' : 'Higher contrast'}
        <select aria-label={key === 'motion' ? 'Reduce motion' : 'Higher contrast'} value={prefs?.[key] ?? 'follow'} disabled={disabled}
          onChange={e => save({ [key]: e.target.value })}>
          <option value="follow">Follow this device</option><option value="on">On</option><option value="off">Off</option>
        </select>
      </label>)}
      {([
        ['sound', 'Sound', false], ['pixel', 'Pixel faces', true],
        ['icons', 'Pixel icons', false], ['haptics', 'Haptics', true],
        ['oneWindow', 'One window at a time', false], ['zoom', 'Allow zoom', false],
      ] as const).map(([key, label, fallback]) => <label key={key}><input type="checkbox" aria-label={label} checked={prefs?.[key] ?? fallback} disabled={disabled}
        onChange={e => save({ [key]: e.target.checked })} />{label}</label>)}
      <p role="status">{snapshot.status === 'denied' ? 'Sign in again to change appearance.'
        : snapshot.status === 'offline' || state.status === 'offline' ? 'Offline. Changes will resume when connected.'
        : snapshot.status === 'loading' ? 'Loading appearance…'
        : state.pending ? 'Saving…' : state.result?.ok === false ? state.result.message : state.result?.ok ? 'Saved.' : ''}</p>
      {state.result?.ok === false && state.result.code === 'unavailable' && <Button size="sm" disabled={snapshot.status !== 'live'} onClick={() => request?.retry?.()}>Retry save</Button>}
    </div>
  </details>;
}
