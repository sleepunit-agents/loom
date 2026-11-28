import { displayName } from '../../kit/words';
/** Fields selected from the approved shared model; no second persisted record. */
export interface Change {
  id: string; repository: string; number: number; title: string; body: string; url: string;
  state: 'open' | 'merged' | 'closed'; draft: boolean; authorLogin: string;
  project: string | null; agent: string | null; branch: string; headCommit: string; baseBranch: string;
  checks: 'passing' | 'failing' | 'running' | 'none'; review: 'approved' | 'changes_requested' | 'required' | 'not_required';
  mergeable: 'yes' | 'no' | 'unknown'; waitingOn: 'you' | 'agent' | 'ci' | 'reviewer' | 'author' | 'done';
  openedAt: string; updatedAt: string; closedAt: string | null;
}
export interface ReviewRound {
  change: string;
  job: string;
  headCommit: string;
  tier: 'medium' | 'high';
  round: number;
  verdict: 'CLEAR' | 'BLOCKING' | 'NONE' | null;
  /** The session that reviewed it (a frozen review's handoff conversation); none for a cold review. */
  conversation?: string | null;
  findings: string | null;
}
export interface ChangeSnapshot {
  reviewHistory?: { change: string; status: ChangeSnapshot['status']; rounds: readonly ReviewRound[] };
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
/** Every stored state word in plain words, said in this one place (the server's own are in src/pieces/changes/model.ts). */
export const checksWord: Record<Change['checks'], string> = { passing: 'Checks passing', failing: 'Checks failing', running: 'Checks running', none: 'No checks' };
export const checkWord: Record<'failing' | 'running', string> = { failing: 'Failing', running: 'Running' };
export const reviewWord: Record<Change['review'], string> = { approved: 'Approved', changes_requested: 'Changes requested', required: 'Review needed', not_required: 'No review needed' };
export const stateWord: Record<Change['state'], string> = { open: 'Open', merged: 'Merged', closed: 'Closed' };
export const mergeableWord: Record<Change['mergeable'], string> = { yes: 'Yes', no: 'No', unknown: 'Not known yet' };
export const roleWord: Record<ChangeSnapshot['people'][number]['role'], string> = { author: 'Author', reviewer: 'Reviewed it', requested: 'Asked to review', assignee: 'Assigned', commenter: 'Commented' };
type Stated = Pick<Change, 'state' | 'waitingOn'> & Partial<Pick<Change, 'agent' | 'draft'>>;
/** Who it waits on, as one short state: the row's whole status. "you" is the person who answers the merge; "agent"
 * the agent that will merge it, by name; "ci" the checks (or GitHub still working out whether it can merge);
 * "reviewer" a review it needs; "author" whoever opened it (a draft, a conflict, failing checks, changes asked
 * for); "done" merged or closed. */
export function waitingWord(c: Stated, name: (id: string) => string = displayName): string {
  if (c.state !== 'open') return stateWord[c.state];
  const on: Record<Change['waitingOn'], string> = { you: 'Waiting on you', agent: c.agent ? `Waiting on ${name(c.agent)}` : 'Waiting on its agent', ci: 'Waiting on the checks',
    reviewer: 'Waiting on a reviewer', author: 'Waiting on its author', done: 'Done' };
  return on[c.waitingOn] ?? c.waitingOn;
}
/** A row's one short state. Where a change waits on its author for a reason the row can say, it says the reason. */
export function rowWord(c: Stated & Partial<Pick<Change, 'checks' | 'review'>>, name?: (id: string) => string): string {
  const why = c.state !== 'open' || c.waitingOn !== 'author' ? '' : c.draft ? 'Draft' : c.checks === 'failing' ? checksWord.failing : c.review === 'changes_requested' ? reviewWord.changes_requested : '';
  return why || `${waitingWord(c, name)}${c.draft ? ' · Draft' : ''}`;
}
/** The whole of it on one quiet line: checks, review, who it waits on. */
export const summary = (c: Stated & Pick<Change, 'checks' | 'review'>, name?: (id: string) => string) =>
  `${c.state === 'open' ? `${checksWord[c.checks] ?? c.checks} · ${reviewWord[c.review] ?? c.review} · ${waitingWord(c, name)}` : stateWord[c.state]}${c.draft ? ' · Draft' : ''}`;
export function rows(snapshot: ChangeSnapshot, folder: string, query: string) {
  if (snapshot.status !== 'live') return [];
  const words = query.trim().toLowerCase().split(/\s+/);
  return snapshot.changes.filter(c => (folder === 'you' ? c.waitingOn === 'you' : folder.startsWith('project:') ? c.project === folder.slice(8) : true)
    && words.every(w => [c.id, c.title, c.body, c.repository, c.project, c.authorLogin].join(' ').toLowerCase().includes(w)))
    .sort((a,b) => (folder === 'lately' ? 0 : order.indexOf(a.waitingOn) - order.indexOf(b.waitingOn)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
