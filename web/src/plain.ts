// The Inbox's items in plain words (web/src/inbox.tsx): no React here, so it's tested on its own (src/ui/inbox-plain.test.ts).

export type Plain = {
  /** The row's line: "Art E Fish asked for a token: github-jbarket-onterris-token". */
  title: string;
  /** The drawer's head, with what it was for apart (the token's name) when there is one. */
  head: string; subject?: string;
  /** The agent's own why. */
  why?: string;
  /** How it ended, in a word or two (the row's badge). */
  ended?: string;
  /** The answer, taken apart: Allowed or Declined, by whom, for how long. */
  answer?: { verdict: string; by?: string; for?: string };
};

/** An item in plain words (Jonathan, 2026-10-29: "Art requested access to a token: github-jbarket-onterris-token"):
 * what it is as a headline, the agent's own why under it, and how it ended. Anything that matches none of these is
 * shown as written. */
export function plain(i: { text: string; outcome?: string; meta?: string }, name: string): Plain {
  const who = name || 'An agent';
  // "art asked for …" (answered) and "art asks for …" (still waiting): the same shape.
  const said = /^\S+ (ask(?:ed|s) for|ask(?:ed|s):)\s*(.*)$/s.exec(i.text);
  let title = i.text, head = i.text, subject: string | undefined, why: string | undefined = i.meta;
  const verb = said && /^asks/.test(said[1]) ? 'asks' : 'asked';
  if (said && /for$/.test(said[1])) {
    const m = /^([\w.-]+):\s*[“"](.*)[”"]\s*$/s.exec(said[2]);
    if (m) { head = `${who} ${verb} for ${/token|key$/i.test(m[1]) ? 'a token' : 'a secret'}`; subject = m[1]; title = `${head}: ${m[1]}`; why = m[2]; }
  } else if (said) {
    const m = /^run on loom's machine:\s*(.*)$/s.exec(said[2]);
    title = head = m ? `${who} ${verb} to run something on loom's machine` : `${who} ${verb} for your OK`;
    why = (m ? m[1] : said[2]).trim();
  }
  const o = i.outcome ?? '';
  const ended = !o ? undefined : /expired unused/i.test(o) ? 'Expired unused' : /ran out/i.test(o) ? 'Used, ran out'
    : /and used/i.test(o) ? 'Used' : /^(denied|refused|declined)/i.test(o) ? 'Declined' : /^blocked/i.test(o) ? 'Blocked' : /^allowed/i.test(o) ? 'Allowed' : undefined;
  return { title, head, subject, why: why || undefined, ended, answer: o ? answerOf(o) : undefined };
}

/** "Allowed for 480 min (by the policy); it ran out." → Allowed, by your standing rule, for 8 hours. */
function answerOf(o: string): Plain['answer'] {
  const verdict = /^allowed/i.test(o) ? 'Allowed' : /^(denied|refused|declined)/i.test(o) ? 'Declined' : /^blocked/i.test(o) ? 'Blocked' : '';
  if (!verdict) return undefined;
  const by = /by the policy/i.test(o) ? 'your standing rule' : /by ([a-z][\w-]*)/i.exec(o)?.[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const min = Number(/for (\d+) min/i.exec(o)?.[1]);
  return { verdict, ...(by ? { by } : {}), ...(min ? { for: duration(min) } : {}) };
}

export function duration(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.floor(h)}h ${min % 60}m`;
}

/** The why, cut where it names something openable: a task (t-1682), a pull request or issue (onterris/on-pond#178; a
 * bare art#68 too, under the household's GitHub owner `owner` when it has one), a conversation (cv-…), a file
 * (~/Art/notes/…md). The drawer links the first three and sets the last as code. */
export type Bit = { t: 'text'; s: string } | { t: 'task'; id: string } | { t: 'pr'; repo: string; n: string } | { t: 'conv'; id: string } | { t: 'path'; s: string };
export function bits(s: string, owner?: string): Bit[] {
  const out: Bit[] = [];
  const re = /\b(t-\d+)\b|(?<![\w./-])([\w.-]+\/)?([\w.-]+)#(\d+)\b|\b(cv-[0-9a-f]{12})\b|(~\/[^\s,;)]+)/g;
  let at = 0;
  for (let m; (m = re.exec(s));) {
    // A bare repo#N is a link only under a known owner; else it's words, as written.
    if (m[4] && !m[2] && !owner) continue;
    if (m.index > at) out.push({ t: 'text', s: s.slice(at, m.index) });
    out.push(m[1] ? { t: 'task', id: m[1] } : m[4] ? { t: 'pr', repo: `${m[2] ? m[2].slice(0, -1) : owner}/${m[3]}`, n: m[4] }
      : m[5] ? { t: 'conv', id: m[5] } : { t: 'path', s: m[6].replace(/[.]$/, '') });
    if (m[6]?.endsWith('.')) out.push({ t: 'text', s: '.' });
    at = re.lastIndex;
  }
  if (at < s.length) out.push({ t: 'text', s: s.slice(at) });
  return out;
}

/** What an item names that opens, once each, in order: its pull requests and issues, tasks and conversations. */
export function refsOf(s: string, owner?: string): Bit[] {
  const seen = new Set<string>();
  return bits(s, owner).filter((b) => {
    if (b.t === 'text' || b.t === 'path') return false;
    const k = b.t === 'pr' ? `${b.repo}#${b.n}` : b.id;
    return !seen.has(k) && !!seen.add(k);
  });
}

/** A pull request's or issue's page: GitHub's /issues/N opens either (a pull request's redirects to its own). */
export const githubUrl = (repo: string, n: string) => `https://github.com/${repo}/issues/${n}`;

/** Where an item opens (Jonathan, 2026-11-02: "it should go to the item itself"): its own page when it has one (a
 * task's, t-1273's), else its sheet in the Inbox. Its own page is a page its piece links that isn't the piece's front
 * page (that says nothing of the item); an item with buttons opens on them (the sheet), and an answered one is
 * history, told in its sheet. The Inbox's row and Home's banner both open this way. */
export function opensTo(i: { key: string; kind: string; page?: string; actions?: unknown[] }): { page: string } | { sheet: string } {
  return i.page && i.kind !== 'answered' && !i.actions?.length ? { page: i.page } : { sheet: `/inbox?i=${i.key}` };
}

/** Opening an item: an unread one is read first, wherever it opens (its own page, or its sheet here), the way
 * /inbox?i=<key> reads it; then it opens. Its sheet from elsewhere is that address, which reads it itself. */
export async function openItem(i: { key: string; kind: string; page?: string; actions?: unknown[]; unread?: boolean },
  to: { read: (key: string) => Promise<unknown>; page: (page: string) => void; sheet?: () => void; go: (href: string) => void }): Promise<void> {
  const where = opensTo(i);
  if (i.unread && ('page' in where || to.sheet)) await to.read(i.key).catch(() => undefined);
  if ('page' in where) to.page(where.page);
  else if (to.sheet) to.sheet();
  else to.go(where.sheet);
}

/**
 * Who asks, in words (t-1970): the agent, or, for another agent's request it passed on (a relay), that agent first:
 * "Mark, via Art E Fish". `name` turns an agent's id into its name. `asks` is the line a chip says: "Mark asks, via Art".
 */
export function askerOf(i: { agent?: string; relayedFrom?: string }, name: (a?: string) => string): { who: string; asks: string } {
  const by = name(i.agent);
  if (!i.relayedFrom || !by) return { who: by, asks: by ? `${by} asks` : '' };
  const from = name(i.relayedFrom);
  return { who: `${from}, via ${by}`, asks: `${from} asks, via ${by}` };
}
