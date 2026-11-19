/** Home's current-job projection, and what each agent is doing. The outside composition supplies its current
 * SQL policy for jobs and for what a job is said by (conversations, machines, triggers, tasks); this module never invents sharing rules or reads credentials. */
import { and, asc, desc, eq, getTableColumns, inArray, is, ne, or, isNotNull, sql, SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { DataDatabase } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { alias } from 'drizzle-orm/sqlite-core';
import { boxes, conversations, jobs, tasks, terminalRuns, triggers } from '../core/data/schema.js';
import { wakePlaceTriggers } from '../core/tempo/tempo.js';
import { TASK_ID } from '../slug.js';
import { unendedJobStates } from '../core/data/job-states.js';
import { jobUsageFields } from './job-usage-queries.js';
import { exitStage } from './job-exit.js';

import { terminalSilenceMs } from '../core/conversations/terminal-sessions.js';
export function nextTerminalDeadline(db: DataDatabase, now: number) {
  const cutoff = new Date(now - terminalSilenceMs).toISOString();
  const found = db.select({at: jobs.heardAt}).from(jobs).where(and(eq(jobs.startedByKind, 'terminal'),
    isNotNull(jobs.conversation), inArray(jobs.state, unendedJobStates), sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`))
    .orderBy(asc(sql`julianday(${jobs.heardAt})`)).limit(1).get();
  return found?.at ? Date.parse(found.at) + terminalSilenceMs : undefined;
}

/** What an agent is doing now, one entry per thing: the parts of a short phrase, never the sentence. The web
 * builds the words from the parts in one place (web/src/pieces/attention/doing.tsx, `doingPhrase`).
 *
 * `kind` says which phrase: a terminal session a person is driving, a conversation on a bridge or in Comms,
 * a hand-off taken from another agent, a trigger's firing, a wake with no trigger to name, a task in progress,
 * a job that is none of these, or `private`: a job in a conversation this viewer may not read, which carries
 * nothing of that conversation (no venue, place, person, title or link). */
export type DoingKind = 'terminal' | 'discord' | 'slack' | 'loom' | 'handoff' | 'trigger' | 'wake' | 'task' | 'job' | 'private';
export interface Doing {
  /** The job's id, or the task's. */
  id: string; kind: DoingKind;
  /** The conversation's label, the trigger's note, the task's or the job's title. */
  title: string | null;
  /** Who it is with, as an id: the member of a private conversation, or the agent a hand-off came from. */
  with: string | null;
  /** A channel as its venue names it ("#pond"). */
  place: string | null;
  /** A direct message: with one person, or a group. */
  direct: 'person' | 'group' | null;
  /** A task's id ("t-2190"). */
  ref: string | null;
  /** The name of the machine it runs on, where the viewer may read that machine. */
  machine: string | null;
  since: string; state: string;
  /** The in-app path that opens it. */
  href: string | null;
}
/** How many entries one read returns unless it asks for more (an agent's own page does); the rest are counted in `more`. */
export const doingCap = 8, doingMost = 100;
/** Things a person is in come first, then what a schedule or another agent started and plain jobs, then tasks. */
const doingRank: Record<DoingKind, number> = { terminal: 0, discord: 0, slack: 0, loom: 0, private: 0, handoff: 1, trigger: 1, wake: 1, job: 1, task: 2 };
const threadPath = (place: string) => `/p/comms-preview/thread/${encodeURIComponent(place.replace(/^th:/, ''))}`;
const conversationPath = (id: string) => `/p/comms-preview/conversation/${encodeURIComponent(id)}`;
/** As web/src/pieces/tasks/route.ts writes a task's segment: a current id as it is, an imported one marked. */
const currentTaskId = new RegExp(`^${TASK_ID}$`);
const taskPath = (id: string) => `/p/tasks-preview/task/${currentTaskId.test(id) ? id : '~' + encodeURIComponent(id)}`;
/** A bridge place (pieces/bridges/place.ts): [workspace, channel, thread, who a direct message is private to]. */
function bridgePlace(place: string): { group: boolean } {
  try { const parts: unknown = JSON.parse(place); return { group: Array.isArray(parts) && Array.isArray(parts[3]) && parts[3][0] === 'group' }; } catch { return { group: false }; }
}
/** The channel a Discord label names (pieces/bridges/place.ts, discordPlace): a thread is named by itself. */
const discordChannel = (label: string) => /^Discord (?:channel|thread) (#[^\n]{1,100}?)(?: under #[^\n]{1,100})?$/u.exec(label)?.[1] ?? null;

export class JobSummaries {
  constructor(readonly db: DataDatabase, readonly visibility: () => QueryVisibility, readonly now = Date.now, readonly observed?: () => void) {}
  allowed() {
    const allowed = this.visibility().jobs?.(getTableColumns(jobs));
    if (!is(allowed, SQL)) throw new Error('SQL visibility required for jobs');
    return allowed;
  }
  current(agent: string) {
    const allowed = this.allowed();
    this.observed?.();
    const cutoff = new Date(this.now() - terminalSilenceMs).toISOString();
    return this.db.select({ id: jobs.id, agent: jobs.agent, title: jobs.title,
      kind: sql<string>`case when ${jobs.startedByKind} = 'terminal' then 'terminal' else 'job' end`,
      state: jobs.state, box: jobs.box, queuedAt: jobs.queuedAt }).from(jobs)
      .where(and(allowed, eq(jobs.agent, agent), inArray(jobs.state, unendedJobStates),
        or(ne(jobs.startedByKind, 'terminal'), and(isNotNull(jobs.conversation), sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`))))
      .orderBy(asc(jobs.queuedAt), asc(jobs.id)).all();
  }
  private rule(name: 'conversations' | 'boxes' | 'tasks' | 'triggers') {
    const rule = this.visibility()[name];
    if (typeof rule !== 'function') throw new Error(`SQL visibility required for ${name}`);
    // A rule that answered with nothing would be dropped from the join it guards, leaving it open: refuse, as allowed() does.
    return ((columns: Parameters<typeof rule>[0]) => {
      const answer = rule(columns);
      if (!is(answer, SQL)) throw new Error(`SQL visibility required for ${name}`);
      return answer;
    }) as typeof rule;
  }
  /** What the agent is doing now, for its card: its current jobs, each said by where it runs, and the tasks
   * it has in progress.
   *
   * Each source is read under its own rule and nothing here states one. A job row is the jobs rule's. Its
   * conversation's venue, place, label and member are joined only where the conversations rule lets this
   * viewer read that conversation; where it does not, the entry is `private` and carries none of them. A
   * machine's name is joined under the machines rule, the agent a hand-off came from under the jobs rule
   * (the job it was handed from), a trigger's note under the triggers rule, a task under the tasks rule.
   *
   * Three statements at most, whatever the number of rows: jobs with their conversations and machines,
   * triggers (only when a visible wake names one), tasks. */
  doing(agent: string, limit = doingCap): { items: Doing[]; more: number } {
    if (!Number.isInteger(limit) || limit < 1 || limit > doingMost) throw new Error(`Doing limit must be 1–${doingMost}`);
    const allowed = this.allowed(), from = alias(jobs, 'doing_handed_from');
    const fromRule = this.visibility().jobs!(getTableColumns(from));
    if (!is(fromRule, SQL)) throw new Error('SQL visibility required for jobs');
    const seen = { conversations: this.rule('conversations'), boxes: this.rule('boxes'), tasks: this.rule('tasks'), triggers: this.rule('triggers') };
    this.observed?.();
    const cutoff = new Date(this.now() - terminalSilenceMs).toISOString();
    const rows = this.db.select({ id: jobs.id, title: jobs.title, state: jobs.state, startedByKind: jobs.startedByKind, startedBy: jobs.startedBy,
      queuedAt: jobs.queuedAt, claimedAt: jobs.claimedAt, inConversation: jobs.conversation,
      conversation: conversations.id, venue: conversations.venue, place: conversations.place, label: conversations.label,
      direct: conversations.direct, member: conversations.member, machine: boxes.name, handedFrom: from.agent }).from(jobs)
      .leftJoin(conversations, and(eq(conversations.id, jobs.conversation), seen.conversations(getTableColumns(conversations))))
      .leftJoin(boxes, and(eq(boxes.id, jobs.box), seen.boxes(getTableColumns(boxes))))
      .leftJoin(from, and(eq(conversations.venue, 'handoff'), eq(from.id, conversations.place), fromRule))
      .where(and(allowed, eq(jobs.agent, agent), inArray(jobs.state, unendedJobStates),
        or(ne(jobs.startedByKind, 'terminal'), and(isNotNull(jobs.conversation), sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`))))
      .all();
    // The trigger a visible wake's place names (core/tempo/tempo.ts, wakePlace), or the one a program's job records.
    const named = (row: typeof rows[number]) => row.venue === 'wake' && row.place !== null
      ? [...(row.startedByKind === 'program' ? [row.startedBy] : []), ...wakePlaceTriggers(row.place)]
      : !row.inConversation && row.startedByKind === 'program' ? [row.startedBy] : [];
    const wanted = [...new Set(rows.flatMap(named))];
    const notes = new Map((wanted.length ? this.db.select({ id: triggers.id, note: triggers.note, file: triggers.file }).from(triggers)
      .where(and(seen.triggers(getTableColumns(triggers)), inArray(triggers.id, wanted))).all() : []).map(row => [row.id, row.note || row.file || row.id]));
    const working = this.db.select({ id: tasks.id, title: tasks.title, startedAt: tasks.startedAt, changedAt: tasks.changedAt }).from(tasks)
      .where(and(seen.tasks(getTableColumns(tasks)), eq(tasks.assigneeKind, 'agent'), eq(tasks.assignee, agent), eq(tasks.status, 'in_progress'))).all();
    const none = { title: null, with: null, place: null, direct: null, ref: null, href: null } satisfies Partial<Doing>;
    const items: Doing[] = rows.map(row => {
      const base = { ...none, id: row.id, machine: row.machine, since: row.claimedAt ?? row.queuedAt, state: row.state };
      // In a conversation this viewer may not read: the job, and nothing of where it is. Its title is that conversation's label.
      if (row.inConversation && row.conversation === null) return { ...base, kind: 'private' };
      const trigger = named(row).find(id => notes.has(id));
      if (row.conversation === null || row.venue === null) return trigger ? { ...base, kind: 'trigger', title: notes.get(trigger)!, href: '/p/tempo' } : { ...base, kind: 'job', title: row.title };
      const talk = { ...base, title: row.label, href: conversationPath(row.conversation) };
      switch (row.venue) {
        case 'terminal': return { ...talk, kind: 'terminal', href: threadPath(row.place!) };
        case 'loom': return { ...talk, kind: 'loom', with: row.member, href: threadPath(row.place!) };
        case 'discord': case 'slack': return { ...talk, kind: row.venue, with: row.direct ? row.member : null,
          direct: !row.direct ? null : bridgePlace(row.place!).group ? 'group' : 'person',
          place: row.direct || row.venue !== 'discord' ? null : discordChannel(row.label!) };
        case 'handoff': return { ...talk, kind: 'handoff', with: row.handedFrom };
        case 'wake': return trigger ? { ...talk, kind: 'trigger', title: notes.get(trigger)!, href: '/p/tempo' } : { ...talk, kind: 'wake' };
      }
    });
    for (const task of working) items.push({ ...none, id: task.id, kind: 'task', title: task.title, ref: task.id, machine: null,
      since: task.startedAt ?? task.changedAt, state: 'in_progress', href: taskPath(task.id) });
    items.sort((a, b) => doingRank[a.kind] - doingRank[b.kind] || b.since.localeCompare(a.since) || a.id.localeCompare(b.id));
    return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
  }
  /** An agent's jobs, ended ones included, newest first. Same visibility as current(). */
  history(agent: string, first = 20, id?: string) {
    const allowed = this.allowed();
    const visibleParents = this.db.select({id:jobs.id}).from(jobs).where(allowed);
    const visibleRuns = this.db.select({id:terminalRuns.job}).from(terminalRuns).where(inArray(terminalRuns.parent,visibleParents));
    return this.db.select({ id: jobs.id, agent: jobs.agent, title: jobs.title, state: jobs.state, box: jobs.box,
      prefers: jobs.prefers, placementDecision: jobs.placementDecision,
      conversation: jobs.conversation, project: jobs.project, brief: jobs.brief, model: jobs.model,
      startedByKind: jobs.startedByKind, startedBy: jobs.startedBy, retryOf: jobs.retryOf, exitCode: jobs.exitCode, exitBy: jobs.exitBy, logTail: jobs.logTail,
      endedBy: jobs.endedBy, endedReason: jobs.endedReason, endedNote: jobs.endedNote, queuedAt: jobs.queuedAt, claimedAt: jobs.claimedAt, heardAt: jobs.heardAt, endedAt: jobs.endedAt }).from(jobs)
      .where(and(allowed, eq(jobs.agent, agent), id === undefined ? undefined : eq(jobs.id, id), or(ne(jobs.startedByKind,'terminal'),inArray(jobs.id,visibleRuns)))).orderBy(desc(jobs.queuedAt), desc(jobs.id)).limit(Math.min(Math.max(first, 1), 100)).all()
      // Where a failed job failed, read from its exit code and whose code it is: what a private conversation's job keeps.
      .map(row => ({ ...row, exitStage: exitStage(row.exitCode, row.exitBy) ?? null }));
  }
}
const text = { type: GraphQLString };
const placementCandidate = new GraphQLObjectType({ name: 'JobPlacementCandidate', fields: {
  box: { type: new GraphQLNonNull(GraphQLString) }, outcome: { type: new GraphQLNonNull(GraphQLString) },
  reason: { type: new GraphQLNonNull(GraphQLString) },
} });
const job = new GraphQLObjectType({ name: 'JobRecord', fields: {
  id: { type: new GraphQLNonNull(GraphQLString) }, agent: { type: new GraphQLNonNull(GraphQLString) },
  title: { type: new GraphQLNonNull(GraphQLString) }, state: { type: new GraphQLNonNull(GraphQLString) },
  prefers: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  placementDecision: { type: new GraphQLList(new GraphQLNonNull(placementCandidate)) },
  box: text, conversation: text, project: text, brief: text, model: text, startedByKind: text, startedBy: text, retryOf: text,
  exitCode: { type: GraphQLInt }, exitBy: text, exitStage: text, logTail: text, endedBy: text, endedReason: text, endedNote: text,
  queuedAt: { type: new GraphQLNonNull(GraphQLString) }, claimedAt: text, heardAt: text, endedAt: text,
} });
const currentJob = new GraphQLObjectType({ name: 'CurrentJobSummary', fields: {
  kind: text,
  id: { type: new GraphQLNonNull(GraphQLString) },
  agent: { type: new GraphQLNonNull(GraphQLString) },
  title: { type: new GraphQLNonNull(GraphQLString) },
  state: { type: new GraphQLNonNull(GraphQLString) },
  // This is the assigned machine ID on the visible job, not a separate box read.
  box: { type: GraphQLString },
  queuedAt: { type: new GraphQLNonNull(GraphQLString) },
} });
const doingItem = new GraphQLObjectType({ name: 'AgentDoingItem', fields: {
  id: { type: new GraphQLNonNull(GraphQLString) }, kind: { type: new GraphQLNonNull(GraphQLString) },
  title: text, with: text, place: text, direct: text, ref: text, machine: text,
  since: { type: new GraphQLNonNull(GraphQLString) }, state: { type: new GraphQLNonNull(GraphQLString) }, href: text,
} });
const doing = new GraphQLObjectType({ name: 'AgentDoing', fields: {
  items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(doingItem))) }, more: { type: new GraphQLNonNull(GraphQLInt) },
} });
/** Add to the existing generated query root. Root owns authentication, current
 * SQL policy and subscriptions; use the same field in subscription selections. */
export function jobSummaryFields(summaries: JobSummaries, canReadUsage = () => true) {
  return { ...jobUsageFields(summaries, canReadUsage), currentJobs: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(currentJob))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_source: unknown, args: { agent: string }) => summaries.current(args.agent),
  }, agentDoing: {
    type: new GraphQLNonNull(doing),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) }, limit: { type: GraphQLInt, defaultValue: doingCap } },
    resolve: (_source: unknown, args: { agent: string; limit: number }) => summaries.doing(args.agent, args.limit),
  }, jobHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(job))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) }, first: { type: GraphQLInt }, id: { type: GraphQLString } },
    resolve: (_source: unknown, args: { agent: string; first?: number | null; id?: string | null }) => summaries.history(args.agent, args.first ?? undefined, args.id ?? undefined),
  } };
}
