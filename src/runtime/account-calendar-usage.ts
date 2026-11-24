import {and, eq, gte, lt} from 'drizzle-orm';
import {DAY_MS} from '../core/day.js';
import type {DataDatabase} from '../core/data/database.js';
import {accountCalendarReadings as readings} from '../core/data/schema.js';
import {localDate} from '../core/tempo/calendar.js';

type Reading = {at:string;usage:number};
export type AccountCalendarDay = {date:string;peak:Reading|null;weekly:Reading|null;highHours:string[]};

/** An authorized account's measured usage on the requested household dates. */
export function accountCalendarUsage(db:DataDatabase, account:string, start:string, days:number, zone:string) {
  const midnight=Date.parse(start+'T00:00:00Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0,10)!==start || (days!==1 && days!==7)) {
    throw new Error('Choose a calendar day or week');
  }
  const end=midnight+days*DAY_MS;
  const until=new Date(end).toISOString().slice(0,10);
  const rows=db.select({at:readings.readAt,usage:readings.usage,duration:readings.durationMs})
    .from(readings).where(and(eq(readings.account,account),
      gte(readings.readAt,new Date(midnight-DAY_MS).toISOString()),lt(readings.readAt,new Date(end+DAY_MS).toISOString())))
    .orderBy(readings.readAt).all();
  const byDay=new Map<string,AccountCalendarDay>();
  const hour=new Intl.DateTimeFormat('en',{timeZone:zone,hour:'numeric',timeZoneName:'shortOffset'});
  const highHours=new Set<string>();
  for (const {at,usage,duration} of rows) {
    const epoch=Date.parse(at),date=localDate(epoch,zone);
    if (date<start || date>=until) continue;
    let day=byDay.get(date);
    if (!day) {
      day={date,peak:null,weekly:null,highHours:[]};
      byDay.set(date,day);
    }
    if (duration===7*DAY_MS) {
      // For simultaneous weekly limits show the fullest one.
      if (day.weekly?.at!==at || day.weekly.usage<usage) day.weekly={at,usage};
    } else {
      if (!day.peak || usage>day.peak.usage) day.peak={at,usage};
      if (usage < .85) continue;
      const key=date+' '+hour.format(epoch);
      if (!highHours.has(key)) {highHours.add(key);day.highHours.push(at);}
    }
  }
  return [...byDay.values()];
}
