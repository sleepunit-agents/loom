// What an agent wrote, tidied for a person to read where the page shows it (Jonathan, 2026-10-30: the plain-words sweep;
// "extend the plain-words rules ... to task comments and memory titles"). Display only: the words are kept as written,
// only the machine's leftovers go. No React here, so it's tested on its own (src/ui/tidy.test.ts).
//
// - Internal ids nobody reads are dropped: a wake's (w-6b2931), an approval's (a-24e194de), a request's (q-7c3f35ab), a
//   relay's (r-d8dad1d1), a house's (h-400). Task ids (t-1689), PRs and conversation ids stay: people use those.
// - ISO dates read as dates ("2026-10-30" -> "Oct 30"; another year keeps it), a date with a time as both ("2026-10-30
//   08:31" -> "Oct 30, 8:31 AM"; a UTC one, "…Z", in local time). A date inside a file name or path stays exact.

const ID = /(\(\s*)?\b(?:[waqr]-[0-9a-f]{6,10}|h-\d{2,5})\b(\s*\))?/g;
const STAMP = /(?<![\w/.-])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z)?)?(?![\w/.-]|-\d)/g;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(y: number, mo: number, d: number, h: number | undefined, mi: number | undefined, utc: boolean, now: Date): string {
  let date = new Date(y, mo - 1, d, h ?? 0, mi ?? 0);
  if (utc && h !== undefined) date = new Date(Date.UTC(y, mo - 1, d, h, mi ?? 0));
  if (Number.isNaN(date.getTime()) || (!utc && (date.getMonth() !== mo - 1 || date.getDate() !== d))) return '';
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}${date.getFullYear() !== now.getFullYear() ? `, ${date.getFullYear()}` : ''}`;
  if (h === undefined) return day;
  const hh = date.getHours(), mm = String(date.getMinutes()).padStart(2, '0');
  return `${day}, ${hh % 12 || 12}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
}

export function tidy(text: string, now = new Date()): string {
  if (!text) return text;
  let s = text.replace(ID, (_m, open?: string, close?: string) => (open && close ? '' : open ? open : close ? close : ''));
  s = s.replace(STAMP, (m, y, mo, d, h, mi, _s, z) => {
    const out = stamp(+y, +mo, +d, h === undefined ? undefined : +h, mi === undefined ? undefined : +mi, !!z, now);
    return out || m;
  });
  // What an id leaves behind: doubled spaces, a space before punctuation, an empty or lonely bracket, a stray "·".
  return s
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
