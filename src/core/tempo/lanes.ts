import { createHash } from 'node:crypto';
import { and, asc, eq, getTableColumns, gt, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
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

export function clockLaneText(db: DataDatabase, viewer: Viewer, id: string) {
  const row = db.select({ text: triggers.instructions, file: triggers.file }).from(triggers)
    .where(and(visibleLane(viewer), eq(triggers.id, id), viewer.kind === 'agent' ? eq(triggers.to, viewer.id) : undefined)).get();
  if (!row) return null;
  // A file reference has no stored copy of its words.
  if (row.file) return { file: row.file };
  const text = row.text!;
  return { text, digest: createHash('sha256').update(text).digest('hex') };
}
