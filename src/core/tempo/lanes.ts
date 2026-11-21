import { createHash } from 'node:crypto';
import { and, asc, eq, getTableColumns, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
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
