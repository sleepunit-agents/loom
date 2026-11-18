import type { AgentPause, Trigger, TriggerEvent } from './model';

/** Generated shared-schema selection. The outside door supplies current SQL
 * visibility for each table; this module never chooses a caller or a policy. */
export const tempoQuery = `query Tempo {
  tempoTimezone
  tempoMachineReviewer
  boxes { id name revokedAt }
  triggers {
    id ownerKind owner sourceKind watches times days lifespan targetKind target toKind to
    conversation member machine machineApproval machineRow { name } machineApprovalRow { decidedAt decidedBy } project instructions file note enabled state nextDueAt lastFiredAt createdAt changedAt
  }
  triggerLog(orderBy: {seq: {direction: desc, priority: 0}}, limit: 200) {
    seq trigger at event note
  }
  agentPauses { agent since }
}`;
export interface TempoData {
  tempoMachineReviewer?: string | null;
  tempoTimezone?: string | null;
  boxes?: { id: string; name: string; revokedAt: string | null }[];
  triggers: Trigger[];
  triggerLog: TriggerEvent[];
  agentPauses: AgentPause[];
}
