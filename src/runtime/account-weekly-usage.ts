import {and, asc, eq, lte, sql} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {accountWeekReadings, jobs, jobUsage} from '../core/data/schema.js';
import {estimateWeeklyUsage} from './weekly-attribution.js';
import type {QuotaWindow} from './quota.js';

/** Internal weights for one authorized account window. All overlapping jobs participate.
 * The caller must project these weights through the viewer's current job visibility
 * before returning groups. An inaccessible job's weight belongs in unattributed. */
export function accountWeeklyUsage(db:DataDatabase, account:string, window:QuotaWindow, now:string) {
  if (window.durationMs !== 7 * 86_400_000 || !window.readAt || !window.resetsAt || window.usage === null) return null;
  const end = Date.parse(window.readAt), reset = Date.parse(window.resetsAt), at = Date.parse(now);
  if (!(end <= at && at < reset && end >= reset - window.durationMs)) return null;
  const stored = db.select({at:accountWeekReadings.readAt,usage:accountWeekReadings.usage})
    .from(accountWeekReadings).where(and(eq(accountWeekReadings.account,account),
      eq(accountWeekReadings.window,window.name),eq(accountWeekReadings.resetsAt,new Date(reset).toISOString()),
      lte(accountWeekReadings.readAt,new Date(end).toISOString())))
    .orderBy(asc(accountWeekReadings.readAt)).all();
  // Include the current observation even before the first refresh after upgrading.
  const readings = stored.filter(row=>Date.parse(row.at)<end).map(row=>({at:Date.parse(row.at),usage:row.usage}));
  readings.push({at:end,usage:window.usage});
  if (readings.length === 1) return estimateWeeklyUsage(readings,[]);
  const weights = db.select({id:jobs.id,start:jobs.claimedAt,end:jobs.endedAt,input:jobUsage.tokensIn,output:jobUsage.tokensOut})
    .from(jobs).leftJoin(jobUsage,eq(jobUsage.job,jobs.id)).where(and(eq(jobs.account,account),
      sql`julianday(${jobs.claimedAt}) <= julianday(${window.readAt})`,
      sql`(${jobs.endedAt} is null or julianday(${jobs.endedAt}) > julianday(${new Date(readings[0].at).toISOString()}))`)).all();
  return estimateWeeklyUsage(readings,weights.map(row=>({
    id:row.id,start:Date.parse(row.start!),end:row.end ? Date.parse(row.end) : end,
    tokens:row.end && row.input !== null && row.output !== null ? row.input + row.output : null,
  })));
}
