/** The words for a task's fixed choices, in one place: the Tasks forms and the boards page's bricks both say them.
 * Plain values, no component. */
/** A priority's words by its number, 0 to 4. */
export const taskPriorities = ['P0 · most urgent', 'P1', 'P2', 'P3', 'P4 · least urgent'] as const;
export const taskTypes = { task: 'Task', bug: 'Bug', feature: 'Feature', epic: 'Epic' } as const;
/** What a new task is unless its form says otherwise (src/apps/tasks.ts, taskCreateSchema). */
export const taskDefaultPriority = 2;
