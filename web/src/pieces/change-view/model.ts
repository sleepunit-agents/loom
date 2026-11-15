/** Fields selected from the approved shared model; no second persisted record. */
export interface Change {
  id: string; repository: string; number: number; title: string; body: string; url: string;
  state: 'open' | 'merged' | 'closed'; draft: boolean; authorLogin: string;
  project: string | null; agent: string | null; branch: string; headCommit: string; baseBranch: string;
  checks: 'passing' | 'failing' | 'running' | 'none'; review: 'approved' | 'changes_requested' | 'required' | 'not_required';
  mergeable: 'yes' | 'no' | 'unknown'; waitingOn: 'you' | 'agent' | 'ci' | 'reviewer' | 'author' | 'done';
  openedAt: string; updatedAt: string; closedAt: string | null;
}
export interface ChangeSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  changes: readonly Change[];
  checks: readonly { change: string; name: string; state: 'failing' | 'running' }[];
  people: readonly { change: string; login: string; role: 'author' | 'reviewer' | 'requested' | 'assignee' | 'commenter' }[];
  links: readonly { change: string; task: string }[];
  tasks: readonly { id: string; title: string; status: string }[];
  sync: { readAt: string | null; failed: boolean; nextAt: string | null } | null;
  timezone: string;
}
const order = ['you', 'agent', 'ci', 'reviewer', 'author', 'done'];
export const summary = (c: Pick<Change, 'state' | 'checks' | 'review' | 'waitingOn' | 'draft'>) => `${c.state === 'open' ? `CI ${c.checks}, ${c.review.replaceAll('_', ' ')}, Waiting on ${c.waitingOn}` : c.state}${c.draft ? ' · Draft' : ''}`;
export function rows(snapshot: ChangeSnapshot, folder: string, query: string) {
  if (snapshot.status !== 'live') return [];
  const words = query.trim().toLowerCase().split(/\s+/);
  return snapshot.changes.filter(c => (folder === 'you' ? c.waitingOn === 'you' : folder.startsWith('project:') ? c.project === folder.slice(8) : true)
    && words.every(w => [c.id, c.title, c.body, c.repository, c.project, c.authorLogin].join(' ').toLowerCase().includes(w)))
    .sort((a,b) => (folder === 'lately' ? 0 : order.indexOf(a.waitingOn) - order.indexOf(b.waitingOn)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
