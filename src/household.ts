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
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
}

export type Role =
  | { kind: 'agent'; agent: string }
  | { kind: 'owner' }
  | { kind: 'peer'; name: string };

export interface TokenRecord {
  label: string;
  /** `agent:<name>`, `owner` or `peer:<name>`. */
  role: string;
  /** sha256 of the token, hex. The token itself is never stored. */
  sha256: string;
  created: string;
  last_used?: string;
  revoked?: string;
}

export class HouseholdError extends Error {}

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
  };
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
  const m = /^(agent|peer):([a-z][a-z0-9-]{0,39})$/.exec(s);
  if (!m) return null;
  return m[1] === 'agent' ? { kind: 'agent', agent: m[2] } : { kind: 'peer', name: m[2] };
}

export function roleString(r: Role): string {
  return r.kind === 'owner' ? 'owner' : r.kind === 'agent' ? `agent:${r.agent}` : `peer:${r.name}`;
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
const LOCK_STALE_MS = 30_000;

/**
 * Serialize every read-modify-write of household.json and tokens.json, so
 * two `loom token` runs can't interleave and drop each other's change (a
 * create racing a revoke must not bring the revoked token back).
 */
function withLock<T>(home: string, f: () => T): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new HouseholdError(`${lock} is held by another loom process; try again`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return f(); } finally { rmSync(lock, { force: true }); }
}

const SHA_HEX = /^[0-9a-f]{64}$/;

function validRecord(t: unknown): t is TokenRecord {
  if (typeof t !== 'object' || t === null) return false;
  const r = t as Record<string, unknown>;
  return typeof r.label === 'string' && typeof r.role === 'string' && typeof r.sha256 === 'string' && SHA_HEX.test(r.sha256)
    && typeof r.created === 'string' && (r.revoked === undefined || typeof r.revoked === 'string');
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

/** A role must name an agent this household has. */
function checkRole(h: Household, role: Role): void {
  if (role.kind === 'agent' && !h.agents.includes(role.agent)) {
    throw new HouseholdError(`no agent named ${role.agent} in this household (${h.agents.join(', ')})`);
  }
}

/** Mint a token. Returns it once; only its sha256 is kept. */
export function createToken(h: Household, input: { role: Role; label: string }, now = new Date()): { token: string; record: TokenRecord } {
  checkRole(h, input.role);
  const label = input.label.trim();
  if (!label || label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) throw new HouseholdError('a token needs a label (120 printable characters at most)');
  return withLock(h.home, () => {
    const tokens = loadTokens(h.home);
    if (tokens.some((t) => t.label === label && !t.revoked)) throw new HouseholdError(`a live token is already labeled ${JSON.stringify(label)}`);
    const token = `loom_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = { label, role: roleString(input.role), sha256: sha(token), created: now.toISOString() };
    saveTokens(h.home, [...tokens, record]);
    return { token, record };
  });
}

export function revokeToken(h: Household, label: string, now = new Date()): TokenRecord {
  return withLock(h.home, () => {
    const tokens = loadTokens(h.home);
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

  constructor(private readonly h: Household) {}

  private current(): TokenRecord[] {
    const path = join(this.h.home, TOKENS_FILE);
    let key: string;
    // Every write is a rename, so the inode changes even where mtimes are coarse.
    try { const st = statSync(path); key = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return []; }
    if (!this.cache || this.cache.key !== key) this.cache = { key, tokens: loadTokens(this.h.home) };
    return this.cache.tokens;
  }

  /**
   * The role for a presented token, or null. Revoked tokens and roles naming a
   * missing agent resolve to null. Throws HouseholdError when tokens.json is
   * unreadable or untrusted: the caller fails closed.
   */
  resolve(presented: string): Role | null {
    const d = Buffer.from(sha(presented), 'hex');
    const hit = this.current().find((t) => !t.revoked && t.sha256.length === 64 && timingSafeEqual(Buffer.from(t.sha256, 'hex'), d));
    if (!hit) return null;
    const role = parseRole(hit.role);
    if (!role || (role.kind === 'agent' && !this.h.agents.includes(role.agent))) return null;
    this.touch(hit.sha256);
    return role;
  }

  /** Whether a live owner token has this sha256 (the page's sessions check this, so revoking ends them). */
  ownerDigestLive(digestHex: string): boolean {
    return this.current().some((t) => !t.revoked && t.role === 'owner' && t.sha256 === digestHex);
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
  const h: Household = { home, agents: [agent], default: agent, owner: opts.owner };
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
    writePrivate(join(h.home, HOUSEHOLD_FILE), JSON.stringify({ v: 1, agents: next.agents, default: next.default, ...(next.owner ? { owner: next.owner } : {}) }, null, 2) + '\n');
    return next;
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
