import { and, desc, eq, getTableColumns, gt, gte, inArray, isNotNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { DataDatabase } from '../data/database.js';
import { agentPosts, agentPostThreads, jobs, tasks, terminalSessions } from '../data/schema.js';
import { allActivitySourcesMatch, readableActivitySources } from './agent-posts.js';
import { terminalSilenceMs } from './terminal-sessions.js';
import type { WordsKey } from './words.js';

/** A running terminal may report tickets even when its conversation belongs to no project.
 * Only its latest explicit work list during this job is current. */
export async function reportedSessions(
  db: DataDatabase,
  key: WordsKey,
  viewer: Viewer,
  allowed: SQL,
  now: () => string,
  project?: string,
  task?: string,
) {
  if (viewer.kind !== 'member' || (project == null) === (task == null)) return [];
  const scope = sqlVisibility(viewer, ['tasks', 'jobs', 'conversations', 'projects']);
  const current = () =>
    db
      .select({
        id: jobs.id,
        agent: jobs.agent,
        thread: terminalSessions.thread,
        heardAt: jobs.heardAt,
        queuedAt: jobs.queuedAt,
      })
      .from(jobs)
      .innerJoin(terminalSessions, eq(terminalSessions.job, jobs.id))
      .where(
        and(
          scope.jobs(getTableColumns(jobs)),
          eq(jobs.state, 'running'),
          eq(jobs.startedByKind, 'terminal'),
          gt(jobs.heardAt, new Date(Date.parse(now()) - terminalSilenceMs).toISOString()),
        ),
      )
      .all();
  const latest = (thread: string, since: string) =>
    db
      .select({ seq: agentPosts.seq, at: agentPosts.at, refs: agentPosts.workRefs })
      .from(agentPosts)
      .innerJoin(agentPostThreads, eq(agentPostThreads.id, agentPosts.thread))
      .where(
        and(
          eq(agentPosts.source, thread),
          gte(agentPosts.at, since),
          isNotNull(agentPosts.workRefs),
          allActivitySourcesMatch(db, readableActivitySources(db, viewer, allowed)),
        ),
      )
      .orderBy(desc(agentPosts.seq))
      .limit(1)
      .get();
  const rows = await Promise.all(
    current().map(async (job) => {
      const post = job.thread && latest(job.thread, job.queuedAt);
      if (!post || !post.refs) return;
      const refs: unknown = JSON.parse(await key.open(post.refs));
      if (!Array.isArray(refs)) return;
      const live = current().find((row) => row.id === job.id && row.thread === job.thread);
      if (!live || latest(job.thread!, job.queuedAt)?.seq !== post.seq) return;
      const ids = refs.filter((id): id is string => typeof id === 'string' && id.startsWith('t-'));
      if (!ids.length) return;
      const work = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            scope.tasks(getTableColumns(tasks)),
            inArray(tasks.id, ids),
            project != null ? eq(tasks.project, project) : eq(tasks.id, task!),
          ),
        )
        .all();
      if (work.length)
        return {
          id: job.id,
          agent: job.agent,
          at: post.at,
          heardAt: live.heardAt,
          tasks: work.map((t) => t.id),
        };
    }),
  );
  return rows.filter((row) => row !== undefined);
}
