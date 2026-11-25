import { and, getTableColumns, inArray, sql } from 'drizzle-orm';
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

type CitedPost = { words: string; refs: readonly string[] };

function workIds(post: CitedPost) {
  const tasks = new Set([...refsIn(post.words), ...post.refs].filter(id => id.startsWith('t-')));
  const changes = new Set([...citations(post.words), ...post.refs.filter(id => id.startsWith('github:')).flatMap(citations)]);
  return Array.from(tasks).sort().concat(Array.from(changes).sort());
}

/** Work links are resolved only if the caller selects them. Each page shares one lookup per
 * kind, under the owning app's current visibility rules for this viewer. */
export function workForPage(db: DataDatabase, viewer: Viewer, posts: CitedPost[]) {
  let links: Map<CitedPost, WorkLink[]> | undefined;
  return (post: CitedPost) => {
    if (!links) {
      const ids = posts.map(workIds);
      const visible = visibleWork(db, viewer, [...new Set(ids.flat())]);
      links = new Map(posts.map((row, i) => [row, ids[i].flatMap(id => visible.get(id) ?? [])]));
    }
    return links.get(post) ?? [];
  };
}

function visibleWork(db: DataDatabase, viewer: Viewer, ids: string[]) {
  const taskIds = ids.filter(id => id.startsWith('t-'));
  const changeIds = ids.filter(id => id.startsWith('github:'));
  const links = new Map<string, WorkLink>();
  // One bound array per kind also fits SQLite's parameter limit on long history pages.
  if (taskIds.length) {
    const visible = taskVisibility(viewer).tasks!(getTableColumns(tasks));
    const rows = db.select({id:tasks.id,title:tasks.title,status:tasks.status,shelved:taskShelved(tasks).mapWith(Boolean)})
      .from(tasks).where(and(visible,inArray(tasks.id,sql`(select value from json_each(${JSON.stringify(taskIds)}))`))).all();
    for (const row of rows) links.set(row.id,{id:row.id,title:row.title,
      state:row.shelved?'shelved':row.status.replace(/_/g,' '),href:taskPath(row.id)});
  }
  if (changeIds.length) {
    const visible = workVisibility(viewer).changes!(getTableColumns(changes));
    const rows = db.select({id:changes.id,title:changes.title,state:changes.state,draft:changes.draft})
      .from(changes).where(and(visible,inArray(changes.id,sql`(select value from json_each(${JSON.stringify(changeIds)}))`))).all();
    for (const row of rows) links.set(row.id,{id:row.id,title:row.title,
      state:row.state==='open' && row.draft?'draft':row.state,href:'/p/work/changes/change/'+encodeURIComponent(row.id)});
  }
  return links;
}
