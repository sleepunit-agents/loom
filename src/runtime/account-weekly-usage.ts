import {DAY_MS} from '../core/day.js';
import {and, desc, eq, gte, lte, sql} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {accountWeekReadings, jobs, jobUsage} from '../core/data/schema.js';
import {estimateWeeklyUsage} from './weekly-attribution.js';
import type {QuotaWindow} from './quota.js';

/** Internal weights for one authorized account window. All overlapping jobs participate.
 * The caller must project these weights through the viewer's current job visibility
 * before returning groups. An inaccessible job's weight belongs in unattributed. */
export function accountWeeklyUsage(db:DataDatabase, account:string, window:QuotaWindow, now:string) {
  if (window.durationMs !== 7 * DAY_MS || !window.readAt || !window.resetsAt || window.usage === null) return null;
  const end = Date.parse(window.readAt), reset = Date.parse(window.resetsAt), at = Date.parse(now);
  if (!(end <= at && at < reset && end >= reset - window.durationMs)) return null;
  // Provider reset estimates can move slightly between polls. Use only the
  // contiguous history of this reset, comparing every reading to the current
  // estimate so that small successive shifts cannot chain different periods.
  const resetToleranceMs = 2000;
  const stored = db.select({at:accountWeekReadings.readAt,reset:accountWeekReadings.resetsAt,usage:accountWeekReadings.usage})
    .from(accountWeekReadings).where(and(eq(accountWeekReadings.account,account),
      eq(accountWeekReadings.window,window.name),
      gte(accountWeekReadings.readAt,new Date(reset-window.durationMs).toISOString()),
      lte(accountWeekReadings.readAt,new Date(end).toISOString())))
    .orderBy(desc(accountWeekReadings.readAt)).all();
  const readings = [{at:end,usage:window.usage}];
  for (const row of stored) {
    const readingAt = Date.parse(row.at);
    const previous = readings[readings.length - 1];
    const sameTime = readingAt === previous.at;
    const sameWindow = Math.abs(Date.parse(row.reset) - reset) <= resetToleranceMs;
    if (!sameWindow || (sameTime && row.usage !== previous.usage)) {
      // Conflicting records at a timestamp cannot establish a prior baseline.
      if (sameTime && readingAt !== end) readings.pop();
      break;
    }
    if (!sameTime) readings.push({at:readingAt,usage:row.usage});
  }
  readings.reverse();
  if (readings.length === 1) return estimateWeeklyUsage(readings,[]);
  const weights = db.select({id:jobs.id,start:jobs.claimedAt,end:jobs.endedAt,input:jobUsage.tokensIn,output:jobUsage.tokensOut})
    .from(jobs).leftJoin(jobUsage,eq(jobUsage.job,jobs.id)).where(and(eq(jobs.account,account),
      sql`(julianday(${jobs.claimedAt}) < julianday(${window.readAt})
        or (${jobs.endedAt} is not null and julianday(${jobs.claimedAt}) = julianday(${window.readAt})))`,
      sql`(${jobs.endedAt} is null or julianday(${jobs.endedAt}) > julianday(${new Date(readings[0].at).toISOString()}))`)).all();
  return estimateWeeklyUsage(readings,weights.map(row=>({
    id:row.id,start:Date.parse(row.start!),end:row.end ? Date.parse(row.end) : end,
    tokens:row.end && row.input !== null && row.output !== null ? row.input + row.output : null,
  })));
}
