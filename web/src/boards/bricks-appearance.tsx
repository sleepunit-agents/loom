/** The `appearance` brick: the member's own Appearance, every choice the desktop's Appearance app offers
 * (pieces/appearance/choices.ts, look.ts), each a row of buttons, since a board has no select control. A press
 * saves that one choice by the desktop's own operation, `household.setPreferences`; what is shown is the server's
 * record, so the pressed button changes when the record arrives, as on the desktop. The board is told `set`, and
 * not which choice.
 *
 * Of these, this page wears only Reduce motion (./wear.ts, which says why); the brick says so in one line and
 * groups the choices by it. */
import { useEffect, useRef, useState } from 'react';
import { memberOperation } from '../data/operation';
import { LOOKS, lookOf, type Prefs } from '../look';
import { FOLLOW, GROUNDS, SAVE_UNCONFIRMED, SWITCHES, type SwitchKey } from '../pieces/appearance/choices';
import { Loading, type BodyProps } from './brick-kit';
import { WORN_WORDS, useOwnPreferences } from './wear';

type Option = { value: string; label: string };
const looks: Option[] = LOOKS.map((look) => ({ value: look.look, label: look.name }));
const onOff: Option[] = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];
const labelOf = (options: readonly Option[], value: string) => options.find((option) => option.value === value)?.label ?? value;

export function Appearance({ form, act }: BodyProps) {
  const snapshot = useOwnPreferences();
  const [state, setState] = useState<{ pending: boolean; message?: string }>({ pending: false });
  const locked = useRef(false), shown = useRef(true);
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  if (snapshot.status === 'loading') return <Loading />;
  if (snapshot.status !== 'live') return <p className="text-muted-foreground">Your appearance settings are unavailable.</p>;
  const prefs: Prefs = snapshot.records[0]?.prefs ?? {};
  const look = lookOf(prefs.look, prefs.mode), motion = prefs.motion ?? 'follow';
  if (form === 'compact') return <p className="board-brief">{labelOf(looks, look)} · Reduce motion: {labelOf(FOLLOW, motion)}</p>;
  const switched = (key: SwitchKey) => ((prefs[key] ?? SWITCHES[key].fallback) ? 'on' : 'off');
  const rows: { label: string; hint?: string; here?: boolean; value: string; options: readonly Option[]; patch(value: string): Prefs }[] = [
    { label: 'Reduce motion', here: true, value: motion, options: FOLLOW, patch: (value) => ({ motion: value as Prefs['motion'] }) },
    { label: 'Look', value: look, options: looks, patch: (value) => ({ look: value as Prefs['look'] }) },
    { label: 'Desk background', value: prefs.ground ?? 'depth', options: GROUNDS, patch: (value) => ({ ground: value as Prefs['ground'] }) },
    { label: 'Higher contrast', value: prefs.contrast ?? 'follow', options: FOLLOW, patch: (value) => ({ contrast: value as Prefs['contrast'] }) },
    ...(Object.keys(SWITCHES) as SwitchKey[]).map((key) => ({ label: SWITCHES[key].label, hint: SWITCHES[key].hint, value: switched(key), options: onOff, patch: (value: string) => ({ [key]: value === 'on' }) })),
  ];
  if (form === 'side') return (
    <>
      <dl>{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{labelOf(row.options, row.value)}</dd></div>)}</dl>
      <p className="text-muted-foreground">{WORN_WORDS}</p>
    </>
  );
  const save = async (patch: Prefs) => {
    if (locked.current) return;
    locked.current = true; setState({ pending: true });
    try {
      await memberOperation('household.setPreferences', patch);
      act('set', {});
      if (shown.current) setState({ pending: false, message: 'Saved.' });
    } catch { if (shown.current) setState({ pending: false, message: SAVE_UNCONFIRMED }); }
    finally { locked.current = false; }
  };
  const group = (title: string, here: boolean) => (
    <>
      <h4>{title}</h4>
      {rows.filter((row) => !!row.here === here).map((row) => (
        <div key={row.label} className="board-line" role="group" aria-label={row.label}>
          <span>{row.label}</span>
          {row.options.map((option) => (
            <button key={option.value} type="button" className="board-action" aria-pressed={option.value === row.value} disabled={state.pending}
              aria-label={`${row.label}: ${option.label}`} onClick={() => { if (option.value !== row.value) void save(row.patch(option.value)); }}>{option.label}</button>
          ))}
          {row.hint && <small className="text-muted-foreground">{row.hint}</small>}
        </div>
      ))}
    </>
  );
  return (
    <>
      <p className="board-lead">Yours alone, on every device you sign in on.</p>
      <p>{WORN_WORDS}</p>
      <p role="status">{state.pending ? 'Saving…' : state.message ?? ''}</p>
      {group('Takes effect on this page', true)}
      {group('For the desktop', false)}
    </>
  );
}
