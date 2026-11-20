// Which addresses show tasks (t-2029; tasks-live.ts): tiny, so the first page carries only this, and the tasks' live
// records load as their own chunk when such a page is first shown.
//
// `/p/tasks…` and an agent's `/a/<agent>/p/tasks…`: the work page itself shows nothing but tasks (`live`); a task's own
// page shows its comments and description, which the records held here don't carry, so it's asked on both (`also`), as
// is a project's page, which shows other pieces' work too.
const TASKS = /^\/(?:a\/[a-z][a-z0-9-]{0,39}\/)?p\/tasks(\/[^?#]*)?(?:[?#]|$)/;
const PROJECTS = /^\/projects(?:\/[^?#]*)?(?:[?#]|$)/;
export function tasksPageKind(url: string): 'live' | 'also' | null {
  if (CHANGES.test(url)) return 'also';
  const m = TASKS.exec(url);
  if (m) return !m[1] || m[1] === '/' ? 'live' : 'also';
  return PROJECTS.test(url) ? 'also' : null;
}

/** `/p/changes…` and an agent's: Changes' pages, drawn by the piece, which show rule verdicts too (so `also`). */
const CHANGES = /^\/(?:a\/[a-z][a-z0-9-]{0,39}\/)?p\/changes(?:\/[^?#]*)?(?:[?#]|$)/;

/** Which records a page moves with: `tasks`, `changes`, both (a project's page), or none. */
export function pulseOf(url: string): string {
  if (CHANGES.test(url)) return 'changes';
  if (PROJECTS.test(url)) return 'tasks,changes';
  return tasksPageKind(url) ? 'tasks' : '';
}
