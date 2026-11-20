/**
 * Review's household-wide records (docs/specs/conversations.md, "Review"): model families,
 * the scores graders post by ref, the findings they leave, and the scorecards core builds.
 *
 * Core keeps the mapping from a ref to the turn it stands for (audit_reads in household.db),
 * so a score is posted knowing only the sample's family, and core turns it into scorecard rows
 * naming the producer's model and harness. The blindness is the grader's: a grader sees only
 * the redacted sample. The runtime is not blind; it reads the scorecards, and may learn a
 * ref's model from them.
 * The metadata measures (first_reply_s, abandoned, due_to_progress_s, done_rate,
 * round_trips, loops_refused) come from turns alone, per UTC day (`computeMeasures`).
 */
import { agentDir, FAMILY_NAME, type Household } from './household.js';
import {
  AGENT_TURN_KINDS, ConversationError, conversationsActive, dueToProgressSeconds, getConversation, median, modelsSeen, turnRecord, turnsOf, writeFinding,
  type Finding, type From, type Turn,
} from './backends/conversations.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_VENUE_ROWS, HOUSEHOLD_DB, hasStrangers, listVenues, modelsNoted, venueOf, withHouseholdDb } from './household-store.js';
import { AuditError, refOf } from './audit.js';

const fail = (m: string, status = 400): never => { throw new AuditError(m, status); };
const DAY_MS = 86_400_000;
/** A model, family or harness nothing names. */
const UNKNOWN = 'unknown';

// ─── Families ───────────────────────────────────────────────────────────────

/**
 * Built-in model-name prefixes for each family. household.json's `families` adds to and
 * overrides them: an exact model name first, then its longest matching `prefix*`, then these.
 */
export const FAMILY_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['claude', 'opus', 'sonnet', 'haiku', 'fable'],
  openai: ['gpt', 'chatgpt', 'o1', 'o3', 'o4', 'codex'],
  google: ['gemini', 'gemma'],
  meta: ['llama'],
  mistral: ['mistral', 'mixtral', 'codestral', 'magistral', 'devstral'],
  alibaba: ['qwen'],
  deepseek: ['deepseek'],
  xai: ['grok'],
  moonshot: ['kimi'],
  zhipu: ['glm'],
};

/** A model's family (its provider), or null when neither household.json nor the built-in prefixes know it. */
export function familyOf(model: string | null | undefined, h?: Pick<Household, 'families'>): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  const own = h?.families ?? {};
  // Own keys only, never the prototype's ("constructor", "toString"…), and only a well-formed family.
  const valid = (f: unknown): f is string => typeof f === 'string' && FAMILY_NAME.test(f) && f !== UNKNOWN;
  if (Object.hasOwn(own, m) && valid(own[m])) return own[m];
  const prefixes = Object.entries(own).filter(([k, f]) => k.endsWith('*') && m.startsWith(k.slice(0, -1)) && valid(f)).sort((a, b) => b[0].length - a[0].length);
  if (prefixes.length) return prefixes[0][1];
  // "anthropic/claude-…", "openai:gpt-…": a provider prefix that is a family names it.
  const lead = /^([a-z][a-z0-9-]*)[/:]/.exec(m)?.[1];
  if (lead && Object.hasOwn(FAMILY_PREFIXES, lead)) return lead;
  const name = m.slice(m.search(/[^/:]*$/));
  for (const [family, ps] of Object.entries(FAMILY_PREFIXES)) {
    if (ps.some((p) => name === p || (name.startsWith(p) && /^[-._:@0-9]/.test(name.slice(p.length))))) return family;
  }
  return null;
}

// ─── Who the conversation is with ───────────────────────────────────────────

/**
 * Whether conversation `id` (agent's) is with someone other than the agent's owners: a person
 * who isn't a household member owning this agent, or anyone unknown. Those are graded only by
 * families that already processed the conversation (Review, step 2).
 */
export function withNonOwner(h: Household, agent: string, id: string): boolean {
  // The sticky mark first: set by every turn from a stranger, never cleared.
  if (hasStrangers(h.home, agent, id)) return true;
  const c = getConversation(agentDir(h, agent), id);
  if (!c) return true;
  // A conversation from before the mark existed: what its record still shows.
  if (c.people.some((p) => isStranger(h, agent, { kind: 'person', slug: p }))) return true;
  return turnsOf(agentDir(h, agent), id).some((t) => isStranger(h, agent, t.from));
}

/** Whether a turn `from` is someone other than `agent`'s owners: a person who isn't a member owning it, or anyone unknown. */
export function isStranger(h: Household, agent: string, from: From): boolean {
  if (from.kind === 'unknown') return true;
  if (from.kind !== 'person') return false;
  return !h.members.some((m) => m.person === from.slug && (m.agents === '*' || m.agents.includes(agent)));
}

/**
 * The families some household agent's model resolves to: the only families that may grade.
 * The models are the ones the runtime (or a harness) wrote on turns, kept household-wide by
 * noteModels: the runtime is trusted here, as it mints the review tokens.
 */
export function householdFamilies(h: Household): string[] {
  const out = new Set<string>();
  const models = [...modelsNoted(h.home).models, ...h.agents.flatMap((a) => modelsSeen(agentDir(h, a)).models)];
  for (const m of models) { const f = familyOf(m, h); if (f) out.add(f); }
  return [...out].sort();
}

/** The families of the agent turns of conversation `id`: who already processed it. */
export function processedFamilies(h: Household, agent: string, id: string): string[] {
  const out = new Set<string>();
  for (const t of turnsOf(agentDir(h, agent), id)) {
    if (!AGENT_TURN_KINDS.includes(t.kind)) continue;
    const f = familyOf(t.model, h);
    if (f) out.add(f);
  }
  return [...out].sort();
}

// ─── Scorecards ─────────────────────────────────────────────────────────────

export interface ScorecardRow {
  day: string;
  model: string;
  family: string;
  /** `unknown` when the turn named none. */
  harness: string;
  kind: string;
  measure: string;
  value: number;
  n: number;
  same_family: boolean;
}

export const METADATA_MEASURES = ['first_reply_s', 'abandoned', 'due_to_progress_s', 'done_rate', 'round_trips', 'loops_refused'] as const;
/** A sample is graded by at most two families (Review, step 1). */
export const MAX_SCORES_PER_REF = 2;

/** Scores and findings are on the agent's own turns, ones that name a model; anything else is a 409. */
function ownTurn(t: Turn): void {
  if (!AGENT_TURN_KINDS.includes(t.kind) || !t.model) fail('that turn isn\'t one of the agent\'s own turns with a model: scores and findings are on the agent\'s own turns', 409);
}

/** What a sample's ref stands for, with the turn and its venue's kind; refused unless this run took it. */
function sampleOf(h: Household, run: string, ref: unknown): { agent: string; conversation: string; seq: number; turn: Turn; kind: string } {
  const k = refOf(h.home, run, ref);
  if (!k) return fail('no such ref in this run\'s takes', 404);
  if (!h.agents.includes(k.agent)) return fail('that ref\'s agent is no longer in the household', 410);
  const turn = turnRecord(agentDir(h, k.agent), k.conversation, k.seq);
  if (!turn) return fail('that ref\'s turn is no longer held', 410);
  const kind = venueOf(h.home, turn.venue)?.kind;
  if (!kind) return fail(`that ref's venue ${turn.venue} is unknown`, 409);
  return { ...k, turn, kind };
}

/**
 * POST /api/loom/scores {ref, grader_family, score 1-5}, as a review run. Core maps the ref to
 * the producer's model, family and harness and folds the score into that day's `graded` row.
 * Refused: a turn with no model (not the agent's); a family no household agent's model
 * resolves to; the producer's own family while the household has another; a second score
 * from the same family, or a third for the ref; and, for a conversation with someone other
 * than the owner, a family that didn't already process it (its rows say same_family: true).
 */
export function postScore(h: Household, run: string, raw: unknown, now: Date = new Date()): { ok: true } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('a score is {ref, grader_family, score}');
  const b = raw as Record<string, unknown>;
  const bad = Object.keys(b).find((k) => !['ref', 'grader_family', 'score'].includes(k));
  if (bad !== undefined) fail(`a score has no key ${JSON.stringify(bad)} (it has ref, grader_family, score)`);
  if (typeof b.grader_family !== 'string' || !FAMILY_NAME.test(b.grader_family) || b.grader_family === UNKNOWN) fail('grader_family is a family name (anthropic, openai, …)');
  if (typeof b.score !== 'number' || !Number.isInteger(b.score) || b.score < 1 || b.score > 5) fail('score is a whole number from 1 to 5');
  const grader = b.grader_family as string;
  const score = b.score as number;
  const s = sampleOf(h, run, b.ref);
  ownTurn(s.turn);
  const family = familyOf(s.turn.model, h) ?? UNKNOWN;
  // Only a family the household actually runs grades: a made-up name can't add a score.
  const families = householdFamilies(h);
  if (!families.includes(grader)) fail(`no household agent runs a ${grader} model: only ${families.join(', ') || 'none'} may grade`, 403);
  let sameFamily: boolean;
  if (withNonOwner(h, s.agent, s.conversation)) {
    // A person's words go only where they already went (Review, step 2).
    if (!processedFamilies(h, s.agent, s.conversation).includes(grader)) {
      fail('this conversation is with someone other than the owner: only a family that already processed it may grade it', 403);
    }
    sameFamily = true;
  } else {
    // Never the producer's own family, unless the household has no other (step 1's fallback).
    if (grader === family && families.some((f) => f !== family)) fail(`${grader} produced this turn; another of the household's families grades it`, 403);
    sameFamily = grader === family;
  }
  const day = s.turn.at.slice(0, 10);
  withHouseholdDb(h.home, (db) => db.transaction(() => {
      if (db.prepare('SELECT 1 FROM review_scores WHERE ref = ? AND grader_family = ?').get(b.ref, grader)) fail(`${grader} already scored that ref`, 409);
      const scored = (db.prepare('SELECT COUNT(*) AS n FROM review_scores WHERE ref = ?').get(b.ref) as { n: number }).n;
      if (scored >= MAX_SCORES_PER_REF) fail(`that ref already has its ${MAX_SCORES_PER_REF} scores`, 409);
      db.prepare('INSERT INTO review_scores (ref, grader_family, score, at) VALUES (?, ?, ?, ?)').run(b.ref, grader, score, now.toISOString());
      db.prepare(`INSERT INTO scorecards (day, model, family, harness, kind, measure, same_family, value, n, total) VALUES (?, ?, ?, ?, ?, 'graded', ?, ?, 1, ?)
                  ON CONFLICT(day, model, family, harness, kind, measure, same_family) DO UPDATE SET
                    n = n + 1, total = total + excluded.total, value = (total + excluded.total) / (n + 1)`).run(
        day, s.turn.model, family, s.turn.harness ?? UNKNOWN, s.kind, sameFamily ? 1 : 0, score, score);
  }).immediate());
  return { ok: true };
}

/**
 * POST /api/loom/findings {ref, text ≤ 200}, as a review run, on the agent's own turn with a
 * model (as a score; a 409 otherwise): kept in the turn's agent's
 * `findings`, with the measure (`graded`) and the mean score posted for that ref, if any. At
 * most one per conversation per UTC day (the turn's day); a later one is a 409.
 */
export function postFinding(h: Household, run: string, raw: unknown, now: Date = new Date()): Finding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('a finding is {ref, text}');
  const b = raw as Record<string, unknown>;
  const bad = Object.keys(b).find((k) => !['ref', 'text'].includes(k));
  if (bad !== undefined) fail(`a finding has no key ${JSON.stringify(bad)} (it has ref, text)`);
  const s = sampleOf(h, run, b.ref);
  ownTurn(s.turn);
  const score = withHouseholdDb(h.home, (db) => (db.prepare('SELECT AVG(score) AS s FROM review_scores WHERE ref = ?').get(b.ref) as { s: number | null }).s);
  try {
    return writeFinding(agentDir(h, s.agent), { conversation: s.conversation, seq: s.seq, measure: 'graded', score, text: b.text as string }, now);
  } catch (e) {
    if (e instanceof ConversationError) throw new AuditError(e.message, e.status);
    throw e;
  }
}

/** GET /api/loom/scorecards: rows from `since` (a UTC day, default 30 days back), oldest first, at most 10000. */
export function scorecards(home: string, since?: string, now: Date = new Date()): ScorecardRow[] {
  const from = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10);
  return withHouseholdDb(home, (db) => (db.prepare('SELECT * FROM scorecards WHERE day >= ? ORDER BY day, kind, model, measure, same_family LIMIT 10000').all(from) as Array<Record<string, unknown>>).map((r) => ({
    day: r.day as string, model: r.model as string, family: r.family as string, harness: (r.harness as string) || UNKNOWN,
    kind: r.kind as string, measure: r.measure as string, value: r.value as number, n: r.n as number, same_family: r.same_family === 1,
  })));
}

// ─── Measures from metadata ─────────────────────────────────────────────────


type Agg = 'median' | 'mean' | 'count';

/**
 * The metadata measures for UTC day `day` (YYYY-MM-DD), household-wide, replacing that day's
 * metadata rows (graded rows stay). Per venue kind, as the spec's table has it:
 *  - live: `first_reply_s` (median latency of the day's replies, in seconds) and `abandoned`
 *    (share of the day's conversations with a message that had no reply within 24h);
 *  - scheduled: `due_to_progress_s` (median over the runs that began that day, per
 *    dueToProgressSeconds) and `done_rate` (share of those runs whose last agent turn
 *    answered or progressed);
 *  - agent: `round_trips` (median turns from the day's first message to the first answered
 *    reply) and `loops_refused` (count of the day's refused turns).
 * Each sample is the model and harness of the agent turn it measures: the reply, the run's
 * first turn, or (for abandoned and refused) the conversation's latest agent turn before it;
 * `unknown` when there's none. The review run calls this; the hourly sweep does too, for the
 * last three days, so a day's `abandoned` settles once its 24 hours have passed.
 */
export function computeMeasures(h: Household, day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day is YYYY-MM-DD');
  const from = `${day}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + DAY_MS).toISOString();
  const groups = new Map<string, { model: string; harness: string; kind: string; measure: string; agg: Agg; xs: number[] }>();
  const add = (kind: string, measure: string, agg: Agg, t: Pick<Turn, 'model' | 'harness'> | undefined, x: number) => {
    const model = t?.model ?? UNKNOWN;
    const harness = t?.harness ?? UNKNOWN;
    const key = [model, harness, kind, measure].join('\0');
    const g = groups.get(key) ?? { model, harness, kind, measure, agg, xs: [] };
    g.xs.push(x);
    groups.set(key, g);
  };
  const inDay = (t: Turn) => t.at >= from && t.at < to;
  // The venue registry, read once for the pass.
  const kinds = new Map<string, string>(Object.values(CORE_VENUE_ROWS).map((v) => [v.name, v.kind]));
  for (const v of listVenues(h.home)) kinds.set(v.name, v.kind);
  const own = (t: Turn) => AGENT_TURN_KINDS.includes(t.kind);
  for (const agent of h.agents) {
    const dir = agentDir(h, agent);
    for (const c of conversationsActive(dir, from, to)) {
      const kind = kinds.get(c.venue);
      if (!kind) continue;
      const turns = turnsOf(dir, c.id);
      const latestOwnBefore = (seq: number) => turns.filter((t) => own(t) && t.seq < seq).pop();
      if (kind === 'live') {
        for (const t of turns) if (inDay(t) && t.kind === 'reply' && t.latency_ms !== undefined) add(kind, 'first_reply_s', 'median', t, t.latency_ms / 1000);
        const msgs = turns.filter((t) => inDay(t) && t.kind === 'message');
        if (msgs.length) {
          const abandoned = msgs.some((m) => !turns.some((r) => r.kind === 'reply' && r.seq > m.seq && Date.parse(r.at) - Date.parse(m.at) <= DAY_MS));
          const firstReply = turns.find((r) => r.kind === 'reply' && r.seq > msgs[0].seq);
          add(kind, 'abandoned', 'mean', firstReply ?? latestOwnBefore(msgs[0].seq), abandoned ? 1 : 0);
        }
      } else if (kind === 'scheduled') {
        const runs = new Map<string, Turn[]>();
        for (const t of turns) if (own(t) && t.run) runs.set(t.run, [...(runs.get(t.run) ?? []), t]);
        const wakes = turns.filter((t) => t.kind === 'wake');
        for (const rs of runs.values()) {
          if (!inDay(rs[0])) continue;
          const span = dueToProgressSeconds([...wakes, ...rs]);
          if (span !== null) add(kind, 'due_to_progress_s', 'median', rs[0], span);
          const last = rs[rs.length - 1];
          add(kind, 'done_rate', 'mean', rs[0], last.outcome === 'answered' || last.outcome === 'progressed' ? 1 : 0);
        }
      } else if (kind === 'agent') {
        const first = turns.find((t) => inDay(t) && t.kind === 'message');
        if (first) {
          const answered = turns.find((t) => t.kind === 'reply' && t.outcome === 'answered' && t.seq > first.seq);
          if (answered) add(kind, 'round_trips', 'median', answered, answered.seq - first.seq);
        }
        for (const t of turns) if (inDay(t) && t.kind === 'refused') add(kind, 'loops_refused', 'count', latestOwnBefore(t.seq), 1);
      }
    }
  }
  // Nothing measured and no household store yet: no file is made for it.
  if (!groups.size && !existsSync(join(h.home, HOUSEHOLD_DB))) return 0;
  return withHouseholdDb(h.home, (db) => db.transaction(() => {
    db.prepare(`DELETE FROM scorecards WHERE day = ? AND measure IN (${METADATA_MEASURES.map(() => '?').join(', ')})`).run(day, ...METADATA_MEASURES);
    const ins = db.prepare('INSERT INTO scorecards (day, model, family, harness, kind, measure, same_family, value, n, total) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)');
    for (const g of groups.values()) {
      const total = g.xs.reduce((a, b) => a + b, 0);
      const value = g.agg === 'median' ? median(g.xs)! : g.agg === 'mean' ? total / g.xs.length : total;
      ins.run(day, g.model, g.model === UNKNOWN ? UNKNOWN : familyOf(g.model, h) ?? UNKNOWN, g.harness, g.kind, g.measure, value, g.xs.length, total);
    }
    return groups.size;
  }).immediate());
}

/** The days the sweep recomputes: `now`'s UTC day and the three before it. */
export function recentDays(now: Date = new Date()): string[] {
  return [0, 1, 2, 3].map((d) => new Date(now.getTime() - d * DAY_MS).toISOString().slice(0, 10));
}
