import type { SharedTask, SharedTaskComment, SharedTaskLink, SharedTaskChange } from './shared-view';

/** A single generated relational selection, including comment/link deltas.
 * Larger order priorities take precedence in the generated API.
 * Readiness is computed in SQL against all blockers, including hidden ones. So is whether a task is
 * shelved with a retired project; the app works neither out for itself. */
export const tasksQuery = `query Tasks {
  tasks(orderBy: {priority: {direction: asc, priority: 2}, position: {direction: asc, priority: 1}, id: {direction: asc, priority: 0}}) {
    id title type status priority position ownerKind owner project assigneeKind assignee
    goal why doneWhen description ask ifYes ifNo closeReason sourceKind sourceId
    commentCount isReady isShelved
    changeTasksByTask { changeRow { id repository number title state draft checks review waitingOn } }
    taskLinksByTask { task dependsOn type }
    taskCommentsByTask(orderBy: {seq: {direction: asc, priority: 0}}) { task seq actorKind actor at text }
  }
}`;
export interface TaskSelection extends SharedTask {
  changeTasksByTask: { changeRow: Omit<SharedTaskChange, 'task'> | null }[];
  commentCount: number;
  isReady: boolean;
  isShelved: boolean;
  taskLinksByTask: SharedTaskLink[];
  taskCommentsByTask: SharedTaskComment[];
}
export interface TasksSelection { tasks: TaskSelection[] }

/** Choices inherit each generated table's current outside-door visibility. */
export const taskChoicesQuery = `query TaskChoices { projects { id name projectMembersByProject { member } } agents { id } members { id } }`;
