import type { approvals, approvalRules, approvalNotices, approvalRecord } from '../../../../src/core/data/schema';

export type Approval = Pick<typeof approvals.$inferSelect,
  'id' | 'kind' | 'target' | 'what' | 'why' | 'agent' | 'project' | 'member' | 'conversation' | 'state' |
  'ask' | 'ifYes' | 'ifNo' | 'details' | 'changeSummary' | 'askedAt' | 'decidedBy' | 'expiresAt'>;
export type Rule = typeof approvalRules.$inferSelect;
export type Notice = typeof approvalNotices.$inferSelect;
export type Record = typeof approvalRecord.$inferSelect;
export interface ApprovalSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  approvals: readonly Approval[]; rules: readonly Rule[]; notices: readonly Notice[]; record: readonly Record[];
  timezone: string;
}
export const folders = [
  { id: 'pending', label: 'Pending' }, { id: 'history', label: 'History' },
  { id: 'rules', label: 'Rules' }, { id: 'notices', label: 'Reported steps' },
];
export function matches(values: readonly (string | null)[], query: string) {
  const words = query.toLowerCase().trim().split(/\s+/);
  const text = values.join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}
export function rows(snapshot: ApprovalSnapshot, folder: string, query: string) {
  if (snapshot.status !== 'live') return [];
  return snapshot.approvals.filter(a => (folder === 'pending' ? a.state === 'pending' : a.state !== 'pending')
    && matches([a.id, a.what, a.ask, a.why, a.target, a.agent, a.project, a.member], query))
    .sort((a, b) => folder === 'pending' ? a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id)
      : b.askedAt.localeCompare(a.askedAt) || a.id.localeCompare(b.id));
}
