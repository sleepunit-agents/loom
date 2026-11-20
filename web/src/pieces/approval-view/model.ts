import { publicProposalTitle, type CardFact } from '../../../../src/proposal-words';
export type { CardFact } from '../../../../src/proposal-words';
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
  /** For a household owner looking at a waiting household card: the card as the program says it to an owner, with
   * the names it holds and what the change would replace (household.proposalPreview). Not on the card itself. */
  exactRequest?: string;
  storedSummary?: string;
  card?: { title: string; nothing: boolean; facts: readonly CardFact[]; exact: string; ifYes?: string; ifNo?: string } | null;
  /** For the same owner: the plain line saying this cannot be allowed and what would fix it. The answer operation still decides. */
  blocked?: string | null;
}
export const approvalTitle = (approval: Approval) => approval.operation === 'household.change' ? publicProposalTitle(approval) : approval.what;
export interface Rule {
  kind: Approval['kind']; scope: string; person: string; tier: 'do' | 'tell' | 'ask'; setBy: string; setAt: string;
}
export interface Notice { id: string; agent: string; kind: string; target: string; what: string; at: string }
export interface Record { seq: number; at: string; event: string; approval: string; agent: string; note: string }
export function quotedDecision(row: Record | undefined): string | undefined {
  if (row?.event === 'allow' && row.note.startsWith('Allowed by ')) return row.note;
  if (row?.event === 'deny' && row.note.startsWith('Denied by ')) return row.note;
}
export interface ApprovalSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  approvals: readonly Approval[]; rules: readonly Rule[]; notices: readonly Notice[]; record: readonly Record[];
  timezone: string;
}
/** Every stored word in plain words, said in this one place. */
export const kindWord: { [kind in Approval['kind']]: string } = { merge: 'merge', command: 'command', setting: 'setting', dangerous: 'dangerous action' };
/** What a rule answers, as a choice a person reads. */
export const kindChoice: { [kind in Approval['kind']]: string } = { merge: 'Merging a pull request', command: 'Running a command on a machine', setting: 'Changing a setting', dangerous: 'Another dangerous action' };
export const tierWord: { [tier in Rule['tier']]: string } = { ask: 'Ask me', tell: 'Tell me after', do: 'Just do it' };
/** A rule's scope as a person would say it: everything, a project, or the pattern as it was written. */
export const scopeWord = (scope: string) => scope === '*' ? 'Everything' : scope.startsWith('project:') ? `Project ${scope.slice(8)}` : scope;
export const ruleKey = (rule: Pick<Rule, 'kind' | 'scope' | 'person'>) => JSON.stringify([rule.kind, rule.scope, rule.person]);
/** One line of an approval's permanent record. An answer quoted from a conversation is said in its own words. */
export function recordWord(row: Record, name: (id: string) => string): string {
  const quoted = quotedDecision(row);
  if (quoted) return quoted;
  const who = /^[\w.-]+$/.test(row.note) ? name(row.note) : '';
  const note = row.note && !who ? `: ${row.note}` : '';
  switch (row.event) {
    case 'request': return `Asked${row.note ? `: ${row.note}` : ''}`;
    case 'allow': return who ? `Allowed by ${who}` : `Allowed${note}`;
    case 'deny': return who ? `Denied by ${who}` : `Denied${note}`;
    case 'use': return row.note.startsWith('Reported step: ') ? `Reported: ${row.note.slice('Reported step: '.length)}` : 'Used';
    case 'withdraw': return 'Withdrawn';
    case 'grant': return `Made a standing rule${row.note ? `: ${row.note}` : ''}`;
    case 'refused-use': return `Use refused${row.note ? `: ${row.note}` : ''}`;
    default: return row.event;
  }
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
    && (!query.trim() || matches(a.operation === 'household.change' ? [approvalTitle(a), a.why] : [a.id, a.what, a.ask, a.why, a.target, a.agent, a.project, a.member], query)))
    .sort((a, b) => folder === 'pending' ? a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id)
      : b.askedAt.localeCompare(a.askedAt) || a.id.localeCompare(b.id));
}
