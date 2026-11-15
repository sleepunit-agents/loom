import type { ApprovalSnapshot } from '../pieces/approval-view/model';
import type { ChangeSnapshot } from '../pieces/change-view/model';

/** Selections from the generated shared schema, filtered by the outside door's
 * SQL policies. A connected task is selected through the visible link only. */
export const approvalsQuery = `query ApprovalsView {
  approvals { id kind target what why agent project member conversation state
    ask ifYes ifNo details changeSummary askedAt decidedBy expiresAt }
  approvalRules { kind scope person tier setBy setAt }
  approvalNotices { id agent kind target what at }
  approvalRecord { seq at event approval agent note }
}`;
export const changesQuery = `query ChangesView {
  changes { id repository number title body url state draft authorLogin project
    agent branch headCommit baseBranch checks review mergeable waitingOn
    openedAt updatedAt closedAt }
  changeChecks { change name state }
  changePeople { change login role }
  changeTasks { change task taskRow { id title status } }
  changeSync { readAt failed nextAt }
}`;
export interface ApprovalsResult {
  approvals: ApprovalSnapshot['approvals'];
  approvalRules: ApprovalSnapshot['rules'];
  approvalNotices: ApprovalSnapshot['notices'];
  approvalRecord: ApprovalSnapshot['record'];
}
export interface ChangesResult {
  changes: ChangeSnapshot['changes'];
  changeChecks: ChangeSnapshot['checks'];
  changePeople: ChangeSnapshot['people'];
  changeTasks: readonly { change: string; task: string; taskRow: ChangeSnapshot['tasks'][number] | null }[];
  changeSync: readonly NonNullable<ChangeSnapshot['sync']>[];
}
type Feed<T> = { status: ApprovalSnapshot['status']; data?: T };
export function approvalSnapshot(feed: Feed<ApprovalsResult>, timezone: string): ApprovalSnapshot {
  const data = feed.status === 'live' ? feed.data : undefined;
  return { status: feed.status === 'live' && !data ? 'loading' : feed.status, timezone,
    approvals: data?.approvals ?? [], rules: data?.approvalRules ?? [],
    notices: data?.approvalNotices ?? [], record: data?.approvalRecord ?? [] };
}
export function changeSnapshot(feed: Feed<ChangesResult>, timezone: string): ChangeSnapshot {
  const data = feed.status === 'live' ? feed.data : undefined;
  const links = data?.changeTasks.filter(link => link.taskRow && link.taskRow.id === link.task) ?? [];
  const tasks = new Map(links.map(link => [link.task, link.taskRow!]));
  return { status: feed.status === 'live' && !data ? 'loading' : feed.status, timezone,
    changes: data?.changes ?? [], checks: data?.changeChecks ?? [], people: data?.changePeople ?? [],
    links: links.map(({ change, task }) => ({ change, task })), tasks: [...tasks.values()],
    sync: data?.changeSync[0] ?? null };
}
