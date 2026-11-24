import type { SharedTask, SharedTaskComment, SharedTaskLink, SharedTaskChange } from './shared-view';

const detailFields = `
  id
  changeTasksByTask { changeRow { id repository number title state draft checks review waitingOn } }
  taskCommentsByTask(orderBy: {seq: {direction: asc, priority: 0}}) { task seq actorKind actor at text }
`;

/** The list can include the opening task’s comments when entered by direct link.
 * Larger order priorities take precedence in the generated API.
 * Readiness is computed in SQL against all blockers, including hidden ones. So is whether a task is
 * shelved with a retired project; the app works neither out for itself. */
export const tasksQuery = `query Tasks($selected: String! = "", $withComments: Boolean! = false) {
  tasks(orderBy: {priority: {direction: asc, priority: 2}, position: {direction: asc, priority: 1}, id: {direction: asc, priority: 0}}) {
    id title type status priority position ownerKind owner project assigneeKind assignee
    goal why doneWhen description ask ifYes ifNo closeReason sourceKind sourceId
    commentCount isReady isShelved
    taskLinksByTask { task dependsOn type }
  }
  selectedTask: tasksSingle(where: {id: {eq: $selected}}) @include(if: $withComments) {
    ${detailFields}
  }
}`;
export const taskCommentsQuery = `query TaskComments($selected: String!) {
  selectedTask: tasksSingle(where: {id: {eq: $selected}}) { ${detailFields} }
}`;
export interface TaskSelection extends SharedTask {
  commentCount: number;
  isReady: boolean;
  isShelved: boolean;
  taskLinksByTask: SharedTaskLink[];
}
export interface TasksSelection {
  tasks: TaskSelection[];
  selectedTask?: {
    id: string;
    taskCommentsByTask: SharedTaskComment[];
    changeTasksByTask: { changeRow: Omit<SharedTaskChange, 'task'> | null }[];
  } | null;
}

/** Choices inherit each generated table's current outside-door visibility. */
export const taskChoicesQuery = `query TaskChoices { projects { id name projectMembersByProject { member } } agents { id removedAt } members { id } }`;

/** The task’s reader and the source conversation may have different audiences. */
export const taskSourceQuery = `query TaskSource($id:String!) {
  source:conversationsSingle(where:{id:{eq:$id}}) { id venue place }
}`;
