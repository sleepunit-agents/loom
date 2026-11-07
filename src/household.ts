/**
 * The household (docs/specs/household.md): one loom, many agents.
 *
 *   $LOOM_HOME/household.json   agents, the default agent, the owner
 *   $LOOM_HOME/tokens.json      every token by its sha256: label, role, use
 *   $LOOM_HOME/agents/<name>/   an agent's context dir, exactly as before
 *
 * A context dir with no household around it is a household of one and
 * behaves exactly as it always has: nothing here is consulted for it.
 *
 * Tokens carry a role: `agent:<name>` (MCP and the CLI as that agent),
 * `owner` (everything, and the page), or `peer:<name>` (knowledge only).
 * The daemon resolves the role on every request; no tool takes an agent
 * argument, so a body can only ever be the agent its token names.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { basename, dirname, join, resolve } from 'node:path';

export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const HOUSEHOLD_FILE = 'household.json';
const TOKENS_FILE = 'tokens.json';
/**
 * When each token was last used, by sha256. Its own file so the daemon never
 * rewrites tokens.json: a read-modify-write there could race a `loom token
 * revoke` and quietly undo it.
 */
const USED_FILE = 'tokens.used.json';

export interface Household {
  /** $LOOM_HOME: where household.json lives. */
  home: string;
  agents: string[];
  /** The agent the owner's token acts as when it names none. */
  default: string;
  owner?: string;
  /**
   * The household's people with a role (docs/specs/owners.md): each a People
   * slug, the role, and the agents they own (`*`: a household owner). Read
   * from `members`, else the legacy `owner` as the one household owner.
   */
  members: Member[];
  /**
   * Model name → family (its provider: anthropic, openai, …), household.json's `families`
   * (docs/specs/conversations.md, "Review"): a key is a model name, or a prefix ending in `*`.
   * It adds to and overrides the built-in prefixes in src/review.ts (`familyOf`).
   */
  families?: Record<string, string>;
  /** household.json's `tz` (an IANA name): the review's 04:00 is in it. loadHousehold defaults it to UTC. */
  tz?: string;
  /**
   * household.json's `review` (docs/specs/conversations.md, "Review"): `on` (the default), `off`,
   * or a command (1-16 strings of at most 200) that replaces the runtime's job.
   */
  review?: ReviewSetting;
  /**
   * household.json's `comms_days` (docs/specs/comms.md, "History"): how long a Comms thread keeps its words, 1-14
   * whole days (the continuity slot's window); loadHousehold defaults it to 14.
   */
  commsDays?: number;
  /**
   * household.json's `github`: the GitHub owner (a user or an organization) the household's repos are under, so a bare
   * `repo#12` in what an agent says links to github.com/<github>/repo/issues/12. Absent: only `owner/repo#12` links.
   */
  github?: string;
}

export type ReviewSetting = 'on' | 'off' | string[];

export interface Member {
  person: string;
  role: 'owner';
  agents: '*' | string[];
}

const PERSON_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The household owner a credential belongs to when it names no member: the first with every agent. */
export function firstOwner(h: Household): Member {
  return h.members.find((m) => m.agents === '*')!;
}

export function memberOf(h: Household, person: string | undefined): Member | undefined {
  return person === undefined ? undefined : h.members.find((m) => m.person === person);
}

function parseMembers(raw: Record<string, unknown>, agents: string[], path: string): Member[] {
  if (raw.members === undefined) {
    const o = typeof raw.owner === 'string' ? raw.owner.toLowerCase() : '';
    return [{ person: PERSON_SLUG.test(o) ? o : 'owner', role: 'owner', agents: '*' }];
  }
  const bad = (why: string) => new HouseholdError(`${path}: members: ${why}`);
  if (!Array.isArray(raw.members) || raw.members.length === 0) throw bad('a non-empty list');
  const seen = new Set<string>();
  const out = raw.members.map((m: unknown) => {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.person !== 'string' || !PERSON_SLUG.test(r.person)) throw bad('each names a person by their People slug');
    if (seen.has(r.person)) throw bad(`${r.person} is listed twice`);
    seen.add(r.person);
    if (r.role !== 'owner') throw bad(`${r.person}'s role is owner (the only role yet)`);
    const a = r.agents;
    if (a !== '*' && !(Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && agents.includes(x)))) {
      throw bad(`${r.person}'s agents is "*" or a list of this household's agents`);
    }
    return { person: r.person, role: 'owner' as const, agents: a === '*' ? '*' as const : [...new Set(a as string[])] };
  });
  // There's always a household owner: someone owns the shared things.
  if (!out.some((m) => m.agents === '*')) throw bad('at least one member owns every agent ("agents": "*")');
  return out;
}

export type Role =
  /**
   * `service` is a service house's (loom-box mints its token with it): the
   * agent's bridge, say, so a piece can tell it from the agent's other
   * bodies (t-1591). It grants nothing more than the agent has.
   */
  | { kind: 'agent'; agent: string; service?: string; house?: string }
  /** `member`: the household member the token is (docs/specs/owners.md); the first household owner if it names none. */
  | { kind: 'owner'; member?: string }
  | { kind: 'peer'; name: string }
  /**
   * A piece's credential (docs/extensions.md, "The API"): reaches only
   * POST /api/<piece>/…, as `subject`. No MCP, no /cli, no page, no store.
   */
  | { kind: 'piece'; piece: string; subject: string }
  /**
   * The runtime piece's credential (docs/specs/conversations.md, "Who writes what"):
   * `runtime:<piece>`, minted only for the one managed piece whose loom block says
   * `"role": "runtime"`, and live only while it still is. It reaches only the routes
   * ROLE_ROUTES names for it (src/transport/role-routes.ts).
   */
  | { kind: 'runtime'; piece: string }
  /**
   * A review run's credential (docs/specs/conversations.md, "Review tokens"):
   * `review:<piece>`, minted by that runtime piece through POST /api/loom/review/token,
   * always with `expires`. It reaches only the routes ROLE_ROUTES names for it.
   */
  | { kind: 'review'; piece: string };

/** How long a review token lives (docs/specs/conversations.md, "Review tokens"). */
export const REVIEW_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/** Live review tokens one runtime may hold at once: a runaway runtime can't grow tokens.json without bound. */
export const REVIEW_TOKENS_LIVE_MAX = 8;

export interface TokenRecord {
  label: string;
  /** `agent:<name>[/<service>][@<house>]`, `owner`, `peer:<name>`, `piece:<piece>/<subject>`, `runtime:<piece>` or `review:<piece>`. */
  role: string;
  /** sha256 of the token, hex. The token itself is never stored. */
  sha256: string;
  /** An owner token's member (a People slug), when it names one. */
  member?: string;
  created: string;
  /** ISO-8601. Past it the token is refused everywhere, and the next token write drops the record. */
  expires?: string;
  last_used?: string;
  revoked?: string;
}

export class HouseholdError extends Error {}
/** A runtime asked for more live review tokens than it may hold (REVIEW_TOKENS_LIVE_MAX). */
export class TokenLimitError extends HouseholdError {}

/** $LOOM_HOME, else ~/.config/loom. */
export function householdHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.LOOM_HOME || join(homedir(), '.config', 'loom'));
}

export function agentDir(h: Household, agent: string): string {
  return join(h.home, 'agents', agent);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** The household at `home`, or null when there's none. Throws on a malformed file. */
export function loadHousehold(home: string): Household | null {
  const path = join(home, HOUSEHOLD_FILE);
  if (!existsSync(path)) return null;
  const raw = readJson(path) as Record<string, unknown>;
  if (raw?.v !== 1) throw new HouseholdError(`${path}: v must be 1`);
  const agents = raw.agents;
  if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => typeof a === 'string' && AGENT_NAME.test(a))) {
    throw new HouseholdError(`${path}: agents must be a non-empty list of agent names (lowercase letters, digits, dashes)`);
  }
  const def = typeof raw.default === 'string' ? raw.default : agents[0];
  if (!agents.includes(def)) throw new HouseholdError(`${path}: default ${JSON.stringify(def)} is not one of the agents`);
  return {
    home: resolve(home),
    agents: agents as string[],
    default: def,
    owner: typeof raw.owner === 'string' ? raw.owner : undefined,
    members: parseMembers(raw, agents as string[], path),
    ...(raw.families !== undefined ? { families: parseFamilies(raw.families, path) } : {}),
    tz: parseTz(raw.tz, path),
    review: parseReview(raw.review, path),
    commsDays: parseCommsDays(raw.comms_days, path),
    ...(raw.github !== undefined ? { github: parseGithub(raw.github, path) } : {}),
  };
}

/** A GitHub user or organization name: letters, digits and single dashes, at most 39. */
function parseGithub(v: unknown, path: string): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/.test(v)) throw new HouseholdError(`${path}: github is a GitHub user or organization name (letters, digits, dashes)`);
  return v;
}

function parseTz(v: unknown, path: string): string {
  if (v === undefined) return 'UTC';
  const bad = new HouseholdError(`${path}: tz is an IANA time zone name (e.g. America/Chicago)`);
  if (typeof v !== 'string' || !v.length || v.length > 64) throw bad;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { throw bad; }
  return v;
}

function parseCommsDays(v: unknown, path: string): number {
  if (v === undefined) return 14;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 14) throw new HouseholdError(`${path}: comms_days is a whole number of days from 1 to 14 (how long a Comms thread keeps its words)`);
  return v;
}

function parseReview(v: unknown, path: string): ReviewSetting {
  if (v === undefined || v === 'on') return 'on';
  if (v === 'off') return 'off';
  if (Array.isArray(v) && v.length >= 1 && v.length <= 16 && v.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 200 && !/[\x00-\x1f\x7f]/.test(x))) return [...v] as string[];
  throw new HouseholdError(`${path}: review is "on", "off", or a command: 1-16 strings of at most 200 printable characters`);
}

/** A model family's name: lowercase letters, digits and dashes, at most 32. */
export const FAMILY_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function parseFamilies(v: unknown, path: string): Record<string, string> {
  const bad = () => new HouseholdError(`${path}: families maps up to 64 model names (or prefixes ending in *) of at most 120 printable characters to family names (lowercase letters, digits, dashes)`);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 64) throw bad();
  // A null-prototype map: a model named "__proto__" or "constructor" is a key like any other.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, f] of entries) {
    if (!k.length || k.length > 120 || !/^[^\x00-\x1f\x7f]+$/.test(k) || typeof f !== 'string' || !FAMILY_NAME.test(f) || f === 'unknown') throw bad();
    out[k.toLowerCase()] = f;
  }
  return out;
}

/**
 * The household a context dir belongs to: one whose `agents/<name>` is this
 * dir (after resolving symlinks, so an old `~/.config/loom/art` link still
 * finds it). Null for a plain context dir.
 */
export function householdOf(contextDir: string): { household: Household; agent: string } | null {
  let real: string;
  try { real = realpathSync(contextDir); } catch { return null; }
  const agentsDir = dirname(real);
  if (basename(agentsDir) !== 'agents') return null;
  const h = loadHousehold(dirname(agentsDir));
  const agent = basename(real);
  if (!h || !h.agents.includes(agent)) return null;
  return { household: h, agent };
}

export function parseRole(s: string): Role | null {
  if (s === 'owner') return { kind: 'owner' };
  const p = /^piece:([a-z][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(s);
  if (p) return p[1] === 'loom' ? null : { kind: 'piece', piece: p[1], subject: p[2] };
  const rr = /^(runtime|review):([a-z][a-z0-9-]{0,39})$/.exec(s);
  if (rr) return rr[2] === 'loom' ? null : { kind: rr[1] as 'runtime' | 'review', piece: rr[2] };
  // A house's token: the agent, the service if it's a service house, and the house (loom-box
  // mints it), so a piece can grant one house something and none of the agent's others.
  const a = /^agent:([a-z][a-z0-9-]{0,39})(?:\/([a-z][a-z0-9-]{0,39}))?(?:@(h-[0-9]{1,9}))?$/.exec(s);
  if (a && (a[2] || a[3])) return { kind: 'agent', agent: a[1], ...(a[2] ? { service: a[2] } : {}), ...(a[3] ? { house: a[3] } : {}) };
  const m = /^(agent|peer):([a-z][a-z0-9-]{0,39})$/.exec(s);
  if (!m) return null;
  return m[1] === 'agent' ? { kind: 'agent', agent: m[2] } : { kind: 'peer', name: m[2] };
}

export function roleString(r: Role): string {
  switch (r.kind) {
    case 'owner': return 'owner';
    case 'agent': return `agent:${r.agent}${r.service ? `/${r.service}` : ''}${r.house ? `@${r.house}` : ''}`;
    case 'peer': return `peer:${r.name}`;
    case 'piece': return `piece:${r.piece}/${r.subject}`;
    case 'runtime': return `runtime:${r.piece}`;
    case 'review': return `review:${r.piece}`;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function writePrivate(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function loadUsed(home: string): Record<string, string> {
  try {
    const raw = readJson(join(home, USED_FILE)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch { return {}; }
}

/** Every token record, with when it was last used merged in. */
const LOCK_FILE = '.household.lock';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Serialize every read-modify-write of household.json and tokens.json, so
 * two `loom token` runs can't interleave and drop each other's change (a
 * create racing a revoke must not bring the revoked token back). The lock
 * holds its owner's pid.
 *
 * A lock whose pid is dead is cleared, never just for being old. It used to be
 * reported and left, when only the owner's occasional commands took it; now
 * loom-box mints a token for every house it starts, and on 2026-10-30 a
 * `loom token create` killed by its caller's timeout left one that failed every
 * house start until someone removed it by hand. Clearing it would race another
 * waiter clearing it too, and the second could remove the first's fresh lock.
 * So it's done under a breaker (`.household.lock.break`, taken the same way):
 * one at a time, each re-reading the lock and removing it only while it still
 * names the dead pid. A breaker that died holding its own lock (a second death
 * inside a few milliseconds) is reported, with what to do.
 */
/** Remove `lock` if it still names the dead `holder`, under the breaker. False when someone else is clearing it. */
function clearDead(lock: string, holder: number, mine: string): boolean {
  const breaker = `${lock}.break`;
  try {
    writeFileSync(breaker, mine, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let b = NaN;
    try { b = Number.parseInt(readFileSync(breaker, 'utf-8'), 10); } catch { return false; /* just released */ }
    if (Number.isSafeInteger(b) && b > 0 && !alive(b)) {
      throw new HouseholdError(`${lock} was left by pid ${holder}, which isn't running, and ${breaker} by pid ${b}, which isn't either; if no loom command is running, remove both files and try again`);
    }
    return false;   // being cleared by a live process: wait for it
  }
  try {
    let now = NaN;
    try { now = Number.parseInt(readFileSync(lock, 'utf-8'), 10); } catch { /* already gone */ }
    if (now === holder) rmSync(lock, { force: true });
    return true;
  } finally {
    try { if (readFileSync(breaker, 'utf-8') === mine) rmSync(breaker, { force: true }); } catch { /* already gone */ }
  }
}

function withLock<T>(home: string, f: () => T): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  const mine = String(process.pid);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = NaN;
      try { holder = Number.parseInt(readFileSync(lock, 'utf-8'), 10); } catch { continue; /* just released */ }
      if (Number.isSafeInteger(holder) && holder > 0 && !alive(holder)) {
        if (clearDead(lock, holder, mine)) continue;
      }
      if (Date.now() > deadline) throw new HouseholdError(`${lock} is held by another loom process (pid ${Number.isNaN(holder) ? '?' : holder}); try again`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return f(); } finally {
    try { if (readFileSync(lock, 'utf-8') === mine) rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

const SHA_HEX = /^[0-9a-f]{64}$/;

function validRecord(t: unknown): t is TokenRecord {
  if (typeof t !== 'object' || t === null) return false;
  const r = t as Record<string, unknown>;
  return typeof r.label === 'string' && typeof r.role === 'string' && typeof r.sha256 === 'string' && SHA_HEX.test(r.sha256)
    && typeof r.created === 'string' && (r.revoked === undefined || typeof r.revoked === 'string')
    && (r.expires === undefined || (typeof r.expires === 'string' && Number.isFinite(Date.parse(r.expires))))
    && (r.member === undefined || (typeof r.member === 'string' && PERSON_SLUG.test(r.member)));
}

/**
 * The token file has to be private: owned by this user, not writable by
 * group or world, in a directory that isn't either. Anyone who can write it
 * can mint themselves an owner token.
 */
function assertPrivate(path: string): void {
  if (typeof process.getuid !== 'function') return;
  const uid = process.getuid();
  for (const p of [path, dirname(path)]) {
    const st = statSync(p);
    if (st.uid !== uid) throw new HouseholdError(`${p} is owned by another user; refusing to trust it`);
    if (st.mode & 0o022) throw new HouseholdError(`${p} is writable by group or others; run chmod go-w on it`);
  }
}

export function loadTokens(home: string): TokenRecord[] {
  const path = join(home, TOKENS_FILE);
  if (!existsSync(path)) return [];
  assertPrivate(path);
  const raw = readJson(path) as { v?: number; tokens?: unknown };
  if (raw?.v !== 1 || !Array.isArray(raw.tokens)) throw new HouseholdError(`${path}: expected {"v": 1, "tokens": [...]}`);
  if (!raw.tokens.every(validRecord)) throw new HouseholdError(`${path}: a token record is malformed (label, role, a 64-hex sha256 and created are required)`);
  const used = loadUsed(home);
  return (raw.tokens as TokenRecord[]).map((t) => {
    const { last_used: _ignored, ...rest } = t;
    return used[t.sha256] ? { ...rest, last_used: used[t.sha256] } : rest;
  });
}

function saveTokens(home: string, tokens: TokenRecord[]): void {
  const records = tokens.map(({ last_used: _l, ...t }) => t);
  writePrivate(join(home, TOKENS_FILE), JSON.stringify({ v: 1, tokens: records }, null, 2) + '\n');
}

/** Past its `expires`, if it has one. */
export function expired(t: Pick<TokenRecord, 'expires'>, now: number = Date.now()): boolean {
  return t.expires !== undefined && !(Date.parse(t.expires) > now);
}

/** Neither revoked nor expired. */
export function isLive(t: Pick<TokenRecord, 'revoked' | 'expires'>, now: number = Date.now()): boolean {
  return !t.revoked && !expired(t, now);
}

/**
 * Why `piece` can't be the runtime, or null when it can: it must be the one managed piece
 * whose loom block says `"role": "runtime"` (`runtimePieces`, from runtimePieces() in
 * cli/pieces-managed.ts).
 */
export function runtimeProblem(piece: string, runtimePieces: readonly string[]): string | null {
  if (!runtimePieces.includes(piece)) return `${piece} isn't a managed piece whose loom block says "role": "runtime"`;
  if (runtimePieces.length > 1) return `more than one managed piece says "role": "runtime" (${runtimePieces.join(', ')}); a household has one runtime`;
  return null;
}

/** A role must name an agent this household has. */
function checkRole(h: Household, role: Role, runtimePieces?: readonly string[]): void {
  if (role.kind === 'review') throw new HouseholdError('a review token is minted only by the runtime, through POST /api/loom/review/token');
  if (role.kind === 'runtime') {
    // Fail closed: a caller that didn't say which pieces are the runtime mints none.
    const problem = runtimeProblem(role.piece, runtimePieces ?? []);
    if (problem) throw new HouseholdError(`can't mint a runtime token: ${problem}`);
  }
  if (role.kind === 'agent' && !h.agents.includes(role.agent)) {
    throw new HouseholdError(`no agent named ${role.agent} in this household (${h.agents.join(', ')})`);
  }
  if (role.kind === 'owner' && role.member !== undefined && !memberOf(h, role.member)) {
    throw new HouseholdError(`no member named ${role.member} in this household (${h.members.map((m) => m.person).join(', ')})`);
  }
}

/** Mint a token. Returns it once; only its sha256 is kept. */
/**
 * `runtimePieces`: the managed pieces that say `"role": "runtime"` (runtimePieces() in
 * cli/pieces-managed.ts); a runtime token needs it. A review token isn't minted here:
 * mintReviewToken.
 */
export function createToken(h: Household, input: { role: Role; label: string; runtimePieces?: readonly string[] }, now = new Date()): { token: string; record: TokenRecord } {
  checkRole(h, input.role, input.runtimePieces);
  const label = input.label.trim();
  if (!label || label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) throw new HouseholdError('a token needs a label (120 printable characters at most)');
  return withLock(h.home, () => {
    const tokens = unexpired(loadTokens(h.home), now.getTime());
    if (tokens.some((t) => t.label === label && !t.revoked)) throw new HouseholdError(`a live token is already labeled ${JSON.stringify(label)}`);
    const token = `loom_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      label, role: roleString(input.role), sha256: sha(token),
      ...(input.role.kind === 'owner' && input.role.member ? { member: input.role.member } : {}),
      created: now.toISOString(),
    };
    saveTokens(h.home, [...tokens, record]);
    return { token, record };
  });
}

/** The lazy sweep: every token write drops records past their `expires`. */
function unexpired(tokens: TokenRecord[], now: number): TokenRecord[] {
  return tokens.filter((t) => !expired(t, now));
}

/**
 * A review token for one run (docs/specs/conversations.md, "Review tokens"): role
 * `review:<piece>`, `expires` two hours out. Only POST /api/loom/review/token calls this,
 * for a caller that presented a live runtime token for `piece`.
 */
export function mintReviewToken(h: Household, piece: string, now = new Date()): { token: string; record: TokenRecord } {
  const role: Role = { kind: 'review', piece };
  return withLock(h.home, () => {
    const tokens = unexpired(loadTokens(h.home), now.getTime());
    const live = tokens.filter((t) => !t.revoked && t.role === roleString(role));
    if (live.length >= REVIEW_TOKENS_LIVE_MAX) {
      throw new TokenLimitError(`${piece} already holds ${live.length} live review tokens; one expires within two hours`);
    }
    const token = `loom_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      label: `review · ${piece} · ${now.toISOString()} · ${randomBytes(3).toString('hex')}`,
      role: roleString(role), sha256: sha(token),
      created: now.toISOString(),
      expires: new Date(now.getTime() + REVIEW_TOKEN_TTL_MS).toISOString(),
    };
    saveTokens(h.home, [...tokens, record]);
    return { token, record };
  });
}

export function revokeToken(h: Household, label: string, now = new Date()): TokenRecord {
  return withLock(h.home, () => {
    const tokens = unexpired(loadTokens(h.home), now.getTime());
    const t = tokens.find((x) => x.label === label && !x.revoked);
    if (!t) throw new HouseholdError(`no live token labeled ${JSON.stringify(label)}`);
    t.revoked = now.toISOString();
    saveTokens(h.home, tokens);
    return t;
  });
}

/**
 * Resolves presented tokens to roles. Reads tokens.json when it changes (so
 * a revoke takes effect on the next request), compares digests in constant
 * time, and records when a token was last used, at most once a minute.
 */
export class TokenResolver {
  private cache: { key: string; tokens: TokenRecord[] } | null = null;
  private lastTouch = new Map<string, number>();

  private readonly get: () => Household;
  private readonly runtimePieces?: () => readonly string[];

  /**
   * A household, or a function returning the current one (re-read as household.json changes).
   * `runtimePieces`: the managed pieces that say `"role": "runtime"`, read per request. Without
   * it, runtime and review tokens resolve to nothing.
   */
  constructor(h: Household | (() => Household), opts: { runtimePieces?: () => readonly string[] } = {}) {
    this.get = typeof h === 'function' ? h : () => h;
    this.runtimePieces = opts.runtimePieces;
  }

  private get h(): Household { return this.get(); }

  private current(): TokenRecord[] {
    const path = join(this.h.home, TOKENS_FILE);
    let key: string;
    // Every write is a rename, so the inode changes even where mtimes are coarse.
    try { const st = statSync(path); key = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`; } catch { return []; }
    if (!this.cache || this.cache.key !== key) this.cache = { key, tokens: loadTokens(this.h.home) };
    return this.cache.tokens;
  }

  /**
   * The role for a presented token, or null. Revoked and expired tokens, roles
   * naming a missing agent, and runtime or review tokens whose piece is no
   * longer the household's one runtime resolve to null. Throws HouseholdError
   * when tokens.json is unreadable or untrusted: the caller fails closed.
   */
  resolve(presented: string, now: number = Date.now()): Role | null {
    const d = Buffer.from(sha(presented), 'hex');
    const hit = this.current().find((t) => isLive(t, now) && t.sha256.length === 64 && timingSafeEqual(Buffer.from(t.sha256, 'hex'), d));
    if (!hit) return null;
    const role = parseRole(hit.role);
    if (!role || (role.kind === 'agent' && !this.h.agents.includes(role.agent))) return null;
    if (role.kind === 'runtime' || role.kind === 'review') {
      if (!this.runtimePieces || runtimeProblem(role.piece, this.runtimePieces()) !== null) return null;
      // A review token without an expiry wasn't minted by core: refuse it.
      if (role.kind === 'review' && hit.expires === undefined) return null;
    }
    if (role.kind === 'owner') {
      // An owner token is a member's: named on it, else the first household owner. One whose
      // member has left the household reaches nothing.
      const m = hit.member === undefined ? firstOwner(this.h) : memberOf(this.h, hit.member);
      if (!m) return null;
      this.touch(hit.sha256);
      return { kind: 'owner', member: m.person };
    }
    this.touch(hit.sha256);
    return role;
  }

  /** Whether a live owner token has this sha256 (the page's sessions check this, so revoking ends them). */
  ownerDigestLive(digestHex: string): boolean {
    return this.ownerMember(digestHex) !== undefined;
  }

  /** The member a live owner token with this sha256 belongs to, if it's live and they're still a member. */
  ownerMember(digestHex: string): Member | undefined {
    const t = this.current().find((x) => isLive(x) && x.role === 'owner' && x.sha256 === digestHex);
    if (!t) return undefined;
    return t.member === undefined ? firstOwner(this.h) : memberOf(this.h, t.member);
  }

  private touch(digest: string): void {
    const now = Date.now();
    if (now - (this.lastTouch.get(digest) ?? 0) < 60_000) return;
    this.lastTouch.set(digest, now);
    // Only tokens.used.json, never tokens.json: see USED_FILE.
    try {
      const used = loadUsed(this.h.home);
      used[digest] = new Date(now).toISOString();
      writePrivate(join(this.h.home, USED_FILE), JSON.stringify(used) + '\n');
    } catch { /* last-used is a nicety; never fail a request over it */ }
  }
}

/**
 * Turn a plain context dir into the first agent of a new household: move
 * `<home>/<name>` to `<home>/agents/<name>`, leave a symlink at the old path
 * so anything that still names it keeps working, and write household.json.
 */
export function initHousehold(home: string, agent: string, opts: { owner?: string } = {}): Household {
  if (!AGENT_NAME.test(agent)) throw new HouseholdError(`${agent} isn't an agent name (lowercase letters, digits, dashes)`);
  home = resolve(home);
  if (existsSync(join(home, HOUSEHOLD_FILE))) throw new HouseholdError(`${home} already has a household.json`);
  const from = join(home, agent);
  const to = join(home, 'agents', agent);
  if (existsSync(to)) throw new HouseholdError(`${to} already exists`);
  if (existsSync(from) && lstatSync(from).isSymbolicLink()) {
    throw new HouseholdError(`${from} is a symlink; move the real directory to ${to} yourself, or point LOOM_HOME at where it lives`);
  }
  if (!existsSync(join(from, 'IDENTITY.md')) && !existsSync(join(from, 'memories.db'))) {
    throw new HouseholdError(`${from} doesn't look like a context dir (no IDENTITY.md or memories.db)`);
  }
  mkdirSync(join(home, 'agents'), { recursive: true, mode: 0o700 });
  renameSync(from, to);
  symlinkSync(join('agents', agent), from);
  const h: Household = { home, agents: [agent], default: agent, owner: opts.owner, members: parseMembers({ owner: opts.owner }, [agent], join(home, HOUSEHOLD_FILE)) };
  // The first agent's knowledge becomes the household's commons.
  if (existsSync(join(to, 'knowledge.db')) && !existsSync(join(home, 'commons', 'knowledge.db'))) {
    const kdb = new BetterSqlite3(join(to, 'knowledge.db'));
    try { kdb.pragma('wal_checkpoint(TRUNCATE)'); } finally { kdb.close(); }
    mkdirSync(join(home, 'commons'), { recursive: true, mode: 0o700 });
    for (const ext of SQLITE_SIDECARS) {
      if (existsSync(join(to, 'knowledge.db') + ext)) renameSync(join(to, 'knowledge.db') + ext, join(home, 'commons', 'knowledge.db') + ext);
    }
  }
  withLock(home, () => writePrivate(join(home, HOUSEHOLD_FILE), JSON.stringify({ v: 1, agents: h.agents, default: h.default, ...(h.owner ? { owner: h.owner } : {}) }, null, 2) + '\n'));
  return h;
}

/**
 * An agent's directory must be a real directory, not a symlink: `agents/mark
 * -> art` would make two agents share one stack.
 */
export function assertRealAgentDir(h: Household, agent: string): void {
  const dir = agentDir(h, agent);
  let st;
  try { st = lstatSync(dir); } catch { throw new HouseholdError(`${dir} doesn't exist; bootstrap the agent first`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HouseholdError(`${dir} must be a real directory, not a symlink or a file`);
}

/** Add an agent to a household (its directory must already exist under agents/). */
export function addAgent(h: Household, agent: string): Household {
  if (!AGENT_NAME.test(agent)) throw new HouseholdError(`${agent} isn't an agent name`);
  if (h.agents.includes(agent)) return h;
  assertRealAgentDir(h, agent);
  return withLock(h.home, () => {
    const current = loadHousehold(h.home) ?? h;
    if (current.agents.includes(agent)) return current;
    const next = { ...current, agents: [...current.agents, agent] };
    // Keys this function doesn't own (marks, relay, …) stay as they were.
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify({ ...rawHousehold(h.home), v: 1, agents: next.agents, default: next.default, ...(next.owner ? { owner: next.owner } : {}) }, null, 2) + '\n');
    return next;
  });
}

/**
 * Add a member or change what they own (docs/specs/owners.md). The whole list is checked as
 * loading checks it, so a change that would leave no household owner is refused.
 */
export function setMember(h: Household, person: string, agents: '*' | string[]): Household {
  return withLock(h.home, () => {
    const current = loadHousehold(h.home) ?? h;
    const others = current.members.filter((m) => m.person !== person);
    const next = [...current.members.map((m) => (m.person === person ? { ...m, agents } : m)), ...(others.length === current.members.length ? [{ person, role: 'owner' as const, agents }] : [])];
    if (!next.some((m) => m.agents === '*')) throw new HouseholdError(`${person} is the only one who owns every agent; someone has to own the household`);
    return writeMembers(current, next);
  });
}

/** Remove a member: their tokens stop working at once (a token's member must be one). The last household owner stays. */
export function removeMember(h: Household, person: string): Household {
  return withLock(h.home, () => {
    const current = loadHousehold(h.home) ?? h;
    const m = memberOf(current, person);
    if (!m) throw new HouseholdError(`${person} isn't a member`);
    if (m.agents === '*' && current.members.filter((x) => x.agents === '*').length === 1) {
      throw new HouseholdError(`${person} is the only one who owns every agent; someone has to own the household`);
    }
    return writeMembers(current, current.members.filter((x) => x.person !== person));
  });
}

function writeMembers(current: Household, members: Member[]): Household {
  const raw = rawHousehold(current.home);
  // The same checks loading does: a list that wouldn't load isn't written.
  const checked = parseMembers({ ...raw, members }, current.agents, join(current.home, HOUSEHOLD_FILE));
  // An owner token that names no member is the first household owner's. If this change makes
  // someone else first, those tokens stay with who they belonged to: their member is written on
  // them first, so they never pass to the next person (and stop with them, if they're removed).
  const was = firstOwner(current).person;
  if (checked.find((m) => m.agents === '*')!.person !== was) {
    const tokens = loadTokens(current.home);
    let pinned = false;
    for (const t of tokens) if (t.role === 'owner' && t.member === undefined && !t.revoked) { t.member = was; pinned = true; }
    if (pinned) saveTokens(current.home, tokens);
  }
  writePrivate(join(current.home, HOUSEHOLD_FILE), JSON.stringify({ ...raw, members: checked }, null, 2) + '\n');
  return { ...current, members: checked };
}

/** Agent marks: the palette an agent's mark takes its colors from, in order, unless household.json's `marks` says otherwise. */
export const MARKS: ReadonlyArray<{ bg: string; fg: string; name: string }> = [
  { bg: '#B8A6FF', fg: '#1D1240', name: 'Lilac' }, { bg: '#7A2E4F', fg: '#FFE3EE', name: 'Plum' }, { bg: '#2F6B5A', fg: '#E2F5EE', name: 'Pine' },
  { bg: '#E3B341', fg: '#2B1D00', name: 'Mustard' }, { bg: '#3D5A99', fg: '#E6ECFF', name: 'Denim' }, { bg: '#F09A7A', fg: '#3A140A', name: 'Coral' },
];


export function rawHousehold(home: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(home, HOUSEHOLD_FILE), 'utf-8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Set an agent's mark colors in household.json's `marks`. */
/** Which of MARKS an agent wears: household.json's choice, else the palette by its place in the household. */
export function markIndexOf(h: Household, agent: string): number {
  const m = rawHousehold(h.home).marks;
  const bg = m && typeof m === 'object' && !Array.isArray(m) ? ((m as Record<string, { bg?: unknown }>)[agent]?.bg) : undefined;
  const i = MARKS.findIndex((x) => x.bg === bg);
  return i >= 0 ? i : Math.max(0, h.agents.indexOf(agent)) % MARKS.length;
}

export function setMark(h: Household, agent: string, mark: { bg: string; fg: string }): void {
  if (!AGENT_NAME.test(agent)) throw new HouseholdError(`${agent} isn't an agent name`);
  withLock(h.home, () => {
    const raw = rawHousehold(h.home);
    const marks = raw.marks && typeof raw.marks === 'object' && !Array.isArray(raw.marks) ? raw.marks as Record<string, unknown> : {};
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify({ ...raw, marks: { ...marks, [agent]: { bg: mark.bg, fg: mark.fg } } }, null, 2) + '\n');
  });
}

/** An agent's face (web/src/face.tsx): the shape of its body and its eyes. Its expression is its state. */
export const FACE_SHAPES = ['pebble', 'trefoil', 'clover', 'drop'] as const;
export const FACE_EYES = ['dot', 'oval'] as const;
export type AgentFace = { shape: typeof FACE_SHAPES[number]; eyes: typeof FACE_EYES[number] };
/** household.json's `faces` for an agent, else one from its place in the household: so two agents differ out of the box. */
export function faceOf(h: Household, agent: string): AgentFace {
  const f = rawHousehold(h.home).faces;
  const mine = f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, { shape?: unknown; eyes?: unknown }>)[agent] : undefined;
  const at = Math.max(0, h.agents.indexOf(agent));
  const shape = FACE_SHAPES.find((x) => x === mine?.shape) ?? FACE_SHAPES[at % FACE_SHAPES.length];
  const eyes = FACE_EYES.find((x) => x === mine?.eyes) ?? FACE_EYES[at % FACE_EYES.length];
  return { shape, eyes };
}

/**
 * An agent's pixel face (Jonathan, 2026-11-04: the PixelLab sheets he made for Art): a manifest and its sheets, kept with
 * the household's other marks at <home>/faces/<agent>/ (manifest.json, and each sheet it names, a PNG). The manifest
 * says, per state and facing, its animations, each a row of a sheet with its frame count and a weight; at each beat the
 * page picks one by weight (weights are tuned in the file, no deploy). Facings are south, south-east and south-west;
 * waiting on you is south only. A state with nothing in a facing uses its south; south is the one every pixel face has.
 *   { "cell": [56, 84], "states": { "idle": { "south": [{ "row": 7, "frames": 17, "weight": 85 },
 *       { "sheet": "idle-rare.png", "row": 0, "frames": 12, "weight": 15, "rare": true }], "south-east": [...] }, "waiting": { "south": [...] } } }
 * A variant's sheet is "sheet.png" unless it names another; a rare one never plays twice running (after a rare beat the
 * next is never rare). "scale" (0.5-1.2) and "offset" ([x, y] in the sheet's pixels) tune where a face sits and how big
 * it reads beside the others (t-1849: Mark's fills more of his cell than Art's). "avatar" ({ x, y, w, h } in the cell's
 * pixels) is where a small avatar (under 36 px) is cut from the rest frame; without it, a 24-pixel square over the top of
 * what's drawn there. An agent without a manifest keeps its drawn face.
 */
export const SPRITE_FACINGS = ['south', 'south-east', 'south-west'] as const;
export const SPRITE_STATES = ['idle', 'working', 'thinking', 'waiting', 'done', 'error', 'talking'] as const;
export type SpriteFacing = typeof SPRITE_FACINGS[number];
export type SpriteVariant = { sheet?: string; row: number; frames: number; weight: number; rare?: boolean; /** the frame it rests on (default: 0; error's, 4 from its end) */ rest?: number };
export type SpriteManifest = { cell: [number, number]; states: Partial<Record<typeof SPRITE_STATES[number], Partial<Record<SpriteFacing, SpriteVariant[]>>>>;
  /** Drawn smaller or larger than the others (0.5 to 1.2; default 1: past 1.2 a 2x face overruns its card's room), so a sprite that fills more of its cell reads the same size. */
  scale?: number;
  /** Moved, in the sheet's own pixels (x right, y down; each -32 to 32), so it sits where the others do. */
  offset?: [number, number];
  /** A small avatar's crop of the rest frame (idle, south, frame 0), in the cell's pixels. */
  avatar?: { x: number; y: number; w: number; h: number } };
const SPRITE_MAX_BYTES = 4 * 1024 * 1024;
const SHEET_NAME = /^[a-z0-9][a-z0-9-]{0,40}\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const spriteDir = (h: Household, agent: string) => join(h.home, 'faces', agent);

/** A manifest as loom keeps it, checked: known states and facings only, waiting south only, every variant a row, its
 * frames and a weight, its sheet a plain file name; idle in south at the least. Throws HouseholdError, saying what's wrong. */
export function checkSpriteManifest(raw: unknown): SpriteManifest {
  const bad = (why: string): never => { throw new HouseholdError(`that sprite manifest ${why}`); };
  const m = raw as { cell?: unknown; states?: unknown };
  if (!m || typeof m !== 'object') bad('isn\'t a JSON object');
  const cell = m.cell;
  if (!Array.isArray(cell) || cell.length !== 2 || !cell.every((n) => Number.isInteger(n) && n > 0 && n <= 512)) bad('needs "cell": [width, height]');
  if (!m.states || typeof m.states !== 'object') bad('needs "states"');
  const { scale, offset, avatar } = m as { scale?: unknown; offset?: unknown; avatar?: unknown };
  if (scale !== undefined && !(typeof scale === 'number' && scale >= 0.5 && scale <= 1.2)) bad('has a "scale" that isn\'t a number from 0.5 to 1.2');
  if (offset !== undefined && !(Array.isArray(offset) && offset.length === 2 && offset.every((n) => Number.isInteger(n) && n >= -32 && n <= 32))) bad('has an "offset" that isn\'t [x, y], whole pixels from -32 to 32');
  const [cw, ch] = cell as [number, number];
  let crop: SpriteManifest['avatar'];
  if (avatar !== undefined) {
    const { x, y, w, h } = (avatar ?? {}) as Record<string, unknown>;
    const whole = [x, y, w, h].every((n) => Number.isInteger(n));
    const [ax, ay, aw, ah] = [x, y, w, h] as number[];
    if (!whole || ax < 0 || ay < 0 || aw < 8 || ah < 8 || ax + aw > cw || ay + ah > ch) bad('has an "avatar" that isn\'t { x, y, w, h }: whole pixels inside the cell, 8 or more across');
    crop = { x: ax, y: ay, w: aw, h: ah };
  }
  const out: SpriteManifest = { cell: cell as [number, number], states: {},
    ...(crop ? { avatar: crop } : {}),
    ...(scale !== undefined && scale !== 1 ? { scale: scale as number } : {}),
    ...(offset !== undefined && (offset as number[]).some((n) => n !== 0) ? { offset: offset as [number, number] } : {}) };
  for (const [st, byFacing] of Object.entries(m.states as Record<string, unknown>)) {
    if (!(SPRITE_STATES as readonly string[]).includes(st)) bad(`names a state loom doesn't have (${st})`);
    if (!byFacing || typeof byFacing !== 'object') bad(`has no facings for ${st}`);
    for (const [f, list] of Object.entries(byFacing as Record<string, unknown>)) {
      if (!(SPRITE_FACINGS as readonly string[]).includes(f)) bad(`names a facing loom doesn't use (${f})`);
      if (st === 'waiting' && f !== 'south') bad('turns waiting away from south (waiting on you always faces you)');
      if (!Array.isArray(list) || !list.length) bad(`has no animations for ${st} ${f}`);
      const vs = (list as unknown[]).map((v) => {
        const x = v as SpriteVariant;
        if (!x || !Number.isInteger(x.row) || x.row < 0 || !Number.isInteger(x.frames) || x.frames < 1 || x.frames > 256 || typeof x.weight !== 'number' || !(x.weight > 0)) bad(`has an animation in ${st} ${f} without a row, frames and a weight`);
        if (x.sheet !== undefined && (typeof x.sheet !== 'string' || !SHEET_NAME.test(x.sheet))) bad(`names a sheet that isn't a plain .png name (${String(x.sheet)})`);
        if (x.rare !== undefined && typeof x.rare !== 'boolean') bad(`has an animation in ${st} ${f} whose "rare" isn't true or false`);
        if (x.rest !== undefined && (!Number.isInteger(x.rest) || x.rest < 0 || x.rest >= x.frames)) bad(`has an animation in ${st} ${f} whose "rest" isn't one of its frames`);
        return { ...(x.sheet && x.sheet !== 'sheet.png' ? { sheet: x.sheet } : {}), row: x.row, frames: x.frames, weight: x.weight, ...(x.rare ? { rare: true } : {}), ...(x.rest !== undefined ? { rest: x.rest } : {}) };
      });
      ((out.states[st as keyof SpriteManifest['states']] ??= {}) as Record<string, SpriteVariant[]>)[f] = vs;
    }
  }
  if (!out.states.idle?.south) bad('needs idle facing south (every pixel face has it)');
  return out;
}
/** The sheet files a manifest uses. */
export const spriteSheets = (m: SpriteManifest): string[] =>
  [...new Set(Object.values(m.states).flatMap((byF) => Object.values(byF ?? {}).flat().map((v) => v!.sheet ?? 'sheet.png')))];

/** An agent's pixel face: its facings and a version that changes when its manifest or a sheet does; none without one. */
export function spriteOf(h: Household, agent: string): { facings: SpriteFacing[]; v: string; sheets: string[] } | undefined {
  if (!AGENT_NAME.test(agent)) return undefined;
  const dir = spriteDir(h, agent);
  try {
    const raw = readFileSync(join(dir, 'manifest.json'));
    const m = checkSpriteManifest(JSON.parse(raw.toString('utf-8')));
    const v = createHash('sha256').update(raw);
    const sheets = spriteSheets(m);
    for (const f of sheets) { const st = statSync(join(dir, f)); v.update(`${f}:${st.size}:${st.mtimeMs}`); }
    const facings = SPRITE_FACINGS.filter((f) => Object.values(m.states).some((byF) => byF?.[f]));
    return { facings, v: v.digest('base64url').slice(0, 10), sheets };
  } catch { return undefined; }
}

/**
 * A manifest seeded from a PixelLab export: each state's rows by their names (Error, Idle, Thinking, Done, Waiting; a
 * row named by a whole prompt is Working), one animation per state and facing, weight 1 unless `weights` says; waiting
 * south only. Any other named row is an extra animation only if `variants` places it (its state, weight, and rare or not).
 */
export function manifestFromPixelLab(meta: unknown, opts: { weights?: Record<string, number>; variants?: Record<string, { state: string; weight: number; rare?: boolean }> } = {}): SpriteManifest {
  const sh = (meta as { spritesheet?: { cell_size?: { width?: number; height?: number }; columns?: number; rows?: Array<{ row: number; type?: string; animation?: string; direction?: string; frame_count?: number }> } })?.spritesheet;
  if (!sh?.cell_size?.width || !sh.cell_size.height || !Array.isArray(sh.rows)) throw new HouseholdError('that JSON isn\'t a PixelLab sprite sheet\'s (spritesheet.cell_size, rows)');
  const named: Record<string, typeof SPRITE_STATES[number]> = { error: 'error', idle: 'idle', thinking: 'thinking', done: 'done', waiting: 'waiting', working: 'working' };
  const states: Record<string, Record<string, SpriteVariant[]>> = {};
  const extra = Object.fromEntries(Object.entries(opts.variants ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const r of sh.rows.filter((x) => x.type === 'animation')) {
    const name = (r.animation ?? '').trim();
    const x = extra[name.toLowerCase()];
    // PixelLab names a row by its animation, or by its whole prompt (Working's describes what it does).
    const st = x?.state ?? named[name.toLowerCase()] ?? (name.split(/\s+/).length > 6 ? 'working' : undefined);
    const f = r.direction ?? 'south';
    if (!st || !(SPRITE_FACINGS as readonly string[]).includes(f) || (st === 'waiting' && f !== 'south')) continue;
    const v: SpriteVariant = { row: r.row, frames: r.frame_count ?? sh.columns ?? 1, weight: x ? x.weight : opts.weights?.[st] ?? 1, ...(x?.rare ? { rare: true } : {}) };
    ((states[st] ??= {})[f] ??= []).push(v);
  }
  return checkSpriteManifest({ cell: [sh.cell_size.width, sh.cell_size.height], states });
}

/** Keep an agent's pixel face: its manifest and the sheets it names (name → PNG), all checked before any is written. */
export function setSprite(h: Household, agent: string, manifest: SpriteManifest, sheets: Record<string, Buffer>): void {
  if (!AGENT_NAME.test(agent) || !h.agents.includes(agent)) throw new HouseholdError(`${agent} isn't an agent of this household`);
  const m = checkSpriteManifest(manifest);
  const dir = spriteDir(h, agent);
  for (const [name, png] of Object.entries(sheets)) {
    if (!SHEET_NAME.test(name)) throw new HouseholdError(`${name} isn't a plain .png name (lowercase letters, digits, dashes)`);
    if (png.length > SPRITE_MAX_BYTES || !png.subarray(0, 8).equals(PNG_MAGIC)) throw new HouseholdError(`${name} isn't a PNG (4 MB at most)`);
  }
  const missing = spriteSheets(m).filter((f) => !sheets[f] && !existsSync(join(dir, f)));
  if (missing.length) throw new HouseholdError(`the manifest names ${missing.join(', ')}, which ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} given or kept`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, png] of Object.entries(sheets)) writeFileSync(join(dir, name), png, { mode: 0o600 });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
}

/** Set an agent's face in household.json's `faces`. */
export function setFace(h: Household, agent: string, face: AgentFace): void {
  if (!AGENT_NAME.test(agent)) throw new HouseholdError(`${agent} isn't an agent name`);
  if (!FACE_SHAPES.includes(face.shape) || !FACE_EYES.includes(face.eyes)) throw new HouseholdError('that isn\'t a face loom knows');
  withLock(h.home, () => {
    const raw = rawHousehold(h.home);
    const faces = raw.faces && typeof raw.faces === 'object' && !Array.isArray(raw.faces) ? raw.faces as Record<string, unknown> : {};
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify({ ...raw, faces: { ...faces, [agent]: { shape: face.shape, eyes: face.eyes } } }, null, 2) + '\n');
  });
}

/** Set (or, undefined, remove) one top-level key of household.json, under the household's lock. Core's own keys only. */
export function writeHouseholdKey(h: Household, key: 'backup' | 'icons', value: unknown): void {
  withLock(h.home, () => {
    const raw = { ...rawHousehold(h.home) };
    if (value === undefined) delete raw[key]; else raw[key] = value;
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify(raw, null, 2) + '\n');
  });
}

/** What the household says an agent is, on its profile (its owner's words, set on its Setup), if anything. */
export function aboutOf(h: Household, agent: string): string | undefined {
  const a = rawHousehold(h.home).about;
  const v = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>)[agent] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Set (or, empty, clear) what the household says an agent is. At most 600 characters. */
export function setAbout(h: Household, agent: string, text: string): void {
  if (!AGENT_NAME.test(agent)) throw new HouseholdError(`${agent} isn't an agent name`);
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length > 600) throw new HouseholdError('A description is at most 600 characters.');
  withLock(h.home, () => {
    const raw = rawHousehold(h.home);
    const about = raw.about && typeof raw.about === 'object' && !Array.isArray(raw.about) ? { ...(raw.about as Record<string, unknown>) } : {};
    if (t) about[agent] = t; else delete about[agent];
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify({ ...raw, about }, null, 2) + '\n');
  });
}

/** How long an owner's "write your description" (aboutAsk) stays open for the agent to answer (describe_self). */
export const ABOUT_ASK_MS = 24 * 3_600_000;

/** When the household's owner last asked an agent to write its own description (the agent window's Regenerate), while
 * that ask is open: an agent may write its description itself (describe_self) only then, once. */
export function aboutAskOf(h: Household, agent: string, now = Date.now()): string | undefined {
  const a = rawHousehold(h.home).aboutAsk;
  const v = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>)[agent] : undefined;
  return typeof v === 'string' && now - Date.parse(v) < ABOUT_ASK_MS && now >= Date.parse(v) ? v : undefined;
}

/** Open (at `at`) or close (null) the owner's ask for an agent's own description. */
export function setAboutAsk(h: Household, agent: string, at: string | null): void {
  if (!AGENT_NAME.test(agent)) throw new HouseholdError(`${agent} isn't an agent name`);
  withLock(h.home, () => {
    const raw = rawHousehold(h.home);
    const ask = raw.aboutAsk && typeof raw.aboutAsk === 'object' && !Array.isArray(raw.aboutAsk) ? { ...(raw.aboutAsk as Record<string, unknown>) } : {};
    if (at) ask[agent] = at; else delete ask[agent];
    const next: Record<string, unknown> = { ...raw, aboutAsk: ask };
    if (!Object.keys(ask).length) delete next.aboutAsk;
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify(next, null, 2) + '\n');
  });
}

/**
 * The context dir a household names when nothing else does: with LOOM_HOME
 * set and a household.json there, `agents/<LOOM_AGENT or the default>`.
 * Undefined otherwise. Only an explicit LOOM_HOME is consulted here, so a
 * stray household.json never changes where an unconfigured process looks.
 * (A daemon is different: one whose context dir already is
 * `<home>/agents/<name>` serves that household; see householdOf.)
 */
export function contextFromHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.LOOM_HOME) return undefined;
  const h = loadHousehold(householdHome(env));
  if (!h) return undefined;
  const agent = env.LOOM_AGENT || h.default;
  if (!h.agents.includes(agent)) throw new HouseholdError(`LOOM_AGENT=${agent} isn't in the household at ${h.home} (${h.agents.join(', ')})`);
  return agentDir(h, agent);
}

// ─── The commons ─────────────────────────────────────────────────────────────

export function commonsDir(h: Household): string {
  return join(h.home, 'commons');
}

/** The household's shared knowledge store. */
export function commonsKnowledgePath(h: Household): string {
  return join(commonsDir(h), 'knowledge.db');
}

const SQLITE_SIDECARS = ['', '-wal', '-shm'];

/**
 * Why this household can't serve yet, or null. An agent's own knowledge.db
 * beside the commons would quietly fork the knowledge base, so both "only the
 * agent's" (not moved yet) and "both" (needs a merge) are refusals.
 */
export function commonsProblem(h: Household): string | null {
  const commons = existsSync(commonsKnowledgePath(h));
  for (const a of h.agents) {
    if (!existsSync(join(agentDir(h, a), 'knowledge.db'))) continue;
    return commons
      ? `agents/${a}/knowledge.db exists beside commons/knowledge.db; merging an agent's knowledge into the commons isn't automatic yet, so move one aside`
      : `agents/${a}/knowledge.db hasn't moved to the commons; with every loom daemon stopped, run: loom household commons`;
  }
  return null;
}

/**
 * Move one agent's knowledge.db to the commons: checkpoint its WAL into the
 * main file, then rename it (and any sidecars). Refuses when the commons
 * already has a knowledge store. Run with every daemon on this household
 * stopped.
 */
export function moveKnowledgeToCommons(h: Household, agent: string): string | null {
  const from = join(agentDir(h, agent), 'knowledge.db');
  if (!existsSync(from)) return null;
  const to = commonsKnowledgePath(h);
  if (existsSync(to)) throw new HouseholdError(`${to} already exists; merging another agent's knowledge into it isn't automatic yet`);
  return withLock(h.home, () => {
    const db = new BetterSqlite3(from);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    mkdirSync(commonsDir(h), { recursive: true, mode: 0o700 });
    for (const ext of SQLITE_SIDECARS) {
      if (existsSync(from + ext)) renameSync(from + ext, to + ext);
    }
    return to;
  });
}

/**
 * The household at `home`, re-read whenever household.json changes, so an
 * agent added while a daemon runs is served without a restart. Keeps the
 * last good copy if the file is briefly unreadable mid-write.
 */
export function liveHousehold(initial: Household, onChange?: (h: Household) => void): () => Household {
  let current = initial;
  let key = '';
  // The first read counts as a change: whatever onChange keeps up to date is done at start too.
  return () => {
    try {
      const st = statSync(join(initial.home, HOUSEHOLD_FILE));
      const k = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (k !== key) {
        const next = loadHousehold(initial.home);
        if (next) {
          current = next; key = k;
          try { onChange?.(next); } catch { /* the household still serves */ }
        }
      }
    } catch { /* keep the last good one */ }
    return current;
  };
}
