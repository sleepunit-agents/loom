import type { SharedTask, SharedTaskComment, SharedTaskLink } from './shared-view';

/** A single generated relational selection, including comment/link deltas.
 * Readiness is computed in SQL against all blockers, including hidden ones. */
export const tasksQuery = `query Tasks {
  tasks(orderBy: {priority: {direction: asc, priority: 0}, position: {direction: asc, priority: 1}, id: {direction: asc, priority: 2}}) {
    id title type status priority position ownerKind owner project assigneeKind assignee
    goal why doneWhen description ask ifYes ifNo closeReason sourceKind sourceId
    commentCount isReady
    taskLinksByTask { task dependsOn type }
    taskCommentsByTask(orderBy: {seq: {direction: asc, priority: 0}}) { task seq actorKind actor at text }
  }
}`;
export interface TaskSelection extends SharedTask {
  commentCount: number;
  isReady: boolean;
  taskLinksByTask: SharedTaskLink[];
  taskCommentsByTask: SharedTaskComment[];
}
export interface TasksSelection { tasks: TaskSelection[] }
