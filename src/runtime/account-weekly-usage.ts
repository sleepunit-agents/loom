import {DAY_MS} from '../core/day.js';
import {desc, eq, sql} from 'drizzle-orm';
import type {DataDatabase} from '../core/data/database.js';
import {accountWeekReadings, jobs, jobUsage} from '../core/data/schema.js';
import {estimateWeeklyUsage} from './weekly-attribution.js';
import type {QuotaWindow} from './quota.js';

type Selection = {account:string; window:QuotaWindow};
type Reading = {at:number;usage:number};
type Stored = {at:string;reset:string;usage:number};
type Weight = Parameters<typeof estimateWeeklyUsage>[1][number];

function contiguousReadings(latest:Reading, reset:number, history:Stored[]) {
  const readings = [latest];
  for (const row of history) {
    const at = Date.parse(row.at);
    const previous = readings[readings.length - 1];
    const sameTime = at === previous.at;
    // Compare to the current estimate so small successive shifts cannot chain different periods.
    const sameWindow = Math.abs(Date.parse(row.reset) - reset) <= 2000;
    if (!sameWindow ||
        (sameTime && row.usage !== previous.usage)) {
      if (sameTime && at !== latest.at) readings.pop();
      break;
    }
    if (!sameTime) readings.push({at,usage:row.usage});
  }
  return readings.reverse();
}

/** Internal weights for already-authorized account windows. The caller must still project
 * every job share through the viewer's current visibility before releasing it. */
export function weeklyWindowEstimates(db:DataDatabase, selections:Selection[], now:string) {
  const at = Date.parse(now);
  const windows = selections.flatMap(({account,window},index) => {
    if (window.durationMs !== 7 * DAY_MS || !window.readAt || !window.resetsAt || window.usage === null) return [];
    const end = Date.parse(window.readAt), reset = Date.parse(window.resetsAt);
    if (!(end <= at && at < reset && end >= reset-window.durationMs)) return [];
    return [{index,account,name:window.name,from:new Date(reset-window.durationMs).toISOString(),
      to:new Date(end).toISOString(),reset,latest:{at:end,usage:window.usage}}];
  });
  const results = new Map<number,ReturnType<typeof estimateWeeklyUsage>>();
  if (!windows.length) return results;

  // One bound parameter regardless of household size. Keep the account, window and time
  // range together so each indexed lookup reads only its own provider history.
  const index = sql<number>`cast(request.key as integer)`;
  const history = db.select({index,at:accountWeekReadings.readAt,reset:accountWeekReadings.resetsAt,usage:accountWeekReadings.usage})
    .from(accountWeekReadings).innerJoin(sql`json_each(${JSON.stringify(windows)}) as request`,sql`
      ${accountWeekReadings.account} = request.value ->> 'account' and ${accountWeekReadings.window} = request.value ->> 'name'
      and ${accountWeekReadings.readAt} between request.value ->> 'from' and request.value ->> 'to'`)
    .orderBy(desc(accountWeekReadings.readAt)).all();
  const stored = windows.map(():Stored[] => []);
  for (const row of history) stored[row.index].push(row);
  const readings = windows.map((w,i) => contiguousReadings(w.latest,w.reset,stored[i]));
  const intervals = windows.flatMap((w,i) => readings[i].length > 1 ?
    [{i,account:w.account,from:new Date(readings[i][0].at).toISOString(),to:selections[w.index].window.readAt}] : []);
  const weights = windows.map(():Weight[] => []);
  if (intervals.length) {
    // Materializing makes SQLite build an account index over the request. Scanning jobs
    // once then probing that index avoids reparsing all windows for every historical job.
    // Keep membership comparisons in SQLite: julianday and Date.parse round fractional
    // seconds differently, and a running job at the upper bound must be excluded.
    const requested = sql`(with bounds as materialized (
      select value ->> 'i' as i, cast(value ->> 'account' as text) as account,
        julianday(value ->> 'from') as lower, julianday(value ->> 'to') as upper
      from json_each(${JSON.stringify(intervals)})) select * from bounds) as request`;
    const rows = db.select({i:sql<number>`request.i`,id:jobs.id,start:jobs.claimedAt,end:jobs.endedAt,
      input:jobUsage.tokensIn,output:jobUsage.tokensOut}).from(jobs).crossJoin(requested)
      .leftJoin(jobUsage,eq(jobUsage.job,jobs.id)).where(sql`
        ${jobs.account} = request.account
        and (julianday(${jobs.claimedAt}) < request.upper
          or (${jobs.endedAt} is not null and julianday(${jobs.claimedAt}) = request.upper))
        and (${jobs.endedAt} is null or julianday(${jobs.endedAt}) > request.lower)`).all();
    for (const row of rows) weights[row.i].push({id:row.id,start:Date.parse(row.start!),
      end:row.end ? Date.parse(row.end) : windows[row.i].latest.at,
      tokens:row.end && row.input !== null && row.output !== null ? row.input + row.output : null});
  }
  windows.forEach((w,i) => results.set(w.index,estimateWeeklyUsage(readings[i],weights[i])));
  return results;
}

export function accountWeeklyUsage(db:DataDatabase, account:string, window:QuotaWindow, now:string) {
  return weeklyWindowEstimates(db,[{account,window}],now).get(0) ?? null;
}
