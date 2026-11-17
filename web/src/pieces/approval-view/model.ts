// Selected query fields, matching the approved shared schema. The generated
// browser client will provide its result type when the composition connects it.
export interface Approval {
  id: string; kind: 'merge' | 'command' | 'setting' | 'dangerous'; target: string;
  actingFor?: string; operation?: string | null;
  what: string; why: string; agent: string; project: string | null; member: string | null;
  conversation: string | null; state: 'pending' | 'allowed' | 'denied' | 'used' | 'withdrawn' | 'expired';
  ask: string; ifYes: string; ifNo: string; details: string; changeSummary: string | null;
  askedAt: string; decidedBy: string | null; expiresAt: string | null;
  /** For a household owner looking at a waiting household card: what already stands against allowing it. Not on the card itself. */
  problem?: string | null;
}
export interface Rule {
  kind: Approval['kind']; scope: string; person: string; tier: 'do' | 'tell' | 'ask'; setBy: string; setAt: string;
}
export interface Notice { id: string; agent: string; kind: string; target: string; what: string; at: string }
export interface Record { seq: number; at: string; event: string; approval: string; agent: string; note: string }
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
