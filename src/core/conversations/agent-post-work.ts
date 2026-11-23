import { and, getTableColumns, inArray } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { citations } from '../../pieces/changes/model.js';
import { taskPath } from '../../task-route.js';
import type { DataDatabase } from '../data/database.js';
import { changes, tasks } from '../data/schema.js';
import { taskShelved } from '../data/project-in-use.js';
import { taskVisibility } from '../data/visibility.js';
import { workVisibility } from '../data/work-visibility.js';
import { refsIn } from './refs.js';

interface WorkLink { id: string; title: string; state: string; href: string }

/** A post can mention work that the current reader cannot open. Only expand a mention
 * with a title and state when the owning app would return the record to this reader. */
export function agentPostWork(db: DataDatabase, viewer: Viewer, words: string, refs: readonly string[]): WorkLink[] {
  const taskIds = [...new Set([...refsIn(words),...refs])].filter(id => id.startsWith('t-'));
  const changeIds = [...new Set([...citations(words), ...refs.filter(id=>id.startsWith('github:')).flatMap(citations)])];
  const links: WorkLink[] = [];
  if (taskIds.length) {
    const visible = taskVisibility(viewer).tasks!(getTableColumns(tasks));
    const rows = db.select({id:tasks.id,title:tasks.title,status:tasks.status,shelved:taskShelved(tasks).mapWith(Boolean)})
      .from(tasks).where(and(visible,inArray(tasks.id,taskIds))).all();
    for (const row of rows) links.push({id:row.id,title:row.title,
      state:row.shelved?'shelved':row.status.replace(/_/g,' '),href:taskPath(row.id)});
  }
  if (changeIds.length) {
    const visible = workVisibility(viewer).changes!(getTableColumns(changes));
    const rows = db.select({id:changes.id,title:changes.title,state:changes.state,draft:changes.draft})
      .from(changes).where(and(visible,inArray(changes.id,changeIds))).all();
    for (const row of rows) links.push({id:row.id,title:row.title,
      state:row.state==='open' && row.draft?'draft':row.state,href:'/p/changes-preview/change/'+encodeURIComponent(row.id)});
  }
  return links;
}
