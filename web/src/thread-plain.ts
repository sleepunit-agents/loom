// The thread in plain words (web/src/views.tsx, the activity ledger): what an agent wrote down, without the shorthand
// it writes for itself (Jonathan, 2026-10-30: "take any of the humanize stuff ... and tweak the activity list to be
// friendlier"). No React here, so it's tested on its own (src/ui/thread-plain.test.ts).
//
// An agent titles a memory for itself: "t-1498 PR33 nudge-watch round 10 — gave first nudge after 39h silence",
// "knowledge-verify 2026-10-30: 10 pages checked", "w-f335a6 routine 12h check-in: …". The row says what happened
// ("Checked on PR 33"), the detail under it, and the bookkeeping as chips: the task (a link to it), the round, the lane.

export type Chip = { label: string; page?: string };
export type Plain = { title: string; detail?: string; chips: Chip[] };

const cap = (s: string) => (/^t-\d/.test(s) ? s : s.replace(/^\p{Ll}/u, (c) => c.toUpperCase()));
const words = (slug: string) => cap(slug.replace(/-/g, ' '));
const TASK = /^(t-\d+)(?:\s*\/\s*t-\d+)*\b/;

/** Split "headline — detail" or "headline: detail" (the first that reads as a split, not a time or a ratio). */
function split(s: string): { head: string; rest?: string } {
  const m = /\s+[—–-]\s+|:\s+/.exec(s);
  if (!m) return { head: s.trim() };
  return { head: s.slice(0, m.index).trim(), rest: s.slice(m.index + m[0].length).trim() || undefined };
}

export function plainThread(text: string): Plain {
  const chips: Chip[] = [];
  let s = text.trim();

  // A wake's own id is for the clock, not for people.
  s = s.replace(/^w-[0-9a-f]{4,10}\s+/, '');

  // A lane's dated entry: "knowledge-verify 2026-10-30: …", "reflect 2026-10-29 23:17: …".
  const lane = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s+\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?\s*(?:[:—–-]\s*)?(.*)$/s.exec(s);
  if (lane && !TASK.test(s)) {
    chips.push({ label: words(lane[1]) });
    const { head, rest } = split(lane[2] || words(lane[1]));
    return { title: cap(head), ...(rest ? { detail: cap(rest) } : {}), chips };
  }

  // The tasks it was about, up front: "t-1683 …", "t-1061/t-1063 …", "t-1652: …", "t-1486 part (c) …".
  const tasks = /^((?:t-\d+)(?:\s*[/,]\s*t-\d+)*)(?:\s+part\s+\(?([a-z0-9]+)\)?)?\s*:?\s*/.exec(s);
  if (tasks) {
    for (const id of tasks[1].split(/\s*[/,]\s*/)) chips.push({ label: id, page: `loom:p/tasks/task/${id}` });
    if (tasks[2]) chips.push({ label: `part ${tasks[2]}` });
    s = s.slice(tasks[0].length);
  }

  // A watch on a pull request: "PR33 nudge-watch round 10", "PR385 review-watch round 1", "nudge-watch self-heal …".
  const watch = /^(?:PR\s?#?(\d+)\s+)?(nudge|review|reply|merge)-watch(?:\s+self-heal)?(?:\s+round\s+(N\+\d+|\d+))?\s*/i.exec(s);
  if (watch && (watch[1] || watch[3])) {
    if (watch[3]) chips.push({ label: `round ${watch[3]}` });
    let after = s.slice(watch[0].length).replace(/^[:—–-]\s*/, '').trim();
    // The tasks and pull requests may follow instead: "round 9: t-1061/t-1063 PR17/PR19 stall flag still silent".
    const more = /^((?:t-\d+)(?:\s*[/,]\s*t-\d+)*)\s*/.exec(after);
    if (more) { for (const id of more[1].split(/\s*[/,]\s*/)) chips.push({ label: id, page: `loom:p/tasks/task/${id}` }); after = after.slice(more[0].length); }
    const prs = [...(watch[1] ? [watch[1]] : [])];
    const list = /^(PR\s?#?\d+(?:\s*[/,]\s*PR\s?#?\d+)*)\s*/i.exec(after);
    if (list) { prs.push(...list[1].split(/\s*[/,]\s*/).map((x) => x.replace(/\D/g, ''))); after = after.slice(list[0].length); }
    const what = { nudge: 'Checked on', review: 'Watched the review of', reply: 'Waited on a reply to', merge: 'Watched the merge of' }[watch[2].toLowerCase()] ?? 'Checked on';
    const named = prs.map((n) => `PR ${n}`).join(' and ');
    return { title: named ? `${what} ${named}` : `${cap(watch[2])} watch`, ...(after ? { detail: cap(after) } : {}), chips };
  }

  // A channel it spoke in: "#pond: Loren docket rundown" (the where already says Discord #pond).
  s = s.replace(/^#[a-z0-9_-]+:\s+/i, '');

  const { head, rest } = split(s || text);
  // A label of its own before the rest ("night-shift: built …", "oauth-refresh-token-sentinel: silent watch",
  // "checkback round 3 — still pending"): lowercase, a word or three. It's a chip; what follows is what happened.
  if (rest && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?: [a-z0-9]+){0,2}$/.test(head) && /[-\d]/.test(head)) {
    chips.push({ label: words(head) });
    return { title: cap(rest), chips };
  }
  // A short head with a long rest reads better whole.
  if (rest && head.length < 18 && !tasks) return { title: cap(s), chips };
  return { title: cap(head), ...(rest ? { detail: cap(rest) } : {}), chips };
}

/** "Today", "Yesterday", or "Wed Oct 28": a day's heading in the ledger. */
export function dayOf(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date(nowMs)) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "2:02 PM". */
export function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
