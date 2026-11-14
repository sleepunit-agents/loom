import { useRecords, type LiveRecord, type Snapshot } from '../../data';
import type { TickPart } from '../../ticker';
import type { Task } from '../tasks/model';
import type { Wake } from '../clock/model';
import type { VenueRecord } from '../bridges/model';
import type { ChangeRecord } from '../changes/model';

export interface DeskBox extends LiveRecord { id: string; revokedAt?: number }
const current = <T extends {id:string}>(s: Snapshot<T>): readonly T[] => s.status === 'live' ? s.records : [];
/** Counts only the policy-filtered records in this window. No legacy tile programs or health guesses. */
export function useDeskStats() {
  const boxes = useRecords<DeskBox>('runtime.box');
  const tasks = useRecords<Task>('task');
  const wakes = useRecords<Wake>('wake');
  const venues = useRecords<VenueRecord>('bridges.venue');
  const changes = useRecords<ChangeRecord>('change');
  const enrolled = boxes.status === 'live' ? current(boxes).filter(b=>b.revokedAt===undefined).length : undefined;
  const open = current(changes).filter(c=>c.state==='open');
  const failing = open.filter(c=>c.checks.state==='failing').length;
  const activeWakes = current(wakes).filter(w=>['pending','parked','held','firing'].includes(w.state)).length;
  const enabledVenues = current(venues).filter(v=>v.enabled).length;
  const parts: TickPart[] = [
    {text:tasks.status==='live' ? `Tasks · ${current(tasks).filter(t=>t.status==='in_progress').length} in progress · ${current(tasks).filter(t=>t.ready).length} ready` : 'Tasks unavailable',href:'/p/tasks-preview'},
    {text:wakes.status==='live' ? `Clock · ${activeWakes} active wake${activeWakes===1?'':'s'}` : 'Clock unavailable',href:'/p/clock-preview'},
    {text:venues.status==='live' ? `Bridges · ${enabledVenues} enabled venue${enabledVenues===1?'':'s'}` : 'Bridges unavailable',href:'/p/bridges-preview'},
    {text:changes.status==='live' ? `Changes · ${open.length} open${failing?` · ${failing} CI red`:''}` : 'Changes unavailable',href:'/p/changes-preview',tone:failing?'bad':undefined},
  ];
  // Trouble first, preserving the normal order for equal tones.
  parts.sort((a,b)=>Number(b.tone==='bad')-Number(a.tone==='bad'));
  parts.push({text:enrolled===undefined?'Boxes unavailable':`${enrolled} enrolled box${enrolled===1?'':'es'} · health unavailable`});
  return { parts, enrolled };
}
