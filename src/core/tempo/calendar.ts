import { DAY_MS } from '../day.js';
/** Household wall-clock scheduling. Independent of the worker's timezone. */
const day = DAY_MS;
const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Day and Week bucket every history entry in the same household timezone.
let lastCalendar: { zone: string; calendar: ReturnType<typeof makeCalendar> } | undefined;
function calendar(zone: string) {
  if (!lastCalendar || lastCalendar.zone !== zone) lastCalendar = { zone, calendar: makeCalendar(zone) };
  return lastCalendar.calendar;
}
function makeCalendar(zone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const nominal = (epoch: number) => {
    const p = Object.fromEntries(format.formatToParts(epoch).map(p => [p.type, p.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  return { nominal, instants(local: number) {
    const offsets = new Set([-day, 0, day].map(delta => nominal(local + delta) - (local + delta)));
    return [...offsets].map(offset => local - offset).filter(epoch => nominal(epoch) === local).sort((a, b) => a - b);
  } };
}
/** A time of day on the household's clock, `HH:MM` from 00:00 to 23:59. */
export const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function localDate(at: number, zone: string): string {
  return new Date(calendar(zone).nominal(at)).toISOString().slice(0, 10);
}
function datedInstant(times: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(times)) throw new Error('A date must include a timezone offset');
  const at = Date.parse(times);
  if (!Number.isFinite(at)) throw new Error('Invalid trigger date');
  return at;
}

function recurring(times: string, days: string | null, zone: string) {
  const minutes = times.split(',').map(s => s.trim());
  if (!minutes.length || minutes.some(s => !HH_MM.test(s))) throw new Error('Times must be HH:MM');
  const allowed = new Set<number>();
  const spec = days === 'weekdays' ? 'mon-fri' : days === 'weekends' ? 'sat,sun' : days;
  if (!spec || spec === 'everyday' || spec === 'daily') for (let d = 0; d < 7; d++) allowed.add(d);
  else for (const part of spec.toLowerCase().split(',')) {
    const m = /^(sun|mon|tue|wed|thu|fri|sat)(?:-(sun|mon|tue|wed|thu|fri|sat))?$/.exec(part.trim());
    if (!m) throw new Error('Invalid days');
    const end = names.indexOf(m[2] ?? m[1]);
    for (let d = names.indexOf(m[1]);; d = (d + 1) % 7) { allowed.add(d); if (d === end) break; }
  }
  const clock = calendar(zone);
  const offsets = [...new Set(minutes)].sort().map(time => {
    const [h, m] = time.split(':').map(Number);
    return h * 3_600_000 + m * 60_000;
  });
  function* onDate(date: number) {
    if (!allowed.has(new Date(date).getUTCDay())) return;
    for (const offset of offsets) {
      const first = clock.instants(date + offset)[0];
      if (first !== undefined) yield first;
    }
  }
  return { clock, onDate };
}

/** Instants on one household calendar date, under the same DST and weekday rules as the scheduler. */
export function timesOnDate(times: string, days: string | null, date: string, zone: string): number[] {
  const midnight = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw Error('Invalid calendar date');
  if (/^\d{4}-/.test(times)) {
    const at = datedInstant(times);
    return localDate(at, zone) === date ? [at] : [];
  }
  return [...recurring(times, days, zone).onDate(midnight)];
}

/** Times are comma separated HH:MM. Dates are explicit ISO instants with offset.
 * Skip missing DST times; run a repeated wall time only at its first instant. */
export function nextTime(times: string, days: string | null, after: number, zone: string): number {
  if (/^\d{4}-/.test(times)) {
    const at = datedInstant(times);
    return at > after ? at : Infinity;
  }
  const { clock, onDate } = recurring(times, days, zone);
  const today = Math.floor(clock.nominal(after) / day) * day;
  for (let d = 0; d < 15; d++) {
    for (const first of onDate(today + d * day)) if (first > after) return first;
  }
  throw new Error('No next time');
}

/** Resolve a dated wake against the household wall clock, including a day with two
 * occurrences of the same time. The scheduler uses the first of those occurrences. */
export function datedWake(dayText: string, time: string, after: number, zone: string): number {
  const dayTextUtc = dayText === 'tomorrow'
    ? new Date(Date.parse(localDate(after, zone) + 'T00:00:00Z') + DAY_MS).toISOString().slice(0, 10)
    : dayText;
  const wall = dayTextUtc + 'T' + time + (time.length === 5 ? ':00' : '') + 'Z';
  const nominal = Date.parse(wall);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().replace('.000Z', 'Z') !== wall)
    throw Error('Invalid calendar date');
  const first = calendar(zone).instants(nominal)[0];
  if (first === undefined || first <= after) throw Error('Wake time is missing or past');
  return first;
}
