/** Household wall-clock scheduling. Independent of the worker's timezone. */
const day = 86_400_000;
const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function calendar(zone: string) {
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
/** Times are comma separated HH:MM. Dates are explicit ISO instants with offset.
 * Skip missing DST times; run a repeated wall time only at its first instant. */
export function nextTime(times: string, days: string | null, after: number, zone: string): number {
  if (/^\d{4}-/.test(times)) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(times)) throw new Error('A date must include a timezone offset');
    const at = Date.parse(times);
    if (!Number.isFinite(at)) throw new Error('Invalid trigger date');
    return at > after ? at : Infinity;
  }
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
  const c = calendar(zone), today = Math.floor(c.nominal(after) / day) * day;
  for (let d = 0; d < 15; d++) {
    const date = today + d * day;
    if (!allowed.has(new Date(date).getUTCDay())) continue;
    for (const t of [...new Set(minutes)].sort()) {
      const [h, m] = t.split(':').map(Number);
      const first = c.instants(date + h * 3_600_000 + m * 60_000)[0];
      if (first !== undefined && first > after) return first;
    }
  }
  throw new Error('No next time');
}
