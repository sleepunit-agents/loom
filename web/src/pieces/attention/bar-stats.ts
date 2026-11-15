import { useRecords, type Snapshot } from '../../data';
import type { TickPart } from '../../ticker';
import type { Task } from '../tasks/model';
import { useDataQuery } from '../../data/graphql';

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
/** Enrollment is distinct from worker health; no machine names or owner details. */
export const deskBoxesQuery = `query DeskBoxes { boxes { id revokedAt } }`;
export interface DeskBoxesData { boxes: { id: string; revokedAt: string | null }[] }
/** Connection configuration only; enabled does not imply connected or healthy. */
export const deskBridgesQuery = `query DeskBridges { bridgeConnections { id enabled } }`;
export interface DeskBridgesData { bridgeConnections: { id: string; enabled: boolean }[] }
/** Open changes only; no titles, bodies, repositories or merge authority. */
export const deskChangesQuery = `query DeskChanges { changes(where: {state: {eq: open}}) { id checks } }`;
export interface DeskChangesData { changes: { id: string; checks: 'passing' | 'failing' | 'running' | 'none' }[] }
const current = <T extends {id:string}>(s: Snapshot<T>): readonly T[] => s.status === 'live' ? s.records : [];
/** Counts only the policy-filtered records in this window. No legacy tile programs or health guesses. */
export function useDeskStats() {
  const boxes = useDataQuery<DeskBoxesData>(deskBoxesQuery);
  const tasks = useRecords<Task>('task');
  const tempo = useDataQuery<DeskTempoData>(deskTempoQuery);
  const tempoData = tempo.status === 'live' ? tempo.data : undefined;
  const bridges = useDataQuery<DeskBridgesData>(deskBridgesQuery);
  const bridgeData = bridges.status === 'live' ? bridges.data : undefined;
  const changes = useDataQuery<DeskChangesData>(deskChangesQuery);
  const changeData = changes.status === 'live' ? changes.data : undefined;
  const enrolled = boxes.status === 'live' && boxes.data ? boxes.data.boxes.filter(b=>b.revokedAt===null).length : undefined;
  const open = changeData?.changes ?? [];
  const failing = open.filter(c=>c.checks==='failing').length;
  const activeTriggers = tempoData?.triggers.filter(t=>t.enabled && ['standing','due','firing','held'].includes(t.state)).length ?? 0;
  const failedTriggers = tempoData?.triggers.filter(t=>t.state==='failed').length ?? 0;
  const paused = tempoData?.agentPauses.length ?? 0;
  const latest = tempoData?.triggerLog[0];
  const enabledConnections = bridgeData?.bridgeConnections.filter(c=>c.enabled).length ?? 0;
  const parts: TickPart[] = [
    {text:tasks.status==='live' ? `Tasks · ${current(tasks).filter(t=>t.status==='in_progress').length} in progress · ${current(tasks).filter(t=>t.ready).length} ready` : 'Tasks unavailable',href:'/p/tasks-preview'},
    {text:tempoData ? `Tempo · ${activeTriggers} active trigger${activeTriggers===1?'':'s'} · ${paused} paused agent${paused===1?'':'s'}${failedTriggers?` · ${failedTriggers} failed`:''}${latest?` · Last event: ${latest.event}`:''}` : 'Tempo unavailable',href:'/p/tempo-preview',tone:failedTriggers?'bad':undefined},
    {text:bridgeData ? `Bridges · ${enabledConnections} enabled connection${enabledConnections===1?'':'s'}` : 'Bridges unavailable',href:'/p/bridges-preview'},
    {text:changeData ? `Changes · ${open.length} open${failing?` · ${failing} CI red`:''}` : 'Changes unavailable',href:'/p/changes-preview',tone:failing?'bad':undefined},
  ];
  // Trouble first, preserving the normal order for equal tones.
  parts.sort((a,b)=>Number(b.tone==='bad')-Number(a.tone==='bad'));
  parts.push({text:enrolled===undefined?'Boxes unavailable':`${enrolled} enrolled box${enrolled===1?'':'es'} · health unavailable`});
  return { parts, enrolled };
}
