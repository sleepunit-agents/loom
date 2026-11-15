import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentAccounts, changes, changeChecks, changePeople, changeTasks, changeSync, projectRepositories, tasks } from '../core/data/schema.js';
import { changeSchema, repoId, tasksCited, waitsOn, type Change, type Rule } from '../pieces/changes/model.js';

export type ChangeRow = typeof changes.$inferSelect;
export type ChangeDetail = ChangeRow & {
  checksDetail: (typeof changeChecks.$inferSelect)[];
  people: (typeof changePeople.$inferSelect)[];
  tasks: { id: string; title: string; status: string }[];
};
export type MergeRuleReader = (target: string, agent: string) => Rule | undefined;
export type PullRequestReader = (repository: string, now: number) => Promise<Change[]>;
const order = ['you', 'agent', 'ci', 'reviewer', 'author', 'done'];

export class AttributionConflict extends Error {}
function agentFor(db:DataDatabase,login:string){
 const found=db.select().from(agentAccounts).where(and(eq(agentAccounts.service,'github'),sql`lower(${agentAccounts.login}) = ${login.toLowerCase()}`)).all();
 if(new Set(found.map(row=>row.agent)).size>1)throw new AttributionConflict('GitHub login belongs to more than one agent');
 return found[0]?.agent??null;
}

function projectFor(db: DataDatabase, repository: string) {
  const found = db.select().from(projectRepositories).all().filter(r => repoId(r.repository) === repoId(repository));
  if (new Set(found.map(r => r.project)).size > 1) throw new Error('Repository belongs to more than one project');
  return found[0]?.project ?? null;
}

/** Copy GitHub facts into the shared model. A reader performs the outside IO;
 * rendering and sorting read this cache only. Merge answers belong to Approvals,
 * and this module never merges a PR itself.
 */
export function changeService(db: DataDatabase, rule: MergeRuleReader, now: () => string = () => new Date().toISOString(),
  commit: <T>(run: () => T) => T = run => db.transaction(run)) {
  const get = (id: string): ChangeRow => {
    const row = db.select().from(changes).where(eq(changes.id, id)).get();
    if (!row) throw new Error('Change not found');
    return row;
  };
  const store = (raw: Change) => {
    const c = changeSchema.parse(raw), repository = repoId(c.repo).slice(7);
    const project = projectFor(db, repository);
    // Attribution comes from the household's GitHub account rows, never a branch prefix.
    const agent=agentFor(db,c.author.login);
    const id = `github:${repository}#${c.number}`;
    if (c.id !== id) throw new Error('Pull request identity differs from repository and number');
    if (!c.created || !c.updated) throw new Error('Pull request timestamps are required');
    const held = { ...c, ...(agent ? { agent } : {}) };
    const waitingOn = waitsOn(held, agent ? rule(`${id}@${c.head.id}`, agent) : undefined).group;
    const row: typeof changes.$inferInsert = {
      id, repository, number: c.number, title: c.title, body: c.body, url: c.url,
      state: c.state, draft: c.draft, authorLogin: c.author.login, project, agent,
      branch: c.head.ref, headCommit: c.head.id, baseBranch: c.base.ref,
      checks: c.checks.state, review: c.review.state, mergeable: c.mergeable, waitingOn,
      openedAt: new Date(c.created).toISOString(), updatedAt: new Date(c.updated).toISOString(), closedAt: c.closed ? new Date(c.closed).toISOString() : null,
    };
    db.insert(changes).values(row).onConflictDoUpdate({ target: changes.id, set: row }).run();
    db.delete(changeChecks).where(eq(changeChecks.change, id)).run();
    // A failing check wins if GitHub names it in both lists.
    const checks = new Map<string, 'running' | 'failing'>();
    for (const name of c.checks.running) checks.set(name, 'running');
    for (const name of c.checks.failing) checks.set(name, 'failing');
    for (const [name, state] of checks) db.insert(changeChecks).values({ change: id, name, state }).run();
    db.delete(changePeople).where(eq(changePeople.change, id)).run();
    const roles = ['author', 'reviewer', 'requested', 'assignee', 'commenter'] as const;
    for (const p of [...c.people, { login: c.author.login, role: 'author' }]) {
      if (!(roles as readonly string[]).includes(p.role)) continue;
      db.insert(changePeople).values({ change: id, login: p.login, role: p.role as typeof roles[number] }).onConflictDoNothing().run();
    }
    db.delete(changeTasks).where(eq(changeTasks.change, id)).run();
    const cited = tasksCited(c);
    if (cited.length) for (const task of db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, cited)).all()) db.insert(changeTasks).values({ change: id, task: task.id }).run();
    return get(id);
  };
  return {
    put(input: Change) { return commit(() => store(input)); },
    get(id: string): ChangeDetail {
      return { ...get(id), checksDetail: db.select().from(changeChecks).where(eq(changeChecks.change, id)).all(),
        people: db.select().from(changePeople).where(eq(changePeople.change, id)).orderBy(asc(changePeople.role), asc(changePeople.login)).all(),
        tasks: db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(changeTasks).innerJoin(tasks, eq(changeTasks.task, tasks.id)).where(eq(changeTasks.change, id)).orderBy(asc(tasks.priority), asc(tasks.position)).all() };
    },
    list() { return db.select().from(changes).all().sort((a, b) => order.indexOf(a.waitingOn) - order.indexOf(b.waitingOn) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)); },
    syncStatus() { return db.select().from(changeSync).get(); },
    async sync(read: PullRequestReader, nextAt: string) {
      // Collect before starting a transaction. A failed or malformed read leaves the
      // previous complete cache intact and marks the sync failed for the tile.
      try {
        const repositories = [...new Set(db.select().from(projectRepositories).all().map(r => repoId(r.repository).slice(7)))];
        const rows: Change[] = [];
        for (const repository of repositories) {
          projectFor(db, repository);
          for (const c of await read(repository, Date.parse(now()))) {
            if (repoId(c.repo).slice(7) !== repository) throw new Error('Reader returned another repository');
            rows.push(c);
          }
        }
        return commit(() => {
          const stored = rows.map(store);
          db.insert(changeSync).values({ readAt: now(), failed: false, nextAt }).onConflictDoUpdate({ target: changeSync.singleton, set: { readAt: now(), failed: false, nextAt } }).run();
          return stored;
        });
      } catch {
        commit(() => db.insert(changeSync).values({ failed: true, nextAt }).onConflictDoUpdate({ target: changeSync.singleton, set: { failed: true, nextAt } }).run());
        throw new Error('GitHub read unavailable');
      }
    },
  };
}

/** Trusted repository-label refresh. The caller owns the enclosing DataWrites
 * transaction and current write authority. No GitHub facts or timestamps change.
 * Returning IDs lets that caller report affected Changes without another feed. */
export function reprojectChanges(db: DataDatabase): string[] {
  return db.transaction(() => {
    // Validate every current mapping before changing any cached label.
    const updates = db.select({ id: changes.id, repository: changes.repository, project: changes.project }).from(changes).all()
      .map(row => ({ ...row, nextProject: projectFor(db, row.repository) }))
      .filter(row => row.project !== row.nextProject);
    for (const row of updates) db.update(changes).set({ project: row.nextProject }).where(eq(changes.id, row.id)).run();
    return updates.map(row => row.id);
  });
}

/** Trusted account metadata edits refresh attribution and its derived group together. */
export function reattributeChanges(db:DataDatabase,rule:MergeRuleReader=()=>undefined){
 return db.transaction(()=>{
  const updates=db.select().from(changes).all().map(row=>{
   const agent=agentFor(db,row.authorLogin),waitingOn=waitsOn({state:row.state,draft:row.draft,mergeable:row.mergeable,conflicts:row.mergeable==='no',checks:{state:row.checks},review:{state:row.review},...(agent?{agent}:{})},agent?rule(`${row.id}@${row.headCommit}`,agent):undefined).group;
   return{row,agent,waitingOn};
  });
  for(const {row,agent,waitingOn}of updates)if(row.agent!==agent||row.waitingOn!==waitingOn)db.update(changes).set({agent,waitingOn}).where(eq(changes.id,row.id)).run();
  return updates.filter(({row,agent,waitingOn})=>row.agent!==agent||row.waitingOn!==waitingOn).map(({row})=>row.id);
 });
}
