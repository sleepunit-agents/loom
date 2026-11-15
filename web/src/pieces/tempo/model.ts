/** Fields selected from the shared generated query, after server visibility filtering. */
export interface Trigger {
  id: string; ownerKind: 'member' | 'agent' | 'household'; owner: string | null;
  sourceKind: 'time' | 'pull-request' | 'answer' | 'job'; watches: string | null;
  times: string | null; days: string | null; lifespan: 'until-stopped' | 'today' | 'once';
  targetKind: 'operation' | 'inbox'; target: string | null; toKind: 'person' | 'agent' | null; to: string | null;
  project: string | null; instructions: string | null; file: string | null; note: string; enabled: boolean;
  state: 'standing' | 'due' | 'firing' | 'held' | 'fired' | 'stopped' | 'failed';
  nextDueAt: string | null; lastFiredAt: string | null; createdAt: string; changedAt: string;
}
export interface TriggerEvent { seq: number; trigger: string; at: string; event: string; note: string }
export interface AgentPause { agent: string; since: string }
export type Folder = 'due' | 'standing' | 'lanes' | 'history';
export const folders: { id: Folder; label: string }[] = [
  { id: 'due', label: 'Due' }, { id: 'standing', label: 'Standing' },
  { id: 'lanes', label: 'Household lanes' }, { id: 'history', label: 'Recent history' },
];
export const title = (trigger: Trigger) => trigger.note || trigger.file || trigger.id;
export const terminal = (trigger: Trigger) => ['fired', 'stopped', 'failed'].includes(trigger.state);
export const lane = (trigger: Trigger) => trigger.ownerKind === 'household' && trigger.sourceKind === 'time'
  && trigger.lifespan !== 'once' && !!(trigger.instructions || trigger.file);

/** A held once-only wait stays in Due, including waits with no time deadline. */
export function inFolder(trigger: Trigger, folder: Folder): boolean {
  if (folder === 'history') return terminal(trigger);
  if (terminal(trigger)) return false;
  if (folder === 'lanes') return lane(trigger);
  if (folder === 'standing') return !lane(trigger) && trigger.lifespan !== 'once';
  return trigger.lifespan === 'once' || ['due', 'firing', 'held'].includes(trigger.state);
}

export function rows(triggers: readonly Trigger[], folder: Folder, search = '', agent = ''): Trigger[] {
  const query = search.trim().toLocaleLowerCase();
  return triggers.filter(trigger => inFolder(trigger, folder)
    && (!agent || trigger.toKind === 'agent' && trigger.to === agent)
    && [title(trigger), trigger.id, trigger.to, trigger.owner, trigger.project, trigger.watches,
      trigger.instructions, trigger.file].join(' ').toLocaleLowerCase().includes(query))
    .sort((a, b) => folder === 'history'
      ? Date.parse(b.changedAt) - Date.parse(a.changedAt) || a.id.localeCompare(b.id)
      : (a.nextDueAt ? Date.parse(a.nextDueAt) : Infinity) - (b.nextDueAt ? Date.parse(b.nextDueAt) : Infinity) || a.id.localeCompare(b.id));
}

export function source(trigger: Trigger): string {
  if (trigger.sourceKind === 'time') return [trigger.times, trigger.days || (trigger.lifespan === 'once' ? '' : 'Every day')].filter(Boolean).join(' · ');
  return `${({ 'pull-request': 'A pull request changes', answer: 'An answer arrives', job: 'A job stops' })[trigger.sourceKind]}${trigger.watches ? ` · ${trigger.watches}` : ''}`;
}
export const target = (trigger: Trigger) => trigger.targetKind === 'operation'
  ? `Operation: ${trigger.target}` : `An item in ${trigger.to}'s inbox`;
export function history(events: readonly TriggerEvent[], trigger: string): TriggerEvent[] {
  return events.filter(event => event.trigger === trigger && event.event !== 'source-snapshot').sort((a, b) => b.seq - a.seq);
}
export function status(trigger: Trigger, pauses: readonly AgentPause[]): string {
  return !terminal(trigger) && trigger.toKind === 'agent' && pauses.some(pause => pause.agent === trigger.to)
    ? 'Held · agent paused' : trigger.state;
}
