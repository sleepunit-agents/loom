/**
 * POST /api/loom/audit/take (docs/specs/conversations.md, "The audit log"): the one place raw
 * text leaves the audit log, to a grading run holding a review token. It claims entries
 * (src/audit.ts, `claimEntries`, which writes audit_reads), decrypts each with the review key
 * (`decryptAuditText`: this handler is its only caller, criterion 9), and redacts before
 * anything leaves:
 *  - every person card's name and slug, every person slug a conversation has seen (card or
 *    not), and each part of a name or slug of 3 letters or more, becomes P1, P2, …;
 *  - every agent id becomes A1, …;
 *  - every model and harness string seen in any turn becomes M1, … or H1, …;
 * case-insensitive and whole-word, numbered by first appearance, consistent within the take.
 * An entry's `agent` is its A… placeholder. `family` is the producing turn's model's family,
 * never the model, so the runtime can choose graders without learning who produced it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSqliteDbPath } from './config.js';
import { agentDir, type Household } from './household.js';
import { commonsPeoplePath } from './backends/people-household.js';
import { PeopleStore } from './backends/people.js';
import { agentsSeen, modelsSeen, peopleSeen, turnRecord } from './backends/conversations.js';
import { modelsNoted } from './household-store.js';
import { AUDIT_DB, assertDecryptReady, AuditError, claimEntries, decryptAuditText, releaseClaims, TAKE_MAX, UndecryptableEntry } from './audit.js';
import { familyOf, processedFamilies, withNonOwner } from './review.js';

export interface TakenEntry {
  ref: string;
  /** The entry's agent, as its A… placeholder. */
  agent: string;
  venue: string;
  /** The turn's kind (message, reply, …). */
  kind: string;
  /** The producing turn's model's family; null for a turn with no model (someone else's words). */
  family: string | null;
  text: string;
  /**
   * Present on an entry from a conversation with someone other than the owner: the only
   * families that may grade it (those that already processed it). Empty means none may.
   */
  only_families?: string[];
}

type Cls = 'P' | 'A' | 'M' | 'H';

/** The names redaction knows, each to the thing it stands for. */
export interface Vocabulary {
  agents: string[];
  people: Array<{ slug: string; name: string }>;
  models: string[];
  harnesses: string[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/\u2019/g, "'").toLowerCase();
/** A part of a name is redacted from this many letters: shorter ones ("Al", "Jo", "O") would blank common words. */
export const NAME_PART_MIN = 3;
/**
 * A name's (or slug's) parts: each whitespace word ("O'Brien", "Mary-Kate"), and each piece of
 * those split on hyphens and apostrophes ("Brien", "Mary", "Kate"), of NAME_PART_MIN letters or more.
 */
const nameParts = (s: string) => s.split(/\s+/).flatMap((w) => [w, ...w.split(/[-\u2010\u2011'\u2019]+/)])
  .filter((w) => w.replace(/[^\p{L}]/gu, '').length >= NAME_PART_MIN);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A redactor for one take: `agent(id)` and `text(s)` share one numbering, by first
 * appearance. A term matching more than one thing goes to the first of agent, person, model,
 * harness. Matching is case-insensitive and whole-word (no letter, digit or _ either side),
 * and whitespace inside a name matches any run of whitespace.
 */
export function redactor(v: Vocabulary): { agent(id: string): string; text(s: string): string } {
  const terms = new Map<string, { cls: Cls; id: string }>();
  const put = (term: string, cls: Cls, id: string) => {
    const k = norm(term);
    if (k && !terms.has(k)) terms.set(k, { cls, id: `${cls}:${id}` });
  };
  const agentIds = new Set(v.agents.map((a) => a.toLowerCase()));
  for (const a of v.agents) put(a, 'A', a.toLowerCase());
  for (const p of v.people) {
    // An agent's own People entry (agents-in-people.md) is that agent.
    const isAgent = agentIds.has(p.slug.toLowerCase());
    const cls: Cls = isAgent ? 'A' : 'P';
    const id = p.slug.toLowerCase();
    put(p.slug, cls, id);
    if (p.name) put(p.name, cls, id);
  }
  // Then each part of every name and slug (a first name alone is still a name; "O'Brien" is
  // caught whole above and as "Brien" here), after every whole term, so a whole term wins.
  for (const p of v.people) {
    const cls: Cls = agentIds.has(p.slug.toLowerCase()) ? 'A' : 'P';
    for (const w of [...nameParts(p.name), ...nameParts(p.slug)]) put(w, cls, p.slug.toLowerCase());
  }
  for (const m of v.models) put(m, 'M', m.toLowerCase());
  for (const x of v.harnesses) put(x, 'H', x.toLowerCase());
  const numbers = new Map<string, string>();
  const counters: Record<Cls, number> = { P: 0, A: 0, M: 0, H: 0 };
  const placeholder = (t: { cls: Cls; id: string }) => {
    let p = numbers.get(t.id);
    if (!p) { p = `${t.cls}${++counters[t.cls]}`; numbers.set(t.id, p); }
    return p;
  };
  const keys = [...terms.keys()].sort((a, b) => b.length - a.length);
  const re = keys.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${keys.map((k) => escape(k).replace(/ /g, '\\s+').replace(/'/g, "['\u2019]")).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
    : null;
  return {
    agent: (id) => placeholder(terms.get(norm(id)) ?? { cls: 'A', id: `A:${id.toLowerCase()}` }),
    // A match whose folded form isn't a key (a case-fold the map can't see) is still removed.
    text: (s) => (re ? s.replace(re, (m) => { const t = terms.get(norm(m)); return t ? placeholder(t) : '[redacted]'; }) : s),
  };
}

/**
 * Every person redaction knows: each card's slug and name (the commons directory and each
 * agent's own store, through the people backend), and every person slug a conversation has
 * seen (its `people`, and each turn `from` a person), so someone with no card is redacted by
 * slug all the same. A people store that's there but can't be read fails the take (503): a
 * schema move must never quietly stop names being redacted.
 */
function peopleOf(h: Household): Array<{ slug: string; name: string }> {
  const out: Array<{ slug: string; name: string }> = [];
  for (const a of h.agents) for (const slug of peopleSeen(agentDir(h, a))) out.push({ slug, name: '' });
  const unreadable = () => new AuditError('a people store can\'t be read, so names couldn\'t be redacted; nothing was taken', 503);
  // `optional`: an agent's store may never have held a card (no people table at all).
  const read = (path: string, optional: boolean) => {
    if (!existsSync(path)) return;
    let store: PeopleStore;
    try { store = new PeopleStore({ dbPath: path, readonly: true }); } catch { throw unreadable(); }
    try {
      if (!store.migrated) {
        if (!optional || store.holdsPeople) throw unreadable();
        return;
      }
      for (const e of store.list(true)) out.push({ slug: e.slug, name: e.name ?? '' });
    } catch (e) {
      throw e instanceof AuditError ? e : unreadable();
    } finally {
      store.close();
    }
  };
  read(commonsPeoplePath(h), false);
  for (const a of h.agents) read(resolveSqliteDbPath(agentDir(h, a)), true);
  return out;
}

/** What redaction replaces in this household, read fresh for each take. */
export function vocabularyOf(h: Household): Vocabulary {
  const agents = new Set(h.agents);
  // The household's kept names first (they outlive the fold), then whatever the stores hold.
  const noted = modelsNoted(h.home);
  const models = new Set<string>(noted.models);
  const harnesses = new Set<string>(noted.harnesses);
  for (const a of h.agents) {
    const dir = agentDir(h, a);
    for (const x of agentsSeen(dir)) agents.add(x);
    const seen = modelsSeen(dir);
    for (const m of seen.models) models.add(m);
    for (const x of seen.harnesses) harnesses.add(x);
  }
  return { agents: [...agents], people: peopleOf(h), models: [...models], harnesses: [...harnesses] };
}

/**
 * The take handler: `{limit ≤ 500}` (default 100). Answers `{entries}`, oldest first across
 * the household's agents, entries not yet taken, each redacted. An entry that won't decrypt is
 * left out (and stays claimed, so the 7-day sweep removes it); its text is never logged. So is
 * an entry of an agent no longer in the household (the vocabulary doesn't know its names).
 */
export function takeAudit(h: Household, run: string, raw: unknown, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): { entries: TakenEntry[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'limit')) throw new AuditError('a take is {limit}');
  const limit = (raw as { limit?: unknown }).limit ?? 100;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > TAKE_MAX) throw new AuditError(`limit is 1-${TAKE_MAX}`);
  // Nothing to take: no log yet (and no key needed).
  if (!existsSync(join(h.home, AUDIT_DB))) return { entries: [] };
  // Without age or the review key nothing could be decrypted: claim nothing, so the entries
  // wait for a run that can.
  assertDecryptReady(h.home, env);
  // The vocabulary before any claim: a store it can't read fails the take with nothing claimed.
  const r = redactor(vocabularyOf(h));
  const claimed = claimEntries(h.home, run, limit, now);
  if (!claimed.length) return { entries: [] };
  const entries: TakenEntry[] = [];
  let undecryptable = 0;
  let departed = 0;
  for (const e of claimed) {
    // An agent no longer in the household isn't in the vocabulary: its names would go out
    // unredacted. Never handed out; it stays claimed, so the 7-day sweep removes it.
    if (!h.agents.includes(e.agent)) { departed++; continue; }
    let text: string;
    try {
      text = decryptAuditText(h.home, e.blob, env);
    } catch (err) {
      // A blob age rejects stays claimed (the sweep removes it). Anything else is the decrypt
      // itself failing: this take's claims are released, and the take answers 503.
      if (err instanceof UndecryptableEntry) { undecryptable++; continue; }
      releaseClaims(h.home, run, claimed.map((c) => c.ref));
      throw err instanceof AuditError ? err : new AuditError('the audit log couldn\'t be decrypted; nothing was taken', 503);
    }
    const turn = turnRecord(agentDir(h, e.agent), e.conversation, e.seq);
    const nonOwner = withNonOwner(h, e.agent, e.conversation);
    entries.push({
      ref: e.ref,
      agent: r.agent(e.agent),
      venue: e.venue,
      kind: e.kind,
      family: familyOf(turn?.model, h),
      text: r.text(text),
      ...(nonOwner ? { only_families: processedFamilies(h, e.agent, e.conversation) } : {}),
    });
  }
  if (departed) process.stderr.write(`loom: ${departed} audit entr${departed === 1 ? 'y' : 'ies'} of agents no longer in the household were left out of the take\n`);
  if (undecryptable) process.stderr.write(`loom: ${undecryptable} audit entr${undecryptable === 1 ? 'y' : 'ies'} didn't decrypt and were left out of the take\n`);
  return { entries };
}
