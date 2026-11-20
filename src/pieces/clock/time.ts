/** Calendar calculations have no dependency on the machine's local timezone. */
export const timeZone = 'America/Chicago';
const day = 86400_000;
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function parts(epoch: number) {
  const p = Object.fromEntries(formatter.formatToParts(epoch).map(p => [p.type, p.value]));
  return { year: Number(p.year), month: Number(p.month), date: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}
function nominal(epoch: number) {
  const p = parts(epoch);
  return Date.UTC(p.year, p.month - 1, p.date, p.hour, p.minute, p.second);
}
/** Calendar fields encoded as UTC, not an actual instant. Resolve both sides of a DST transition. */
function instants(local: number): number[] {
  const offsets = new Set([-day, 0, day].map(delta => nominal(local + delta) - (local + delta)));
  return [...offsets].map(offset => local - offset).filter(epoch => nominal(epoch) === local).sort((a,b) => a-b);
}
export function daysOf(spec = ''): Set<number> {
  if (!spec) return new Set([0,1,2,3,4,5,6]);
  const out = new Set<number>();
  for (const part of spec.toLowerCase().split(',')) {
    const match = /^(sun|mon|tue|wed|thu|fri|sat)(?:-(sun|mon|tue|wed|thu|fri|sat))?$/.exec(part);
    if (!match) throw new Error(`wake: --days takes mon..sun, a range (mon-fri) or a list (sat,sun), not ${JSON.stringify(spec)}`);
    let n = weekdays.indexOf(match[1]);
    const last = weekdays.indexOf(match[2] ?? match[1]);
    for (;;) { out.add(n); if (n === last) break; n = (n+1)%7; }
  }
  return out;
}
export function timesOf(at: string | readonly string[]): string[] {
  const times = typeof at === 'string' ? at.split(',').map(t => t.trim()) : [...at];
  if (!times.length || times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('wake: --at takes HH:MM times');
  return [...new Set(times)].sort();
}
export interface CalendarSchedule { at: string | readonly string[]; days?: string }
/** Strictly after an instant. Missing wall times are skipped; repeated times run once, at the first instant. */
export function nextOccurrence(schedule: CalendarSchedule, after: number): number {
  if (!Number.isSafeInteger(after)) throw new Error('wake: invalid timestamp');
  const allowed = daysOf(schedule.days), times = timesOf(schedule.at);
  const p = parts(after), today = Date.UTC(p.year, p.month-1, p.date);
  // A weekly schedule can skip its sole day at the spring gap, so inspect two weeks.
  for (let i = 0; i < 15; i++) {
    const date = today + i * day;
    if (!allowed.has(new Date(date).getUTCDay())) continue;
    for (const time of times) {
      const [h,m] = time.split(':').map(Number);
      const first = instants(date + h * 3600_000 + m * 60_000)[0];
      if (first !== undefined && first > after) return first;
    }
  }
  throw new Error('wake: no next occurrence');
}
export function parseIn(value: string, now: number): number {
  const parts = [...value.matchAll(/(\d+)([smhd])/g)];
  if (!parts.length || parts.map(p => p[0]).join('') !== value) throw new Error(`wake: can't parse duration ${JSON.stringify(value)} (want e.g. 90m, 4h, 1h30m, 2d)`);
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: day };
  const result = now + parts.reduce((sum,p) => sum + Number(p[1]) * units[p[2]], 0);
  if (!Number.isSafeInteger(result)) throw new Error('wake: duration out of range');
  return result;
}
export function parseAt(value: string, now: number): number {
  const full = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (full) {
    const [,year,month,date,hour,minute,second = '0'] = full;
    const local = Date.UTC(+year,+month-1,+date,+hour,+minute,+second), check = new Date(local);
    if (check.getUTCFullYear() !== +year || check.getUTCMonth() !== +month-1 || check.getUTCDate() !== +date || +hour > 23 || +minute > 59 || +second > 59) throw new Error('wake: invalid calendar date');
    const result = instants(local)[0];
    if (result === undefined) throw new Error('wake: that local time does not exist in America/Chicago');
    return result;
  }
  const short = /^(tomorrow )?(\d{1,2}):(\d{2})$/.exec(value);
  if (!short || +short[2] > 23 || +short[3] > 59) throw new Error(`wake: can't parse time ${JSON.stringify(value)}`);
  const p = parts(now), midnight = Date.UTC(p.year,p.month-1,p.date);
  const local = midnight + +short[2]*3600_000 + +short[3]*60_000;
  if (!short[1]) { const today = instants(local)[0]; if (today !== undefined && today > now) return today; }
  const tomorrow = instants(local + day)[0];
  if (tomorrow === undefined) throw new Error('wake: that local time does not exist in America/Chicago');
  return tomorrow;
}
