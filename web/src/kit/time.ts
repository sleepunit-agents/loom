/** Every time an app shows, said in this one place: the time alone for today, a short date with it for another
 * day, the date and year for another year. Never seconds and never a zone's id. The zone is the household's
 * where the caller has read it (data/zone.ts); without one it is the device's own. Nothing here names a zone. */
const made = new Map<string, Intl.DateTimeFormat>();
function format(zone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([zone, options]);
  let found = made.get(key);
  if (!found) {
    try { found = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }); }
    catch { found = new Intl.DateTimeFormat('en-US', options); }
    made.set(key, found);
  }
  return found;
}
const say = (zone: string | undefined, options: Intl.DateTimeFormatOptions, at: Date | number) => format(zone, options).format(at).replace(/ /g, ' ');

/** "2:31 PM" today, "Nov 14, 2:31 PM" on another day this year, "Nov 14, 2025" before that. */
export function briefTime(at: string, zone?: string, now: number = Date.now()): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const day: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
  const time = say(zone, { hour: 'numeric', minute: '2-digit' }, date);
  if (say(zone, day, date) === say(zone, day, now)) return time;
  if (say(zone, { year: 'numeric' }, date) === say(zone, { year: 'numeric' }, now)) return `${say(zone, { month: 'short', day: 'numeric' }, date)}, ${time}`;
  return say(zone, { dateStyle: 'medium' }, date);
}
/** The whole of it, for a screen reader and a hover: "Nov 14, 2026, 2:31 PM". */
export function fullTime(at: string | number, zone?: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? say(zone, { dateStyle: 'medium', timeStyle: 'short' }, date) : '';
}
