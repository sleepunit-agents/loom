import type { TaskListRow, TaskReaderFields, SharedTaskComment, SharedTaskLink, SharedTaskChange } from './shared-view';

export const notePageSize = 30;
const noteSelection = `orderBy:{seq:{direction:desc,priority:0}},limit:${notePageSize+1}`;
const noteFields = 'task seq actorKind actor at text';
export const earlierNotesQuery = `query EarlierTicketNotes($selected:String!,$before:Int!) {
  notes:taskComments(where:{task:{eq:$selected},seq:{lt:$before}},${noteSelection}) { ${noteFields} }
}`;

const detailFields = `
  id createdAt createdBy closedAt doneWhen ifYes ifNo sourceKind sourceId
  projectRow { id name }
  changeTasksByTask { changeRow { id repository number title openedAt closedAt state draft checks review waitingOn } }
  taskCommentsByTask(${noteSelection}) { ${noteFields} }
`;

/** The list can include the opening task’s details when entered by direct link.
 * Larger order priorities take precedence in the generated API.
 * Readiness is computed in SQL against all blockers, including hidden ones. So is whether a task is
 * shelved with a retired project; the app works neither out for itself. */
export const tasksQuery = `query Tasks($selected: String! = "", $withComments: Boolean! = false) {
  tasks(orderBy: {priority: {direction: asc, priority: 2}, position: {direction: asc, priority: 1}, id: {direction: asc, priority: 0}}) {
    id title type status priority position ownerKind owner project assigneeKind assignee
    goal why description ask closeReason
    isReady isShelved
    taskLinksByTask { task dependsOn type }
  }
  selectedTask: tasksSingle(where: {id: {eq: $selected}}) @include(if: $withComments) {
    ${detailFields}
  }
}`;
export const taskCommentsQuery = `query TaskComments($selected: String!) {
  selectedTask: tasksSingle(where: {id: {eq: $selected}}) { ${detailFields} }
}`;
export interface TaskSelection extends TaskListRow {
  isReady: boolean;
  isShelved: boolean;
  taskLinksByTask: SharedTaskLink[];
}
export interface TasksSelection {
  tasks: TaskSelection[];
  selectedTask?: TaskReaderFields & {
    id: string;
    projectRow: { id: string; name: string } | null;
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
