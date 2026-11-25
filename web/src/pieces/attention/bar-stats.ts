import type { TickPart } from '../../ticker';
import { useDataQuery } from '../../data/graphql';

/** Minimal Tempo facts; no trigger instructions, destinations or log notes. The ticker no longer shows the latest
 * event's raw name; its selection stays because two server tests hold this exact query to its policy and limit. */
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
/** Enrollment, and which machines have a condition open (a disk over its line, the container runtime not
 * answering): loom's own judgement of what each machine's worker read. No machine names, owner details or numbers. */
export const deskBoxesQuery = `query DeskBoxes { boxes { id revokedAt } boxReadings(where: {level: {ne: ok}}) { box } }`;
export interface DeskBoxesData { boxes: { id: string; revokedAt: string | null }[]; boxReadings?: { box: string }[] }
/** Connection configuration only; enabled does not imply connected or healthy. */
export const deskBridgesQuery = `query DeskBridges { bridgeConnections { id enabled } }`;
export interface DeskBridgesData { bridgeConnections: { id: string; enabled: boolean }[] }
/** Open changes only; no titles, bodies, repositories or merge authority. */
export const deskChangesQuery = `query DeskChanges { changes(where: {state: {eq: open}}) { id checks } }`;
export interface DeskChangesData { changes: { id: string; checks: 'passing' | 'failing' | 'running' | 'none' }[] }
/** Readiness is computed in SQL, including blockers the caller cannot see. */
export const deskTasksQuery = `query DeskTasks {
  inProgress: tasks(where: {status: {eq: in_progress}}) { id isShelved }
  readyTasks { id }
}`;
export interface DeskTasksData { inProgress: { id: string; isShelved: boolean }[]; readyTasks: { id: string }[] }
/** Counts only the policy-filtered records in this window. No legacy tile programs or health guesses. */
export function useDeskStats() {
  const subscriptions = useDataQuery<{modelAccounts:{label:string;level:string}[]}>(
    'query DeskSubscriptionLevels { modelAccounts { ... on RuntimeAccount { label level } } }');
  const accounts = subscriptions.status === 'live' ? subscriptions.data?.modelAccounts ?? [] : [];
  const boxes = useDataQuery<DeskBoxesData>(deskBoxesQuery);
  const tasks = useDataQuery<DeskTasksData>(deskTasksQuery);
  const taskData = tasks.status === 'live' ? tasks.data : undefined;
  const tempo = useDataQuery<DeskTempoData>(deskTempoQuery);
  const tempoData = tempo.status === 'live' ? tempo.data : undefined;
  const bridges = useDataQuery<DeskBridgesData>(deskBridgesQuery);
  const bridgeData = bridges.status === 'live' ? bridges.data : undefined;
  const changes = useDataQuery<DeskChangesData>(deskChangesQuery);
  const changeData = changes.status === 'live' ? changes.data : undefined;
  const enrolledBoxes = boxes.status === 'live' && boxes.data ? boxes.data.boxes.filter(b=>b.revokedAt===null) : undefined;
  const enrolled = enrolledBoxes?.length;
  // Machines, not conditions: two full disks on one machine are one machine to look at.
  const troubled = new Set((boxes.status === 'live' ? boxes.data?.boxReadings ?? [] : []).map(reading=>reading.box));
  const needLook = enrolledBoxes?.filter(b=>troubled.has(b.id)).length ?? 0;
  const open = changeData?.changes ?? [];
  const failing = open.filter(c=>c.checks==='failing').length;
  const activeTriggers = tempoData?.triggers.filter(t=>t.enabled && ['standing','due','firing','held'].includes(t.state)).length ?? 0;
  const failedTriggers = tempoData?.triggers.filter(t=>t.state==='failed').length ?? 0;
  const paused = tempoData?.agentPauses.length ?? 0;
  const enabledConnections = bridgeData?.bridgeConnections.filter(c=>c.enabled).length ?? 0;
  const parts: TickPart[] = [
    {text:taskData ? `Tasks · ${taskData.inProgress.filter(task => !task.isShelved).length} in progress · ${taskData.readyTasks.length} ready` : 'Tasks unavailable',href:'/p/work/backlog'},
    {text:tempoData ? `Tempo · ${activeTriggers} active trigger${activeTriggers===1?'':'s'} · ${paused} paused agent${paused===1?'':'s'}${failedTriggers?` · ${failedTriggers} failed`:''}` : 'Tempo unavailable',href:'/p/tempo',tone:failedTriggers?'bad':undefined},
    {text:bridgeData ? `Bridges · ${enabledConnections} enabled connection${enabledConnections===1?'':'s'}` : 'Bridges unavailable',href:'/p/bridges-preview'},
    {text:changeData ? `Changes · ${open.length} open${failing?` · ${failing} CI red`:''}` : 'Changes unavailable',href:'/p/work/changes',tone:failing?'bad':undefined},
  ];
  for (const {label,level} of accounts) {
    if (level === 'getting full' || level === 'almost full') {
      parts.push({text:label+' · '+level, href:'/p/subscriptions', capacity:level, tone:level === 'almost full' ? 'bad' : 'warn'});
    }
  }
  // Trouble first, preserving the normal order for equal tones.
  parts.sort((a,b)=>Number(b.tone==='bad')-Number(a.tone==='bad'));
  parts.push({text:enrolled===undefined?'Boxes unavailable':`${enrolled} enrolled box${enrolled===1?'':'es'}${needLook?` · ${needLook} need${needLook===1?'s':''} a look`:''}`,tone:needLook?'bad':undefined});
  return { parts, enrolled };
}
