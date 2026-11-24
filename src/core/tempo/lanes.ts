import { createHash, randomInt } from 'node:crypto';
import { and, asc, between, eq, getTableColumns, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { rules, type Viewer } from '../../policy.js';
import { sqlHolds, sqlVisibility } from '../../policy-sql.js';
import type { DataDatabase } from '../data/database.js';
import { triggers } from '../data/schema.js';

function visibleLane(viewer: Viewer) {
  return and(sqlVisibility(viewer, ['triggers']).triggers(getTableColumns(triggers)),
    eq(triggers.ownerKind, 'household'), eq(triggers.sourceKind, 'time'), ne(triggers.lifespan, 'once'),
    eq(triggers.targetKind, 'inbox'), eq(triggers.toKind, 'agent'), eq(triggers.enabled, true),
    or(isNotNull(triggers.file), ne(triggers.instructions, '')));
}

export function clockLanes(db: DataDatabase, viewer: Viewer, after: string) {
  return db.select({ id: triggers.id, agent: triggers.to, times: triggers.times, days: triggers.days,
    note: triggers.note, file: triggers.file, characters: sql<number>`coalesce(length(${triggers.instructions}),0)` })
    .from(triggers).where(and(visibleLane(viewer), gt(triggers.id, after))).orderBy(asc(triggers.id)).limit(100).all();
}

export function clockLaneText(db: DataDatabase, viewer: Viewer, id: string, agent?: string) {
  const row = db.select({ text: triggers.instructions, file: triggers.file, agent: triggers.to, project: triggers.project, member: triggers.member, conversation: triggers.conversation }).from(triggers)
    .where(and(visibleLane(viewer), eq(triggers.id, id), agent ? eq(triggers.to, agent) : undefined, viewer.kind === 'agent' ? eq(triggers.to, viewer.id) : undefined)).get();
  if (!row) return null;
  // A file reference has no stored copy of its words.
  if (row.file) return { file: row.file };
  const text = row.text!;
  const digest = createHash('sha256').update(text).digest('hex');
  const revision = viewer.kind === 'member' && sqlHolds(db, rules.householdOwner, viewer)
    ? createHash('sha256').update(JSON.stringify([id, digest, row.agent, row.project, row.member, row.conversation])).digest('hex') : null;
  return { text, digest, revision };
}

/** Read in the same write as a file wake, after the proposed wake passes normal validation. */
export function coveringFileSchedule(db: DataDatabase, viewer: Viewer, agent: string, file: string, due: string) {
  const window = 6 * 60 * 60 * 1000;
  const at = Date.parse(due);
  return db.select().from(triggers).where(and(
    sqlVisibility(viewer, ['triggers']).triggers(getTableColumns(triggers)),
    or(eq(triggers.ownerKind, 'household'), and(eq(triggers.ownerKind, 'agent'), eq(triggers.owner, agent))),
    eq(triggers.sourceKind, 'time'), eq(triggers.lifespan, 'until-stopped'), eq(triggers.targetKind, 'inbox'),
    eq(triggers.toKind, 'agent'), eq(triggers.to, agent), eq(triggers.file, file), eq(triggers.enabled, true),
    isNull(triggers.member), isNull(triggers.conversation), isNull(triggers.project), isNull(triggers.program),
    isNull(triggers.scheduleRemovedAt), between(triggers.nextDueAt,
      new Date(at - window).toISOString(), new Date(at + window).toISOString()),
  )).orderBy(asc(triggers.nextDueAt), asc(triggers.id)).limit(1).get();
}

/** The starter names each run with a lane, UTC second and nonce. Restrict reuse to its own visible,
 * unassigned one-off wake. This lookup runs inside the same coordinator write as the insertion. */
export function pendingNamedRun(db: DataDatabase, viewer: Viewer, id: string | undefined, agent: string) {
  const match = /^run-([a-z][a-z0-9-]{0,60})-[0-9]{8}t[0-9]{6}-[0-9a-f]{4}$/.exec(id ?? '');
  if (!match) throw Error('Joining a pending run requires a dated run id');
  const glob = 'run-' + match[1] + '-' + '[0-9]'.repeat(8) + 't' + '[0-9]'.repeat(6) + '-' + '[0-9a-f]'.repeat(4);
  const existing = db.select().from(triggers).where(and(
    sqlVisibility(viewer, ['triggers']).triggers(getTableColumns(triggers)),
    sql`${triggers.id} GLOB ${glob}`, eq(triggers.ownerKind, 'agent'), eq(triggers.owner, agent),
    eq(triggers.sourceKind, 'time'), eq(triggers.lifespan, 'once'), eq(triggers.targetKind, 'inbox'),
    eq(triggers.toKind, 'agent'), eq(triggers.to, agent), eq(triggers.enabled, true),
    inArray(triggers.state, ['standing','due','firing','held']),
    isNull(triggers.member), isNull(triggers.project), isNull(triggers.conversation), isNull(triggers.program),
  )).orderBy(asc(triggers.createdAt), asc(triggers.id)).limit(1).get();
  if (existing) return {id:existing.id, existing};
  // Guarded starts allocate their nonce here. A guessed id can coincide with a private,
  // historical or different agent's run. Never return that row or reveal whether it exists.
  const prefix = match[0].slice(0,-4);
  const start = randomInt(0x10000);
  for (let offset = 0; offset < 0x10000; offset++) {
    const candidate = prefix + ((start + offset) % 0x10000).toString(16).padStart(4,'0');
    if (!db.select({id:triggers.id}).from(triggers).where(eq(triggers.id,candidate)).get()) return {id:candidate};
  }
  throw Error('No run names remain for this second');
}

/** Bind a household schedule replacement to the settings its owner just read. */
export function clockScheduleRevision(db: DataDatabase, viewer: Viewer, id: string) {
  if (viewer.kind !== 'member' || !sqlHolds(db, rules.householdOwner, viewer)) return null;
  const row = db.select({
    id: triggers.id, name: triggers.scheduleName, agent: triggers.to, member: triggers.member,
    project: triggers.project, conversation: triggers.conversation, enabled: triggers.enabled,
    times: triggers.times, days: triggers.days, instructions: triggers.instructions, file: triggers.file,
    note: triggers.note, model: triggers.wantsModel,
  }).from(triggers).where(and(sqlVisibility(viewer, ['triggers']).triggers(getTableColumns(triggers)),
    eq(triggers.id, id), eq(triggers.ownerKind, 'household'), eq(triggers.sourceKind, 'time'),
    eq(triggers.lifespan, 'until-stopped'), eq(triggers.targetKind, 'inbox'), eq(triggers.toKind, 'agent'),
    isNull(triggers.scheduleRemovedAt))).get();
  return row ? createHash('sha256').update(JSON.stringify(row)).digest('hex') : null;
}
