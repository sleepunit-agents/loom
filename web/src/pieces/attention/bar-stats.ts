import { useRecords, type LiveRecord, type Snapshot } from '../../data';
import type { TickPart } from '../../ticker';
import type { Task } from '../tasks/model';
import { useDataQuery } from '../../data/graphql';
import type { VenueRecord } from '../bridges/model';
import type { ChangeRecord } from '../changes/model';

/** Minimal Tempo facts; no trigger instructions, destinations or log notes. */
export const deskTempoQuery = `query DeskTempo {
  triggers { id enabled state }
  triggerLog(orderBy: {seq: {direction: desc, priority: 0}}, limit: 1) { seq event }
  agentPauses { agent }
}`;
export interface DeskTempoData {
  triggers: { id: string; enabled: boolean; state: string }[];
  triggerLog: { seq: number; event: string }[];
  agentPauses: { agent: string }[];
}
export interface DeskBox extends LiveRecord { id: string; revokedAt?: number }
const current = <T extends {id:string}>(s: Snapshot<T>): readonly T[] => s.status === 'live' ? s.records : [];
/** Counts only the policy-filtered records in this window. No legacy tile programs or health guesses. */
export function useDeskStats() {
  const boxes = useRecords<DeskBox>('runtime.box');
  const tasks = useRecords<Task>('task');
  const tempo = useDataQuery<DeskTempoData>(deskTempoQuery);
  const tempoData = tempo.status === 'live' ? tempo.data : undefined;
  const venues = useRecords<VenueRecord>('bridges.venue');
  const changes = useRecords<ChangeRecord>('change');
  const enrolled = boxes.status === 'live' ? current(boxes).filter(b=>b.revokedAt===undefined).length : undefined;
  const open = current(changes).filter(c=>c.state==='open');
  const failing = open.filter(c=>c.checks.state==='failing').length;
  const activeTriggers = tempoData?.triggers.filter(t=>t.enabled && ['standing','due','firing','held'].includes(t.state)).length ?? 0;
  const failedTriggers = tempoData?.triggers.filter(t=>t.state==='failed').length ?? 0;
  const paused = tempoData?.agentPauses.length ?? 0;
  const latest = tempoData?.triggerLog[0];
  const enabledVenues = current(venues).filter(v=>v.enabled).length;
  const parts: TickPart[] = [
    {text:tasks.status==='live' ? `Tasks · ${current(tasks).filter(t=>t.status==='in_progress').length} in progress · ${current(tasks).filter(t=>t.ready).length} ready` : 'Tasks unavailable',href:'/p/tasks-preview'},
    {text:tempoData ? `Tempo · ${activeTriggers} active trigger${activeTriggers===1?'':'s'} · ${paused} paused agent${paused===1?'':'s'}${failedTriggers?` · ${failedTriggers} failed`:''}${latest?` · Last event: ${latest.event}`:''}` : 'Tempo unavailable',href:'/p/tempo-preview',tone:failedTriggers?'bad':undefined},
    {text:venues.status==='live' ? `Bridges · ${enabledVenues} enabled venue${enabledVenues===1?'':'s'}` : 'Bridges unavailable',href:'/p/bridges-preview'},
    {text:changes.status==='live' ? `Changes · ${open.length} open${failing?` · ${failing} CI red`:''}` : 'Changes unavailable',href:'/p/changes-preview',tone:failing?'bad':undefined},
  ];
  // Trouble first, preserving the normal order for equal tones.
  parts.sort((a,b)=>Number(b.tone==='bad')-Number(a.tone==='bad'));
  parts.push({text:enrolled===undefined?'Boxes unavailable':`${enrolled} enrolled box${enrolled===1?'':'es'} · health unavailable`});
  return { parts, enrolled };
}
