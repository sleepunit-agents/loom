/** A ticket as the household's task reads return it, and the commands a member's page sends about one: types only.
 * The boards page's ticket bricks (boards/bricks-ticket*.tsx) and data/task-command.ts read these. */
import type { changes } from '../../../../src/core/data/schema';
import type { ReviewRound } from '../change-view/model';

/** Field projection accepted from the shared query client; no runtime schema or record adapter. */
export interface SharedTask {
  id: string; title: string; type: 'task' | 'bug' | 'feature' | 'epic';
  status: 'open' | 'in_progress' | 'closed'; priority: number; position: number;
  ownerKind: 'member' | 'agent' | 'household'; owner: string | null; project: string | null;
  assigneeKind: 'member' | 'agent' | null; assignee: string | null;
  goal: string; why: string; doneWhen: string; description: string;
  ask: string | null; ifYes: string | null; ifNo: string | null; closeReason: string | null;
  sourceKind: string | null; sourceId: string | null;
  /** Unfinished, in a retired project: shown under its project marked shelved, and counted nowhere as open work. */
  isShelved?: boolean;
  createdAt?: string; createdBy?: string; closedAt?: string | null;
}
export interface SharedTaskLink { task: string; dependsOn: string; type: 'blocks' | 'parent-child' }
export interface SharedTaskComment { task: string; seq: number; actorKind: 'member' | 'agent'; actor: string; at: string; text: string }
export type SharedTaskChange = Pick<typeof changes.$inferSelect, 'id' | 'repository' | 'number' | 'title' | 'state' | 'draft' | 'checks' | 'review' | 'waitingOn'> & { task: string; openedAt?: string; closedAt?: string | null };
export interface TicketPost { task:string; id:string; at:string; agent:string; thread:string; words:string }
export type GithubReview = {id:string;change:string;login:string|null;submittedAt:string;headCommit:string|null;
  state:'COMMENTED'|'CHANGES_REQUESTED'|'DISMISSED'|'APPROVED';body:string;url:string};
export type TicketReview = ReviewRound & {requestedAt: string; completedAt: string | null};
export type TaskReaderFields = Pick<SharedTask, 'createdAt' | 'createdBy' | 'closedAt' | 'doneWhen' | 'ifYes' | 'ifNo' | 'sourceKind' | 'sourceId'>;
export type TaskListRow = Omit<SharedTask, keyof TaskReaderFields>;
export type TaskAction = 'promote' | 'create' | 'claim' | 'unclaim' | 'close' | 'reopen' | 'comment' | 'edit' | 'priority' | 'project' | 'parent' | 'link' | 'ask';

type Person = { kind: 'member' | 'agent'; id: string };
type Summary = Pick<SharedTask, 'title' | 'goal' | 'why' | 'doneWhen' | 'description' | 'priority' | 'project'>;
/** Commands contain intent only. The authenticated root supplies the actor. */
export type TaskCommand =
  | { action: 'create'; input: Summary & { type: SharedTask['type']; owner: Person | { kind: 'household' }; parent?: string; source?: { kind: 'conversation'; id: string } } }
  | { action: 'edit'; id: string; input: Partial<Summary> & {type?: 'epic'} }
  | { action: 'claim' | 'unclaim' | 'reopen'; id: string }
  | { action: 'close'; id: string; reason: string }
  | { action: 'comment'; id: string; text: string }
  | { action: 'link' | 'unlink'; id: string; dependsOn: string; type: 'blocks' | 'parent-child' }
  | { action: 'answer'; id: string; question: string; answer: 'yes' | 'no' | 'words'; text?: string }
  | { action: 'ask'; id: string; input: { to: { kind: 'member'; id: string }; ask: string; ifYes: string; ifNo: string; answers: 'yes-no' | 'words' } };
