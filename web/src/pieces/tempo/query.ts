import type { AgentPause, Trigger } from './model';

/** Generated shared-schema selection. The outside door supplies current SQL
 * visibility for each table; this module never chooses a caller or a policy. */
export const tempoQuery = `query Tempo {
  tempoTimezone
  triggers {
    id ownerKind owner sourceKind watches times days lifespan targetKind target toKind to
    project needs prefers instructions file note enabled state nextDueAt lastFiredAt createdAt changedAt
  }
  agentPauses { agent since }
}`;
export const triggerHistoryQuery = `query TriggerHistory($id: String!) {
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
