import { useEffect, useRef, useState, type ReactNode } from 'react';
import { memberOperation } from '../../data/operation';
import { LOOKS, lookOf, type Prefs } from '../../look';
import { AppFrame, Button } from '../../kit';
import { Switch, SwitchRow } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useMemberPreferences } from '../../shell/member-preferences';
import './appearance.css';

const FOLLOW = [{ value: 'follow', label: 'Follow this device' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] as const;
const GROUNDS = [{ value: 'depth', label: 'Depth' }, { value: 'contours', label: 'Contours' }, { value: 'wash', label: 'Wash' }] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="next-appearance-section" aria-label={title}><h2>{title}</h2>{children}</section>;
}
/** One of a few: the choice shown is the saved one, and picking another saves it. */
function Choice({ label, hint, value, options, disabled, pick }: { label: string; hint?: string; value: string; options: readonly { value: string; label: string }[]; disabled: boolean; pick(value: string): void }) {
  return <div className="next-appearance-choice"><b>{label}</b>{hint && <small>{hint}</small>}
    <ToggleGroup type="single" className="v-seg" aria-label={label} value={value} disabled={disabled} onValueChange={next => { if (next && next !== value) pick(next); }}>
      {options.map(option => <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>)}
    </ToggleGroup>
  </div>;
}

/** A person's own look and switches, as an app. The server's record is what is shown: a change is sent as one choice
 * and appears here when its record arrives. Wearing the choices is the shell's (shell/appearance.tsx), open or not. */
export default function AppearanceApp({ go = () => {} }: { path?: string; go?: (path: string) => void } = {}) {
  const snapshot = useMemberPreferences();
  const prefs = snapshot.status === 'live' ? snapshot.records[0]?.prefs : undefined;
  const [state, setState] = useState<{pending:boolean;message?:string;saved?:boolean}>({pending:false});
  const locked=useRef(false), mounted=useRef(true), retry=useRef<Prefs|undefined>(undefined);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
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
  const toggle = (key: 'sound' | 'pixel' | 'icons' | 'haptics' | 'oneWindow' | 'zoom', label: string, hint: string, fallback: boolean) =>
    <SwitchRow><b>{label}</b><small>{hint}</small><Switch aria-label={label} checked={prefs?.[key] ?? fallback} disabled={disabled} onCheckedChange={on => {void save({ [key]: on });}} /></SwitchRow>;
  const status = snapshot.status === 'denied' ? 'Sign in again to change appearance.'
    : snapshot.status === 'offline' ? 'Offline. Reconnect before changing appearance.'
    : snapshot.status === 'loading' ? 'Loading appearance…'
    : state.pending ? 'Saving…' : state.message ?? (state.saved ? 'Saved.' : '');
  return <AppFrame title="Appearance" where="Appearance" go={go} context="Yours alone, on every device you sign in on.">
    <div className="next-appearance">
      <div className="next-appearance-status"><p role="status">{status}</p>
        {state.message && <Button size="sm" disabled={snapshot.status !== 'live'||state.pending} onClick={() => {if(retry.current)void save(retry.current);}}>Retry save</Button>}
      </div>
      <Section title="How it looks">
        <Choice label="Look" value={lookOf(prefs?.look, prefs?.mode)} options={LOOKS.map(look => ({ value: look.look, label: look.name }))} disabled={disabled} pick={look => {void save({ look: look as Prefs['look'] });}} />
        <Choice label="Desk background" value={prefs?.ground ?? 'depth'} options={GROUNDS} disabled={disabled} pick={ground => {void save({ ground: ground as Prefs['ground'] });}} />
        {toggle('pixel', 'Pixel faces', 'Agents with a pixel portrait wear it.', true)}
        {toggle('icons', 'Pixel icons', 'Apps wear the household’s pixel icons, where it has them.', false)}
      </Section>
      <Section title="Sound and touch">
        {toggle('sound', 'Sound', 'Short sounds as you use loom.', false)}
        {toggle('haptics', 'Haptics', 'A small tap you can feel, on a phone.', true)}
      </Section>
      <Section title="Motion and contrast">
        <Choice label="Reduce motion" value={prefs?.motion ?? 'follow'} options={FOLLOW} disabled={disabled} pick={motion => {void save({ motion: motion as Prefs['motion'] });}} />
        <Choice label="Higher contrast" value={prefs?.contrast ?? 'follow'} options={FOLLOW} disabled={disabled} pick={contrast => {void save({ contrast: contrast as Prefs['contrast'] });}} />
      </Section>
      <Section title="Windows">
        {toggle('oneWindow', 'One window at a time', 'Show one app at a time. The others stay in the dock.', false)}
        {toggle('zoom', 'Allow zoom', 'Pinch or double-tap to zoom, on a phone.', false)}
      </Section>
    </div>
  </AppFrame>;
}
