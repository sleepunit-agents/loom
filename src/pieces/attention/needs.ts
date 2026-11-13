/**
 * Needs you, as an agent writes it (docs/specs/conversations.md, "Needs you"): what a digest's `needs_owner` asks
 * the owner. An ask is for a person, not for the agent's own bookkeeping (Jonathan, 2026-11-03, on "Allow local-wake
 * card a-7693c00e on loom's Home so Art can set up the rclone→Drive backup for t-40 (round 9)": "I don't know wtf that
 * wants from me"). So it's a small object: one plain question, why, what happens either way, the link, the ids it's
 * about (links and details, never the headline), and what resolves it, which core checks and clears it on.
 *
 * A plain string is still taken, as before (the ask alone), and both are linted: an ask naming internal ids or lane
 * words is refused with why, so the agent says it again in words. No model in the loop: patterns, small and tested.
 */

/** How an ask is answered (NeedsOwner.answers). */
export type NeedsAnswers = 'yes-no' | 'words';
export const NEEDS_ANSWERS: readonly NeedsAnswers[] = ['yes-no', 'words'];

/** What an ask waits on: when that's resolved, the ask clears itself (src/needs-resolve.ts). */
export type WaitsOn = { approval: string } | { task: string };

export interface NeedsOwner {
  /** The one question or request, in plain words: the headline everywhere. */
  ask: string;
  why?: string;
  if_yes?: string;
  if_no?: string;
  /** The exact thing to open (a pull request): https only. */
  href?: string;
  /** The ids it's about (t-40, a-7693c00e, owner/repo#12): links and details. */
  refs: string[];
  waits_on?: WaitsOn;
  /** How it's answered: `yes-no` (the sheet's Yes and No, each sending its if_yes or if_no line), or `words` (a reply
   * only). Left off, an ask with if_yes or if_no is a yes/no question. */
  answers?: NeedsAnswers;
  /** Written as a plain string (before the object, or since): its headline keeps "<agent> needs you: …". */
  legacy?: true;
}

export const MAX_NEEDS_ASK = 140;
export const MAX_NEEDS_WHY = 240;
export const MAX_NEEDS_IF = 140;
export const MAX_NEEDS_STRING = 200;
export const MAX_NEEDS_HREF = 500;
export const MAX_NEEDS_REFS = 8;

const APPROVAL = /^a-[0-9a-f]{8}$/;
const TASK = /^t-\d{1,7}$/;
const PR = /^(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+#\d{1,7}$/;
const CONV = /^cv-[0-9a-f]{12}$/;
const isRef = (s: string) => APPROVAL.test(s) || TASK.test(s) || PR.test(s) || CONV.test(s);

/** Internal ids and lane words: they mean something to the agent, nothing to the owner reading their Inbox. */
const INTERNAL: ReadonlyArray<RegExp> = [
  /\ba-[0-9a-f]{8}\b/gi, /\bcv-[0-9a-f]{6,}\b/gi, /\bdg-[0-9a-f]{6,}\b/gi, /\bw-[0-9a-f]{6,}\b/gi, /\bh-\d+\b/gi,
  /\bround\s+\d+\b/gi, /\bnudge[- ]watch\b/gi, /\bchain[- ]check\b/gi, /\blocal[- ]wake\b/gi,
];
/** An object's ask names no task or pull request either: those go in refs, which link them. */
const REFS_IN_WORDS: ReadonlyArray<RegExp> = [/\bt-\d+\b/gi, /(?<![\w./-])(?:[\w.-]+\/)?[\w.-]+#\d+\b/g];

/**
 * What in `ask` the owner can't read: each internal id or lane word, as written. `strict` (an object's ask) also
 * finds task and pull request ids, which belong in refs; a plain string has nowhere else to put them, so it keeps them.
 */
export function lintAsk(ask: string, strict: boolean): string[] {
  const found: string[] = [];
  for (const re of strict ? [...INTERNAL, ...REFS_IN_WORDS] : INTERNAL) for (const m of ask.matchAll(re)) found.push(m[0]);
  return [...new Set(found)];
}

const EXAMPLE = '{"ask": "OK to install rclone and restic on loom\'s machine to set up the Google Drive backup?", '
  + '"why": "The nightly backup has no offsite copy yet.", "if_yes": "I install them and run the first backup tonight.", '
  + '"if_no": "Backups stay on this machine only.", "refs": ["t-40", "a-7693c00e"], "waits_on": {"approval": "a-7693c00e"}}';

function lintError(where: string, found: string[], strict: boolean): string {
  return `${where} is what the owner reads first, so it says in plain words what you need decided or done: it can't `
    + `name ${found.map((f) => JSON.stringify(f)).join(', ')}. `
    + (strict ? 'Put ids in needs_owner.refs (they become links), the rest in why, and ask again, like '
      : 'Write needs_owner as an object, with ids in refs (they become links), like ')
    + EXAMPLE;
}

const oneLine = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\r\n]/.test(v);

export function isHttpsUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !/\s/.test(s); } catch { return false; }
}

const NEEDS_KEYS = ['ask', 'why', 'if_yes', 'if_no', 'answers', 'href', 'refs', 'waits_on'] as const;

/**
 * A digest's needs_owner (and the older needs_owner_href beside it), checked: null, a plain one-line string, or the
 * object. Returns the error to answer the agent with as a string. An approval in refs, with no waits_on, is what it
 * waits on (one of them; with several it says which).
 */
export function parseNeeds(raw: unknown, href: unknown): NeedsOwner | null | string {
  if (href !== undefined && href !== null && (typeof href !== 'string' || href.length > MAX_NEEDS_HREF || !isHttpsUrl(href))) {
    return `needs_owner_href is null or an https:// URL of at most ${MAX_NEEDS_HREF} characters`;
  }
  const hrefS = typeof href === 'string' ? href : undefined;
  if (raw === undefined || raw === null) {
    return hrefS ? 'needs_owner_href goes with needs_owner: it is the exact thing the owner is needed for' : null;
  }
  if (typeof raw === 'string') {
    if (!oneLine(raw, MAX_NEEDS_STRING)) return `needs_owner is null, a one-line ask of at most ${MAX_NEEDS_STRING} characters, or the object (ask, why, if_yes, if_no, href, refs, waits_on)`;
    const found = lintAsk(raw, false);
    if (found.length) return lintError('needs_owner', found, false);
    return { ask: raw.trim(), refs: refsIn(raw), ...(hrefS ? { href: hrefS } : {}), legacy: true };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'needs_owner is null, a one-line string, or an object with ask (and why, if_yes, if_no, href, refs, waits_on)';
  const o = raw as Record<string, unknown>;
  const bad = Object.keys(o).find((k) => !(NEEDS_KEYS as readonly string[]).includes(k));
  if (bad !== undefined) return `needs_owner has no key ${JSON.stringify(bad)} (it has ${NEEDS_KEYS.join(', ')})`;
  if (!oneLine(o.ask, MAX_NEEDS_ASK)) return `needs_owner.ask is one plain question or request of at most ${MAX_NEEDS_ASK} characters, on one line`;
  const found = lintAsk(o.ask, true);
  if (found.length) return lintError('needs_owner.ask', found, true);
  for (const [k, max] of [['why', MAX_NEEDS_WHY], ['if_yes', MAX_NEEDS_IF], ['if_no', MAX_NEEDS_IF]] as const) {
    if (o[k] !== undefined && o[k] !== null && !oneLine(o[k], max)) return `needs_owner.${k} is one line of at most ${max} characters`;
  }
  if (o.href !== undefined && o.href !== null) {
    if (typeof o.href !== 'string' || o.href.length > MAX_NEEDS_HREF || !isHttpsUrl(o.href)) return `needs_owner.href is an https:// URL of at most ${MAX_NEEDS_HREF} characters`;
    if (hrefS && hrefS !== o.href) return 'give the link once: needs_owner.href (needs_owner_href is the older name for it)';
  }
  if (o.answers !== undefined && o.answers !== null && !(NEEDS_ANSWERS as readonly unknown[]).includes(o.answers)) {
    return 'needs_owner.answers is "yes-no" (the owner answers with Yes or No) or "words" (they reply in their own words)';
  }
  const refs = o.refs ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_NEEDS_REFS || !refs.every((r) => typeof r === 'string' && isRef(r))) {
    return `needs_owner.refs is a list of at most ${MAX_NEEDS_REFS} ids: tasks (t-40), approvals (a-7693c00e), pull requests or issues (owner/repo#12), conversations (cv-…)`;
  }
  const out: NeedsOwner = {
    ask: o.ask.trim(), refs: [...new Set(refs as string[])],
    ...(typeof o.why === 'string' ? { why: o.why.trim() } : {}),
    ...(typeof o.if_yes === 'string' ? { if_yes: o.if_yes.trim() } : {}),
    ...(typeof o.if_no === 'string' ? { if_no: o.if_no.trim() } : {}),
    ...(typeof o.answers === 'string' ? { answers: o.answers as NeedsAnswers } : {}),
    ...(typeof o.href === 'string' ? { href: o.href } : hrefS ? { href: hrefS } : {}),
  };
  if (o.waits_on !== undefined && o.waits_on !== null) {
    const w = parseWaitsOn(o.waits_on);
    if (typeof w === 'string') return w;
    out.waits_on = w;
    const id = 'approval' in w ? w.approval : w.task;
    if (!out.refs.includes(id)) out.refs.push(id);
    if (out.refs.length > MAX_NEEDS_REFS) return `needs_owner.refs, with what it waits on, is at most ${MAX_NEEDS_REFS} ids`;
  } else {
    const approvals = out.refs.filter((r) => APPROVAL.test(r));
    if (approvals.length === 1) out.waits_on = { approval: approvals[0] };
  }
  return out;
}

function parseWaitsOn(v: unknown): WaitsOn | string {
  const shape = 'needs_owner.waits_on is what resolves the ask, one of {"approval": "a-…"} or {"task": "t-…"}';
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return shape;
  const keys = Object.keys(v);
  if (keys.includes('pr')) {
    return 'needs_owner.waits_on can\'t be a pull request: loom has no way to read GitHub, so it would never clear. Leave '
      + 'waits_on off, put the pull request in refs and href, and write a later digest with needs_owner null once it\'s merged';
  }
  if (keys.length !== 1) return shape;
  const o = v as Record<string, unknown>;
  if ('approval' in o) return typeof o.approval === 'string' && APPROVAL.test(o.approval) ? { approval: o.approval } : 'needs_owner.waits_on.approval is an approval id (a- and 8 hex digits)';
  if ('task' in o) return typeof o.task === 'string' && TASK.test(o.task) ? { task: o.task } : 'needs_owner.waits_on.task is a task id (t-40)';
  return shape;
}

/** The ids a plain string names, in order, once each (a stored one, or one written since). */
export function refsIn(s: string): string[] {
  const out: string[] = [];
  const re = /\b(a-[0-9a-f]{8})\b|\b(t-\d{1,7})\b|(?<![\w./-])((?:[\w.-]+\/)?[\w.-]+#\d{1,7})\b|\b(cv-[0-9a-f]{12})\b/g;
  for (const m of s.matchAll(re)) { const id = m[1] ?? m[2] ?? m[3] ?? m[4]; if (!out.includes(id)) out.push(id); }
  return out.slice(0, MAX_NEEDS_REFS);
}

/** How the owner answers an ask: as it says, else a yes/no question when it says what happens either way. */
export function answersOf(n: NeedsOwner): NeedsAnswers {
  if (n.answers) return n.answers;
  return !n.legacy && (n.if_yes || n.if_no) ? 'yes-no' : 'words';
}

