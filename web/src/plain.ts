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

/** The why, cut where it names something openable: a task (t-1682), a pull request (onterris/on-pond#178), a file
 * (~/Art/notes/…md). The drawer links the first two and sets the third as code. */
export type Bit = { t: 'text'; s: string } | { t: 'task'; id: string } | { t: 'pr'; repo: string; n: string } | { t: 'path'; s: string };
export function bits(s: string): Bit[] {
  const out: Bit[] = [];
  const re = /\b(t-\d+)\b|\b([\w.-]+\/[\w.-]+)#(\d+)\b|(~\/[^\s,;)]+)/g;
  let at = 0;
  for (let m; (m = re.exec(s));) {
    if (m.index > at) out.push({ t: 'text', s: s.slice(at, m.index) });
    out.push(m[1] ? { t: 'task', id: m[1] } : m[2] ? { t: 'pr', repo: m[2], n: m[3] } : { t: 'path', s: m[4].replace(/[.]$/, '') });
    if (m[4]?.endsWith('.')) out.push({ t: 'text', s: '.' });
    at = re.lastIndex;
  }
  if (at < s.length) out.push({ t: 'text', s: s.slice(at) });
  return out;
}
