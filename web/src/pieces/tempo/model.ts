/** Fields selected from the shared generated query, after server visibility filtering. */
export interface Trigger {
  id: string; ownerKind: 'member' | 'agent' | 'household'; owner: string | null;
  sourceKind: 'time' | 'pull-request' | 'answer' | 'job'; watches: string | null;
  times: string | null; days: string | null; lifespan: 'until-stopped' | 'today' | 'once';
  targetKind: 'operation' | 'inbox'; target: string | null; toKind: 'person' | 'agent' | null; to: string | null;
  project: string | null; instructions: string | null; file: string | null; note: string; enabled: boolean;
  scheduleRemovedAt?: string | null;
  wantsModel?: string | null; needs?: string[] | null; prefers?: string[] | null;
  state: 'standing' | 'due' | 'firing' | 'held' | 'fired' | 'stopped' | 'failed';
  nextDueAt: string | null; lastFiredAt: string | null; createdAt: string; changedAt: string;
}
export interface TriggerEvent { seq: number; trigger: string; at: string; event: string; note: string }
/** A missed log row can summarize the rest of a long gap. Its timestamp is
 * when Tempo recorded the gap, which can cover more than one household day. */
export function recordedOutcomes(entries: readonly {state:string; note?:string; scheduled:boolean}[]): string[] {
  const totals = new Map<string, number>();
  let missedLowerBound = false;
  for (const entry of entries) {
    if (entry.scheduled) continue;
    let count = 1;
    if (entry.state === 'missed') {
      const summary = /^(more than )?(\d+) more(?:$|, the last at time:)/.exec(entry.note ?? '');
      if (summary) {
        count = Number(summary[2]);
        if (summary[1]) missedLowerBound = true;
      }
    }
    totals.set(entry.state,(totals.get(entry.state) ?? 0)+count);
  }
  return [...totals].map(([state,count])=> state === 'missed'
    ? (missedLowerBound ? 'More than ' : '')+count+(count === 1 && !missedLowerBound ? ' missed run reported' : ' missed runs reported')
    : count+' '+state);
}
export interface AgentPause { agent: string; since: string }
export type Folder = 'all' | 'due' | 'standing' | 'lanes';
export const folders: { id: Folder | 'history'; label: string }[] = [
  { id: 'all', label: 'All triggers' }, { id: 'due', label: 'Due' }, { id: 'standing', label: 'Standing' },
  { id: 'lanes', label: 'Household lanes' }, { id: 'history', label: 'Recent history' },
];
export const title = (trigger: Trigger) => trigger.note || trigger.file || trigger.id;
export const triggerAgent = (trigger: Trigger) => trigger.toKind === 'agent' ? trigger.to : !trigger.toKind && trigger.ownerKind === 'agent' ? trigger.owner : null;
export const terminal = (trigger: Trigger) => ['fired', 'stopped', 'failed'].includes(trigger.state);
export const nextScheduledAt = (trigger: Trigger) => trigger.enabled && !terminal(trigger) ? trigger.nextDueAt : null;
function nextOrder(trigger: Trigger) {
  const at = nextScheduledAt(trigger);
  return at ? Date.parse(at) : Infinity;
}
export const lane = (trigger: Trigger) => trigger.ownerKind === 'household' && trigger.sourceKind === 'time'
  && trigger.lifespan !== 'once' && !!(trigger.instructions || trigger.file);

/** A held once-only wait stays in Due, including waits with no time deadline. */
export function inFolder(trigger: Trigger, folder: Folder): boolean {
  if (folder === 'all') return true;
  if (terminal(trigger)) return false;
  if (folder === 'lanes') return lane(trigger);
  if (folder === 'standing') return !lane(trigger) && trigger.lifespan !== 'once';
  return trigger.lifespan === 'once' || ['due', 'firing', 'held'].includes(trigger.state);
}

export function rows(triggers: readonly Trigger[], folder: Folder, search = '', agent = ''): Trigger[] {
  const query = search.trim().toLocaleLowerCase();
  return triggers.filter(trigger => inFolder(trigger, folder)
    && (!agent || triggerAgent(trigger) === agent)
    && [title(trigger), trigger.id, trigger.to, trigger.owner, trigger.project, trigger.watches,
      trigger.instructions, trigger.file].join(' ').toLocaleLowerCase().includes(query))
    .sort((a, b) => nextOrder(a) - nextOrder(b) || a.id.localeCompare(b.id));
}

export const eventLabels = {
  'pull-request': 'A pull request changes',
  answer: 'An answer arrives',
  job: 'A job stops',
} satisfies Record<Exclude<Trigger['sourceKind'], 'time'>, string>;

export function source(trigger: Trigger): string {
  if (trigger.sourceKind === 'time') return [trigger.times, trigger.days || (trigger.lifespan === 'once' ? '' : 'Every day')].filter(Boolean).join(' · ');
  return `${eventLabels[trigger.sourceKind]}${trigger.watches ? ` · ${trigger.watches}` : ''}`;
}
export const target = (trigger: Trigger) => trigger.targetKind === 'operation'
  ? `Operation: ${trigger.target}` : `An item in ${trigger.to}'s inbox`;
export function history(events: readonly TriggerEvent[], trigger: string): TriggerEvent[] {
  return events.filter(event => event.trigger === trigger && event.event !== 'source-snapshot').sort((a, b) => b.seq - a.seq);
}
export function status(trigger: Trigger, pauses: readonly AgentPause[]): string {
  return !terminal(trigger) && !!triggerAgent(trigger) && pauses.some(pause => pause.agent === triggerAgent(trigger))
    ? 'Held · agent paused' : trigger.state;
}
