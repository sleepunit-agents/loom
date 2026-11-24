import type { AgentPause, Trigger } from './model';

/** Generated shared-schema selection. The outside door supplies current SQL
 * visibility for each table; this module never chooses a caller or a policy. */
const triggerFields = `
  id ownerKind owner sourceKind watches times days lifespan targetKind target toKind to
  project needs prefers wantsModel instructions file note enabled state nextDueAt lastFiredAt createdAt changedAt scheduleRemovedAt
`;
const householdFields = 'tempoTimezone agentPauses { agent since }';
export const tempoQuery = `query Tempo {
  triggers { ${triggerFields} }
  ${householdFields}
}`;
export const tempoCardQuery = `query TempoCard($id: String!) {
  triggers(where: {id: {eq: $id}}, limit: 1) { ${triggerFields} }
  ${householdFields}
}`;
export const triggerHistoryQuery = `query TriggerHistory($id: String!) {
  tempoRecentRuns(id: $id)
  triggerLog(where: {trigger: {eq: $id}, event: {ne: "source-snapshot"}},
    orderBy: {seq: {direction: desc, priority: 0}}, limit: 200) {
    seq trigger at event note
  }
}`;
export interface TempoData {
  tempoTimezone?: string | null;
  triggers: Trigger[];
  agentPauses: AgentPause[];
}
