/**
 * loom's web UI on the HTTP daemon (full scope only).
 *
 *   GET  /                         Home: the tape, tiles, "Your call"
 *   GET  /mind, /people[/<slug>], /memory/<ref>, /pieces   loom's own pages
 *   GET  /p/<piece>[/<path>]       a piece's page
 *   GET  /pieces.json              the installed pieces' manifests, for scripts
 *   POST /act/<source>             an action (source = loom or a piece)
 *   GET/POST /login, POST /logout
 *   /login/passkey…, /passkeys        passkeys (docs/specs/passkeys.md)
 *   /ui/…                          the old address: redirects to the same page at the root
 *
 * The page shares the daemon with MCP, which answers on any other path. `/`
 * is the page only for a plain browser GET: a POST, a request with an MCP
 * session, or one asking for an event stream is MCP's.
 *
 * Auth follows the daemon's bearer token, and the UI needs one: a daemon with
 * no token serves no /ui (like /cli), because an open page would be readable
 * by any site that DNS-rebinds a name to the loopback address. A browser logs
 * in once by pasting the token and gets a session: a random id held in this
 * process's memory. It isn't the token and isn't derivable from it, so it
 * can't be replayed as a bearer or used to guess the token. It lasts 30 days,
 * until logout (which revokes it), until the token changes, or until the
 * daemon restarts. Scripts can send the bearer header instead.
 *
 * A GET from another site or another port is served only as a top-level
 * navigation, never to an <img> or a fetch (fetch metadata).
 *
 * Every POST from a browser carries an anti-forgery token derived from its
 * cookie, and a cross-site POST is refused outright (Sec-Fetch-Site / Origin),
 * on top of the SameSite=Strict cookie. The page runs no script and is served
 * under a CSP that forbids script and framing. Action fields go to the piece
 * on stdin and are never logged, stored, or put in a URL; the one-time result
 * message is kept in memory under a random id for a minute.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoRoot } from '../config.js';
import { sessionStore, signinLink } from './sessions.js';
import { APP_JS } from './app.js';
import { askKey, publicKey, pushSub, watch } from './push.js';
import { MANIFEST, SW_JS } from './pwa.js';
import { ALGS, PASSKEY_JS, PasskeyError, relyingParty, verifyAssertion, verifyRegistration } from './passkeys.js';
import { checkBearer } from '../transport/guards.js';
import { agentName, coreAct, corePage, homePage, uiTimeZone } from './core.js';
import { piecesAct, piecesAsks, piecesPage } from './pieces-page.js';
import { catalogKinds, readCatalog } from '../cli/pieces-managed.js';
import { householdFind, householdThread } from './household-pages.js';
import { surfaceOf, tapeRows, whereLabel } from './data.js';
import { listProposals } from '../backends/proposals.js';
import { agentSetup, householdAct, householdHome, householdPeople, householdPerson, knowledgeEntry, knowledgePage, newAgentPage, newFactPage, newPersonPage } from './household-pages.js';
import { agentDir, MARKS, type Household } from '../household.js';
import { pieceAct, pieceManifests, piecePage, type PieceInfo } from './pieces.js';
import { age, renderDashboard, type Dashboard } from './render.js';
import { agentSource, CORE, pageHref, pieceSource, renderHome, renderLogin, renderLoginLink, renderPage, renderPasskeys, renderSheetPage, type AgentHead, type Chrome, type Found, type HomeAsk, type HomeTile, type Source } from './render.js';
import { ID, LIMITS, QUERY_KEY, splitPage, validPath, type ActResult, type Page } from './vocab.js';

const COOKIE = 'loom_ui';
const LOGIN_MAX_BYTES = 4096;
const PASSKEY_MAX_BYTES = 16 * 1024;
/** The two pages that run loom's one script (/login/passkey.js): the sign-in page and Passkeys. */
const PASSKEY_CSP = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const ACT_MAX_BYTES = 64 * 1024;
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const FLASH_TTL_MS = 60_000;
const FLASH_MAX = 200;
/** This process's cookie key. Never written anywhere: a restart means logging in again. */
const SECURITY_HEADERS = {
  // Script only from loom itself (/app.js, /login/passkey.js), never inline: a piece's page is data.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  // same-origin, not no-referrer: under no-referrer, browsers send `Origin:
  // null` on the page's own form posts, which the cross-site guard has to
  // refuse. same-origin still sends nothing to links that leave the page.
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

export interface UiOptions {
  contextDir: string;
  /** Who may log in to the page. */
  auth: UiAuth;
  /** Env for piece discovery and piece processes (PATH decides which pieces exist). */
  env: NodeJS.ProcessEnv;
  /**
   * The household, read fresh (an agent added from the page shows up on the
   * next request). Absent for a plain context dir: the single-agent page.
   */
  household?: () => Household;
}

const PAGE_ROOTS = ['/setup', '/push', '/app.js', '/sw.js', '/manifest.webmanifest', '/icons', '/fonts', '/scope', '/places', '/find', '/login', '/logout', '/pieces.json', '/pieces', '/passkeys', '/mind', '/people', '/memory', '/p', '/act', '/knowledge', '/a', '/new-agent', '/new-person', '/new-fact'];

/** Whether a request is for the page (see the header for how `/` is shared with MCP). */
export function isUiRequest(req: IncomingMessage, pathname: string): boolean {
  if (pathname === '/ui' || pathname.startsWith('/ui/')) return true;
  if (pathname === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.headers['mcp-session-id'] !== undefined) return false;
    return !/text\/event-stream/i.test(req.headers.accept ?? '');
  }
  return PAGE_ROOTS.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Browser sessions: on disk (src/ui/sessions.ts), so a restart signs nobody
 * out, shared by every loom-http process on the machine. The cookie is a
 * random id, not the token and not derivable from it; the file keeps only
 * its hash. Logout deletes it, so a copied cookie stops working (cookies
 * can't be kept from other ports on the same host, so revocation matters).
 */
const storeFor = (opts: UiOptions) => sessionStore(opts.household?.().home ?? opts.contextDir);

/**
 * Who may log in. `check` answers a presented token with its digest when the
 * token may use the page, `live` says whether a digest still may (so revoking
 * or rotating the token ends its sessions). `enabled` false means no token is
 * configured, and the page refuses to serve.
 */
export interface UiAuth {
  enabled: boolean;
  check(token: string): Buffer | null;
  live(digest: Buffer): boolean;
}

/** A fixed list of tokens (a single bearer, or a token map's values). */
export function legacyUiAuth(secrets: string[]): UiAuth {
  const digests = secrets.map((t) => digest(t));
  return {
    enabled: secrets.length > 0,
    check: (t) => {
      const d = digest(t);
      return digests.some((x) => timingSafeEqual(x, d)) ? d : null;
    },
    live: (d) => digests.some((x) => timingSafeEqual(x, d)),
  };
}

/** The anti-forgery token for a session: bound to its id, useless without it. */
function csrfFor(id: string, key: Buffer): string {
  return createHmac('sha256', key).update(`loom-ui-csrf|${id}`).digest('hex');
}

/** Equal-length digests, so neither the content nor the length of a guess leaks. */
function safeEq(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function validSession(id: string, opts: UiOptions, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const auth = opts.auth;
  const store = storeFor(opts);
  const s = store.get(id);
  if (!s) return false;
  if (nowS - s.issuedAt > COOKIE_MAX_AGE_S) { store.delete(id); return false; }
  // A session dies with its token: rotate the token and old sessions stop.
  return auth.live(s.secret);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Who's asking: a browser session (with its cookie, for the anti-forgery token), a script with the bearer, or nobody. */
type Who = { kind: 'session'; cookie: string } | { kind: 'bearer' } | null;

function whoIs(req: IncomingMessage, opts: UiOptions): Who {
  if (!opts.auth.enabled) return null;
  const c = readCookie(req, COOKIE);
  if (c && validSession(c, opts)) return { kind: 'session', cookie: c };
  const header = req.headers['authorization'];
  const presented = header?.replace(/^Bearer\s+/i, '').trim();
  if (presented && opts.auth.check(presented)) return { kind: 'bearer' };
  return null;
}

/**
 * A GET from somewhere else is fine as a top-level navigation (a link in a
 * chat) and refused otherwise: an <img> or fetch from another site, or from
 * another port on this host (same-site, so the cookie rides along), must not
 * make loom run a piece.
 */
function allowedGet(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === undefined || site === 'same-origin' || site === 'none') return true;
  return req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
}

/**
 * A browser POST must come from loom's own page. Sec-Fetch-Site is set by
 * every current browser and can't be forged by a page; Origin, when sent,
 * must name this host. Either one saying "elsewhere" is a refusal.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return false;
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch { return false; }
  }
  return true;
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function redirect(res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { location: to, ...SECURITY_HEADERS, ...extra });
  res.end();
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (d: Buffer) => {
      if (done) return;
      bytes += d.length;
      if (bytes > max) { finish(null); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

async function readForm(req: IncomingMessage, max: number): Promise<URLSearchParams | null> {
  const body = await readBody(req, max);
  return body === null ? null : new URLSearchParams(body);
}

/** A JSON object body (the passkey routes'), or null. */
async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, max);
  if (body === null) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) =>
  send(res, status, 'application/json', JSON.stringify(body), extra);

/** The page's own query: valid keys only, loom's `_` keys and oversize values dropped. */
function pageQuery(url: URL): Record<string, string> {
  const q: Record<string, string> = Object.create(null);
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (!QUERY_KEY.test(k) || v.length > LIMITS.queryValue || Object.hasOwn(q, k)) continue;
    if (++n > LIMITS.query) break;
    q[k] = v;
  }
  return q;
}

// ─── One-time result messages ────────────────────────────────────────────────

/** undo: posted to `act` with `path` to land on: where the action came from (render.ts flash). */
interface Flash { ok: boolean; message: string; from?: string; keep?: boolean; undo?: { act: string; path: string; action: string; label?: string; fields?: Record<string, string> } }
const flashes = new Map<string, { at: number; flash: Flash }>();

function putFlash(flash: Flash): string {
  const now = Date.now();
  for (const [k, v] of flashes) if (now - v.at > FLASH_TTL_MS || flashes.size > FLASH_MAX) flashes.delete(k);
  const id = randomBytes(12).toString('hex');
  flashes.set(id, { at: now, flash });
  return id;
}

function takeFlash(id: string | null): Flash | undefined {
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  return f && Date.now() - f.at <= FLASH_TTL_MS ? f.flash : undefined;
}

// ─── Assembling a page ───────────────────────────────────────────────────────

function clock(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: uiTimeZone(), weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());
}

function hasPages(p: PieceInfo): boolean {
  return Boolean(p.manifest.tab || p.manifest.legacy?.length);
}

/** Agent marks: an initial on a color; colors differ in lightness, not just hue (the design's rule). */
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Each agent's mark colors: household.json's `marks` when it names valid ones, else the palette in order. */
function agentMarks(h: Household): Record<string, { bg: string; fg: string }> {
  let custom: Record<string, { bg?: unknown; fg?: unknown }> = {};
  try {
    const raw = JSON.parse(readFileSync(join(h.home, 'household.json'), 'utf-8')) as { marks?: unknown };
    if (raw.marks && typeof raw.marks === 'object') custom = raw.marks as typeof custom;
  } catch { /* none */ }
  return Object.fromEntries(h.agents.map((a, i) => {
    const c = custom[a];
    return [a, c && typeof c.bg === 'string' && HEX.test(c.bg) && typeof c.fg === 'string' && HEX.test(c.fg) ? { bg: c.bg, fg: c.fg } : { bg: MARKS[i % MARKS.length].bg, fg: MARKS[i % MARKS.length].fg }];
  }));
}

/** Each agent's name and mark, for drawing marks on rows that name an agent. */
function agentsOf(h: Household | undefined): Record<string, { label: string; bg: string; fg: string }> | undefined {
  if (!h) return undefined;
  const marks = agentMarks(h);
  return Object.fromEntries(h.agents.map((a) => [a, { label: agentName(agentDir(h, a)), ...marks[a] }]));
}

const HOME_THREAD = 30;

function agentTabs(agent: string, current: string): AgentHead['tabs'] {
  return [['Today', ''], ['Mind', 'mind'], ['People', 'people'], ['Setup', 'setup']].map(([label, tab]) => ({ label, href: tab ? `/a/${agent}/${tab}` : `/a/${agent}`, current: tab === current }));
}

/** Your call, everywhere: the household's proposals and every piece's asks (or a lone agent's). For the push watch. */
export async function yourCall(opts: UiOptions): Promise<HomeAsk[]> {
  const { pieces } = await pieceManifests(opts.env);
  const hh = opts.household?.();
  if (hh) return [...proposalAsks(hh, Object.fromEntries(hh.agents.map((a) => [a, pendingProposals(hh, a)]))), ...pieceAsks(pieces, opts.env)];
  return pieceAsks(pieces, opts.env);
}

/** One minute's push watch (push.ts): one of loom's listeners announces what's new in Your call. */
export async function pushWatch(opts: UiOptions): Promise<number> {
  const subject = opts.env.LOOM_PUBLIC_URL?.startsWith('https://') ? opts.env.LOOM_PUBLIC_URL : 'mailto:loom@localhost';
  return watch(storeFor(opts), async () => (await yourCall(opts)).map((a) => ({
    key: askKey(a), title: `Your call · ${a.sourceLabel ?? a.source.id}`, body: a.text,
  })), subject);
}

/** loom's own asks: an agent's memory proposals waiting to be ratified. */
/** The longest drafted memory Home's card quotes whole, and so lets you ratify there. */
const CARD_QUOTE = 280;

function proposalAsks(h: Household, proposals: Record<string, number>): HomeAsk[] {
  return h.agents.filter((a) => proposals[a] > 0).map((a): HomeAsk => {
    const n = proposals[a];
    const name = agentName(agentDir(h, a));
    // One waiting: the board's card, what it would remember quoted whole, Ratify and Reject right there.
    // Only when all of it fits on the card: nothing is ratified that wasn't shown. Longer ones go to Mind.
    const one = n === 1 ? listProposals(agentDir(h, a)).find((p) => p.status === 'pending') : undefined;
    const said = (one?.content ?? '').replace(/\s+/g, ' ').trim();
    if (one && said && said.length <= CARD_QUOTE) {
      return { text: `${name} wants to remember something`, meta: `“${said}”`,
        page: `loom:a/${a}/mind`, agent: a, source: agentSource(a), sourceLabel: 'Mind', ...(one.created ? { at: one.created } : {}),
        actions: [{ action: 'ratify', label: 'Ratify', tone: 'primary', fields: { id: String(one.id) } },
          { action: 'reject', label: 'Reject', fields: { id: String(one.id) } }] };
    }
    return { text: `${name} wants to remember ${n === 1 ? 'something' : `${n} things`}`, meta: 'Ratify or reject what it proposed.',
      page: `loom:a/${a}/mind`, label: 'Review', agent: a, source: CORE, sourceLabel: 'Mind' };
  });
}

/** Every piece's asks, labelled with its tab, then the Pieces page's own (setup). */
function pieceAsks(pieces: PieceInfo[], env: NodeJS.ProcessEnv): HomeAsk[] {
  return [
    ...pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece), sourceLabel: p.manifest.tab?.label ?? p.piece }))),
    ...piecesAsks(env).map((a) => ({ ...a, source: CORE, sourceLabel: 'Pieces', tone: 'warn' as const })),
  ];
}

/** Find's groups beyond the places: asks that match (Do), and, in a household, knowledge, people and the scope's memories. */
function findAll(q: string, req: IncomingMessage, opts: UiOptions, pieces: PieceInfo[]): Found {
  const needle = q.toLowerCase();
  const hh = opts.household?.();
  const asks = [...(hh ? proposalAsks(hh, Object.fromEntries(hh.agents.map((a) => [a, pendingProposals(hh, a)]))) : []), ...pieceAsks(pieces, opts.env)];
  const found: Found = {
    do: asks.filter((a) => `${a.text} ${a.label ?? ''} ${a.sourceLabel ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 5).map((a) => ({ label: a.text, href: a.page !== undefined ? pageHref(a.page, a.source) : '/' })),
    knowledge: [], people: [], memories: [],
  };
  if (!hh) return found;
  const scope = scopeOf(req, hh);
  const f = householdFind(hh, q, scope === 'household' ? hh.agents : [scope]);
  found.knowledge = f.knowledge.map((k) => ({ label: k.title, href: `/knowledge/${k.slug}` }));
  found.people = f.people.map((p) => ({ label: p.name, href: `/people/${p.slug}` }));
  found.memories = f.memories.map((m) => ({ label: m.title, href: pageHref(`memory/${m.ref}`, agentSource(m.agent)), agent: m.agent }));
  return found;
}

/** A page below the top level goes back to its parent, by name; a top-level page goes Home. */
function backFor(path: string, places: Array<{ label: string; href: string }>, h?: Household): { label: string; href: string } | undefined {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'knowledge' && seg.length > 1) return { label: 'Knowledge', href: '/knowledge' };
  if (seg[0] === 'people' && seg.length > 1) return { label: 'People', href: '/people' };
  if (seg[0] === 'memory') return { label: 'Mind', href: '/mind' };
  if (seg[0] === 'p' && seg.length > 2) {
    const top = places.find((x) => x.href === `/p/${seg[1]}`);
    if (top) return { label: top.label, href: top.href };
  }
  if (seg[0] === 'a' && h && seg.length > 2 && h.agents.includes(seg[1])) {
    const a = seg[1];
    if (seg[2] === 'memory') return { label: 'Mind', href: `/a/${a}/mind` };
    if (seg[2] === 'people' && seg.length > 3) return { label: 'People', href: `/a/${a}/people` };
    // Its Mind, People and Setup are tabs of its Today, which carry the way around.
    if (seg.length === 3 && ['mind', 'people', 'setup'].includes(seg[2])) return undefined;
    return { label: agentName(agentDir(h, a)), href: `/a/${a}` };
  }
  return undefined;
}

function pendingProposals(h: Household, agent: string): number {
  try { return listProposals(agentDir(h, agent)).filter((p) => p.status === 'pending').length; } catch { return 0; }
}

/** Which catalog pieces a fresh loom suggests first: talk in chat, then a work store. */
const STARTERS = ['shuttle', 'tasks', 'box', 'secrets'];

/** A loom with no pieces yet: who's listening, and two pieces to give them hands. */
function firstRun(names: string[]): NonNullable<Dashboard['firstRun']> {
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const line = names.length === 1 ? `${who} is here and listening. Add pieces to give ${who} hands.` : `${who} are here and listening. Add pieces to give them hands.`;
  const catalog = readCatalog();
  const rank = (n: string) => (STARTERS.includes(n) ? STARTERS.indexOf(n) : STARTERS.length);
  const starters = [...catalog].sort((a, b) => rank(a.name) - rank(b.name)).slice(0, 2).map((c) => ({
    name: c.name, label: c.label ?? c.name,
    // The catalog's first clause is the short "what it does".
    what: (c.description ?? '').split(/(?<=\w)[.:](\s|$)/)[0],
  }));
  return { line, starters };
}

/** "7:42 AM", in the page's time zone. */
/** "active 42m ago" from an agent's latest episode (the Scope sheet's line under each agent), or "quiet for 3 days". */
function lastActive(dir: string, nowMs = Date.now()): string {
  const last = tapeRows(dir, 72, nowMs)[0];
  if (!last) return 'quiet for 3 days';
  const m = Math.max(0, Math.round((nowMs - Date.parse(last.created)) / 60_000));
  return `active ${m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`} ago`;
}

function clockAt(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: uiTimeZone(), hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

const SCOPE_COOKIE = 'loom_scope';

/** The scope the owner chose (a cookie), if it still names an agent in the household. */
function scopeOf(req: IncomingMessage, h: Household | undefined): string {
  const c = readCookie(req, SCOPE_COOKIE);
  return h && c && h.agents.includes(c) ? c : 'household';
}

function chrome(req: IncomingMessage, opts: UiOptions, pieces: PieceInfo[], skipped: string[], current: string, csrf: string, flash?: Flash): Chrome {
  const tabs = pieces.filter(hasPages)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, piece: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const kinds = catalogKinds();
  const places = pieces.filter(hasPages)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, tone: p.manifest.tile?.tone, stat: p.manifest.tile?.value,
      kind: p.manifest.tab?.kind ?? kinds[p.piece] ?? 'place' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const asks = pieces.reduce((n, p) => n + p.manifest.asks.length, 0) + piecesAsks(opts.env).length;
  const tab = current === '' || /^a\/[^/]+$/.test(current) ? 'home' : current === 'places' || current === 'scope' || current === 'find' || current === 'setup' ? current : '';
  const h = opts.household?.();
  const back = backFor(new URL(req.url ?? '/', 'http://loom.invalid').pathname, places, h);
  if (h) {
    const marks = agentMarks(h);
    const scope = /^a\/([^/]+)/.exec(current)?.[1] ?? scopeOf(req, h);
    return {
      agent: h.owner ? `${h.owner}'s household` : 'household',
      nav: [
        { label: 'Home', href: '/', current: current === '', piece: false },
        { label: 'Knowledge', href: '/knowledge', current: current === 'knowledge', piece: false },
        { label: 'People', href: '/people', current: current === 'people', piece: false },
        { label: 'Pieces', href: '/pieces', current: current === 'pieces', piece: false },
        ...h.agents.map((a) => ({ label: agentName(agentDir(h, a)), href: `/a/${a}`, current: current === `a/${a}`, piece: true })),
        ...tabs,
      ],
      clock: clock(),
      csrf,
      flash,
      skipped,
      shell: {
        owner: h.owner ?? 'owner', scope, household: true, asks, tab, back,
        home: scope === 'household' ? '/' : `/a/${scope}`,
        agents: h.agents.map((a) => ({ id: a, label: agentName(agentDir(h, a)), ...marks[a], href: `/scope/${a}`, current: scope === a,
          asks: pendingProposals(h, a) + pieces.reduce((n, p) => n + p.manifest.asks.filter((x) => x.agent === a).length, 0),
          sub: lastActive(agentDir(h, a)) })),
        core: [
          { label: 'Knowledge', href: '/knowledge', current: current.startsWith('knowledge') },
          { label: 'People', href: '/people', current: current.startsWith('people') },
        ],
        pieces: places,
      },
    };
  }
  const name = agentName(opts.contextDir);
  return {
    agent: name,
    nav: [
      { label: 'Home', href: '/', current: current === '', piece: false },
      { label: 'Mind', href: '/mind', current: current === 'mind', piece: false },
      { label: 'People', href: '/people', current: current === 'people', piece: false },
      { label: 'Pieces', href: '/pieces', current: current === 'pieces', piece: false },
      ...tabs,
    ],
    clock: clock(),
    csrf,
    flash,
    skipped,
    shell: {
      owner: 'owner', scope: 'agent', household: false, asks, tab, home: '/', back,
      agents: [{ id: 'agent', label: name, bg: MARKS[0].bg, fg: MARKS[0].fg, href: '/', current: true }],
      core: [
        { label: 'Mind', href: '/mind', current: current === 'mind' },
        { label: 'People', href: '/people', current: current.startsWith('people') },
      ],
      pieces: places,
    },
  };
}

/** Where to land after an action: the page the piece names, or back where the form was. */
function landing(source: Source, result: ActResult, back: string): string {
  const link = result.page !== undefined && splitPage(result.page) ? result.page : splitPage(back) ? back : '';
  return pageHref(link, source);
}

function withFlash(to: string, id: string): string {
  return `${to}${to.includes('?') ? '&' : '?'}_flash=${id}`;
}

const notFound: Page = { title: 'Not found', sections: [] };

/** decodeURIComponent, or null for a malformed escape (a 404, never a 500). */
function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** Handle a request for the page. The caller has already matched isUiRequest. */
export async function handleUi(req: IncomingMessage, res: ServerResponse, pathname: string, opts: UiOptions): Promise<void> {
  // No token, no page: an open /ui would be readable by any site that
  // DNS-rebinds a name to the loopback address (the same rule as /cli).
  if (!opts.auth.enabled) {
    return send(res, 403, 'text/plain', 'forbidden: loom\'s page requires LOOM_BEARER_TOKEN');
  }
  // The page used to live under /ui. Old links and bookmarks land on the same page.
  if (pathname === '/ui' || pathname.startsWith('/ui/')) {
    const to = new URL(req.url ?? pathname, 'http://loom.invalid');
    // One leading slash, never two: `/ui//evil.example` must not become a
    // protocol-relative `//evil.example`.
    const rest = '/' + pathname.slice(3).replace(/^[/\\]+/, '');
    res.writeHead(308, { location: rest + to.search, ...SECURITY_HEADERS });
    return void res.end();
  }
  const secure = req.headers['x-forwarded-proto'] === 'https';

  // A one-time sign-in link (`loom token link`). GET only shows a button: a
  // chat's link preview fetches the URL, and mustn't spend it.
  const linkMatch = /^\/login\/([0-9a-f]{64})$/.exec(pathname);
  if (linkMatch) {
    const code = linkMatch[1];
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLoginLink(code));
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const secret = storeFor(opts).useLink(code);
    if (!secret || !opts.auth.live(secret)) {
      return send(res, 401, 'text/html; charset=utf-8', renderLoginLink(code, 'That link is used up, expired, or its token was revoked.'));
    }
    return redirect(res, '/', {
      'set-cookie': `${COOKIE}=${storeFor(opts).create(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }

  const rp = relyingParty(opts.env);
  // Passkeys work only on the page at LOOM_PUBLIC_URL (their origin): offer one there.
  const onRp = !!rp && req.headers.host === new URL(rp.origin).host;
  const sessionCookie = (secret: Buffer) =>
    `${COOKIE}=${storeFor(opts).create(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`;

  // loom's own fonts (OFL, assets/fonts): the two the page uses, nothing else.
  const font = /^\/fonts\/(instrument-sans-latin-wght-normal|jetbrains-mono-latin-wght-normal)\.woff2$/.exec(pathname);
  if (font) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
    return void res.end(readFileSync(join(resolveRepoRoot(), 'assets', 'fonts', `${font[1]}.woff2`)));
  }
  // The app: its manifest, icons and service worker (src/ui/pwa.ts). Public, like the fonts: none of it says anything about you.
  const icon = /^\/icons\/(loom-(?:32|180|192|512|maskable-512)\.png)$/.exec(pathname);
  if (icon) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return void res.end(readFileSync(join(resolveRepoRoot(), 'assets', 'icons', icon[1])));
  }
  if (pathname === '/manifest.webmanifest') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'application/manifest+json', MANIFEST, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/sw.js') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'text/javascript; charset=utf-8', SW_JS, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/app.js') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'text/javascript; charset=utf-8', APP_JS, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/login/passkey.js') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    return send(res, 200, 'text/javascript; charset=utf-8', PASSKEY_JS, { 'cache-control': 'no-cache' });
  }
  if (pathname === '/login/passkey/options' || pathname === '/login/passkey') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (!rp) return sendJson(res, 404, { error: 'passkeys aren\'t set up here (LOOM_PUBLIC_URL)' });
    const body = await readJson(req, PASSKEY_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (pathname === '/login/passkey/options') {
      return sendJson(res, 200, { challenge: storeFor(opts).createChallenge('login', null), rpId: rp.rpId, timeout: 300_000 });
    }
    const store = storeFor(opts);
    const stored = typeof body.id === 'string' ? store.passkey(body.id) : null;
    if (!stored) return sendJson(res, 401, { error: 'loom doesn\'t know that passkey (it may have been removed)' });
    try {
      const a = verifyAssertion(body, stored, rp);
      if (!store.useChallenge(a.challenge, 'login')) return sendJson(res, 401, { error: 'that sign-in expired or was already used; try again' });
      const used = store.usePasskey(stored.id, a.counter);
      if (!used) return sendJson(res, 401, { error: 'that passkey\'s counter went backwards: it may have been copied, so it was refused' });
      const secret = Buffer.from(used.secret, 'hex');
      if (!opts.auth.live(secret)) return sendJson(res, 401, { error: 'the token that added this passkey was revoked; sign in with a link and add it again' });
      return sendJson(res, 200, { ok: true, to: '/' }, { 'set-cookie': sessionCookie(secret) });
    } catch (err) {
      if (err instanceof PasskeyError) return sendJson(res, 401, { error: err.message });
      throw err;
    }
  }

  if (pathname === '/login') {
    // Unauthenticated: the login page names no agent.
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLogin(undefined, { rp: rp?.origin, here: onRp }), onRp ? PASSKEY_CSP : {});
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const form = await readForm(req, LOGIN_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    const token = form.get('token')?.trim() ?? '';
    const match = token ? opts.auth.check(token) : null;
    if (!match) return send(res, 401, 'text/html; charset=utf-8', renderLogin('That token didn’t match.', { rp: rp?.origin, here: onRp }), onRp ? PASSKEY_CSP : {});
    return redirect(res, '/', {
      'set-cookie': `${COOKIE}=${storeFor(opts).create(match)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }

  const who = whoIs(req, opts);
  // The agent the owner is looking at (an agent's own pages, else the chosen scope); pieces get it as LOOM_SCOPE.
  const hhScope = opts.household?.();
  const scope = /^\/a\/([a-z][a-z0-9-]{0,39})(?:\/|$)/.exec(pathname)?.[1] ?? scopeOf(req, hhScope);
  const scopedEnv: NodeJS.ProcessEnv = hhScope && scope !== 'household' && hhScope.agents.includes(scope) ? { ...opts.env, LOOM_SCOPE: scope } : opts.env;
  const csrf = who?.kind === 'session' ? csrfFor(who.cookie, storeFor(opts).key) : '';

  if (pathname === '/logout') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    // Revoke it server-side, so a copy of the cookie stops working too.
    const c = readCookie(req, COOKIE);
    if (c && /^[0-9a-f]{64}$/.test(c)) storeFor(opts).delete(c);
    // And the copies of pages this browser kept for offline (https only; /app.js also asks the worker).
    return redirect(res, '/login', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, 'clear-site-data': '"cache", "storage"' });
  }

  if (!who) {
    if (pathname.endsWith('.json')) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    if (req.method === 'GET') return redirect(res, '/login');
    return send(res, 401, 'text/plain', 'unauthorized');
  }

  const url = new URL(req.url ?? pathname, 'http://loom.invalid');

  // Adding a passkey: a browser session only (it signs in as that session's token), with its form token.
  // Push for Your call (push.ts): the key to subscribe with, and this browser's subscription.
  if (pathname === '/push/key' && req.method === 'GET') {
    if (who.kind !== 'session') return sendJson(res, 403, { error: 'from a signed-in browser' });
    return sendJson(res, 200, { publicKey: publicKey(storeFor(opts)) });
  }
  if ((pathname === '/push/subscribe' || pathname === '/push/unsubscribe') && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (who.kind !== 'session') return sendJson(res, 403, { error: 'from a signed-in browser' });
    const body = await readJson(req, PASSKEY_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (!safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return sendJson(res, 403, { error: 'this page is stale; reload and try again' });
    const sub = pushSub(body.sub);
    if (!sub) return sendJson(res, 400, { error: 'not a push subscription loom sends to' });
    if (pathname === '/push/unsubscribe') storeFor(opts).removePushSub(sub.endpoint);
    else storeFor(opts).addPushSub(who.cookie, sub);
    return sendJson(res, 200, { ok: true });
  }
  if ((pathname === '/passkeys/options' || pathname === '/passkeys') && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request' });
    if (who.kind !== 'session') return sendJson(res, 403, { error: 'a passkey is added from a signed-in browser' });
    if (!rp || !onRp) return sendJson(res, 404, { error: rp ? `passkeys work at ${rp.origin}` : 'passkeys aren\'t set up here (LOOM_PUBLIC_URL)' });
    const body = await readJson(req, PASSKEY_MAX_BYTES);
    if (!body) return sendJson(res, 400, { error: 'not a JSON object' });
    if (!safeEq(typeof body._csrf === 'string' ? body._csrf : '', csrf)) return sendJson(res, 403, { error: 'this page is stale; reload and try again' });
    const store = storeFor(opts);
    const session = store.get(who.cookie);
    if (!session) return sendJson(res, 401, { error: 'signed out' });
    if (pathname === '/passkeys/options') {
      return sendJson(res, 200, {
        challenge: store.createChallenge('register', session.secret),
        rp: { id: rp.rpId, name: 'loom' },
        // One user per household: the owner. A discoverable passkey needs some id; this one is stable and says nothing.
        user: { id: Buffer.from(createHash('sha256').update(`loom-owner|${rp.rpId}`).digest().subarray(0, 16)).toString('base64url'), name: 'owner', displayName: 'loom' },
        pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: store.passkeys().map((p) => ({ id: p.id })),
        timeout: 300_000,
      });
    }
    try {
      const r = verifyRegistration(body, rp);
      const c = store.useChallenge(r.challenge, 'register');
      if (!c?.secret) return sendJson(res, 401, { error: 'that expired or was already used; try again' });
      // It signs in as the token of the session that asked, and only that one.
      if (!c.secret.equals(session.secret)) return sendJson(res, 403, { error: 'that was started by another session' });
      const label = (typeof body.label === 'string' ? body.label.trim() : '').slice(0, 60) || 'A passkey';
      store.addPasskey({ id: r.id, publicKey: r.publicKey, alg: r.alg, counter: r.counter, label, created: Math.floor(Date.now() / 1000), secret: session.secret.toString('hex') });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof PasskeyError) return sendJson(res, 400, { error: err.message });
      if (err instanceof Error && /passkey/.test(err.message)) return sendJson(res, 409, { error: err.message });
      throw err;
    }
  }

  const hh = opts.household?.();
  const agentAct = hh ? /^\/a\/([a-z][a-z0-9-]{0,39})\/act\/loom$/.exec(pathname) : null;
  if (pathname.startsWith('/act/') || agentAct) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    if (agentAct && !hh!.agents.includes(agentAct[1])) return send(res, 404, 'text/plain', 'not found');
    const sourceId = agentAct ? 'loom' : pathname.slice('/act/'.length);
    if (sourceId !== 'loom' && !ID.test(sourceId)) return send(res, 404, 'text/plain', 'not found');
    const form = await readForm(req, ACT_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    // A browser session must prove the form came from loom's page. A bearer
    // script has no ambient credential a forger could ride, so it needs none.
    if (who.kind === 'session' && !safeEq(form.get('_csrf') ?? '', csrf)) {
      return send(res, 403, 'text/plain', 'forbidden: this form is stale or not from loom\'s page; reload and try again');
    }
    const action = form.get('_action') ?? '';
    const back = form.get('_path') ?? '';
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(action)) return send(res, 400, 'text/plain', 'bad action');
    const backLink = splitPage(back) ? back : '';
    // A form has up to LIMITS.fields fields plus LIMITS.hidden hidden values.
    // More than that is refused whole, never cut short: a truncated form
    // could drop the very field (a secret) the piece needs.
    const fields: Record<string, string> = Object.create(null);
    for (const [k, v] of form) {
      if (k.startsWith('_') || !/^[a-z][a-z0-9_-]{0,39}$/.test(k) || Object.hasOwn(fields, k)) continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length > LIMITS.fields + LIMITS.hidden) return send(res, 400, 'text/plain', 'too many fields');
    let source: Source;
    let result: ActResult;
    if (agentAct) {
      // One agent's own actions (archive, ratify, reject), on its stack.
      source = agentSource(agentAct[1]);
      result = await coreAct(agentDir(hh!, agentAct[1]), action, fields);
    } else if (sourceId === 'loom' && action === 'passkey-remove') {
      source = CORE;
      result = storeFor(opts).removePasskey(fields.id ?? '')
        ? { ok: true, message: 'Removed. That device can\'t sign in with it any more.', page: 'loom:passkeys' }
        : { ok: false, message: 'No such passkey.', page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'signin-link' && hh) {
      source = CORE;
      const base = (opts.env.LOOM_PUBLIC_URL ?? '').replace(/\/+$/, '');
      result = { ok: true, keep: true, page: 'loom:passkeys', message: `One sign-in, within 10 minutes: ${base}/login/${signinLink(hh, 600)}` };
    } else if (sourceId === 'loom' && action.startsWith('piece-')) {
      // The Pieces page's: install, update, roll back, remove, settings.
      source = CORE;
      result = await piecesAct(opts.env, action, fields);
    } else if (sourceId === 'loom' && hh) {
      // The household's: tokens and agents.
      source = CORE;
      result = await householdAct(hh, action, fields);
    } else if (sourceId === 'loom') {
      source = CORE;
      result = await coreAct(opts.contextDir, action, fields);
    } else {
      const { pieces } = await pieceManifests(scopedEnv);
      const info = pieces.find((p) => p.piece === sourceId);
      if (!info) return send(res, 404, 'text/plain', 'not found');
      source = pieceSource(info.piece);
      const path = splitPage(backLink)?.path ?? '';
      result = await pieceAct(info, { action, path, fields }, scopedEnv);
    }
    const to = landing(source, result, backLink);
    // A piece's message is labeled with the piece, so it can't pass as loom's.
    const from = source.id === 'loom' ? undefined : source.id;
    // Undo goes back to the same source, landing where the action came from.
    const undo = result.ok && result.undo ? { ...result.undo, act: source.act ?? `/act/${source.id}`, path: backLink } : undefined;
    // The page's own script posts with fetch: it gets the one line back as
    // JSON and stays where it is, unless the action lands somewhere else.
    if (req.headers['x-loom-fetch'] === '1') {
      const stay = to === pageHref(backLink, source);
      return sendJson(res, 200, { ok: result.ok, message: result.message, ...(from ? { from } : {}), ...(result.keep ? { keep: true } : {}), ...(undo ? { undo } : {}),
        ...(stay ? {} : { go: withFlash(to, putFlash({ ok: result.ok, message: result.message, from, keep: result.keep, undo })) }) });
    }
    return redirect(res, withFlash(to, putFlash({ ok: result.ok, message: result.message, from, keep: result.keep, undo })));
  }

  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
  if (!allowedGet(req)) return send(res, 403, 'text/plain', 'forbidden: loom\'s page can only be opened, not embedded or fetched from another site');
  if (pathname === '/pieces.json') {
    const m = await pieceManifests(scopedEnv);
    return send(res, 200, 'application/json', JSON.stringify({
      agent: agentName(opts.contextDir),
      pieces: m.pieces.map((p) => ({ piece: p.piece, manifest: p.manifest })),
      skipped: m.skipped,
    }));
  }
  const query = pageQuery(url);
  const flash = takeFlash(url.searchParams.get('_flash'));
  const { pieces, skipped } = await pieceManifests(scopedEnv);
  const skippedNames = skipped.map((s) => s.piece);
  const html = (body: string, status = 200) => send(res, status, 'text/html; charset=utf-8', body);

  // The shell's sheets as pages: they work without script; app.js opens them as sheets.
  const pick = /^\/scope\/([a-z][a-z0-9-]{0,39}|household)$/.exec(pathname);
  if (pick) {
    const hh2 = opts.household?.();
    const id = pick[1] === 'household' || !hh2?.agents.includes(pick[1]) ? 'household' : pick[1];
    res.writeHead(303, { location: id === 'household' ? '/' : `/a/${id}`, 'set-cookie': `${SCOPE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`, ...SECURITY_HEADERS });
    return void res.end();
  }
  if (pathname === '/scope' || pathname === '/places' || pathname === '/find' || pathname === '/setup') {
    const tab = pathname.slice(1);
    const ch = chrome(req, opts, pieces, skippedNames, tab, csrf, flash);
    const q = (url.searchParams.get('q') ?? '').slice(0, 100);
    return html(renderSheetPage(tab as 'scope' | 'places' | 'find' | 'setup', ch, q, tab === 'find' && q.trim() ? findAll(q.trim(), req, opts, pieces) : undefined));
  }

  if (pathname === '/passkeys') {
    const tz = uiTimeZone();
    const when = (s?: number) => (s ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s * 1000)) : 'never');
    const keys = storeFor(opts).passkeys();
    const page: Page = {
      title: 'Passkeys',
      sections: [
        // The board's order: your passkeys, then adding one (loom's control, put in after this), then another device.
        { id: 'passkeys', blocks: keys.length
          ? [{ type: 'list', items: keys.slice(0, 200).map((k) => {
              const works = opts.auth.live(Buffer.from(k.secret, 'hex'));
              return { text: k.label, meta: works ? `used ${k.lastUsed ? when(k.lastUsed) : 'never'} · added ${when(k.created)}` : 'its token was revoked, so it no longer works',
                ...(works ? {} : { tone: 'warn' as const }),
                act: { action: 'passkey-remove', label: 'Remove', tone: 'danger' as const, confirm: 'That device can\'t sign in with it any more. A token or another passkey still can.', fields: { id: k.id } } };
            }) }]
          : [{ type: 'text', text: 'None yet: add one from the device you want to sign in with.', tone: 'muted' }] },
        ...(hh ? [{ id: 'another', title: 'Another device', blocks: [
          { type: 'buttons' as const, items: [{ action: 'signin-link', label: 'Make a one-time sign-in link' }] },
          { type: 'text' as const, text: 'One sign-in, within 10 minutes, as the household\'s page sign-in links token. Open it on the other device.', tone: 'muted' as const },
        ] }] : []),
      ],
    };
    const ch = chrome(req, opts, pieces, skippedNames, 'passkeys', csrf, flash);
    const add = !rp ? { note: 'Passkeys need loom\'s public https address: set LOOM_PUBLIC_URL for loom-http.' }
      : !onRp ? { note: `Passkeys work at ${rp.origin}: open this page there to add one.` }
      : who.kind !== 'session' ? { note: 'A passkey is added from a signed-in browser.' }
      : { csrf };
    return send(res, 200, 'text/html; charset=utf-8', renderPasskeys(page, { source: CORE, path: 'passkeys', query, csrf }, ch, add), 'csrf' in add ? PASSKEY_CSP : {});
  }

  if (hh) {
    const hhAgents = agentsOf(hh);
    const ctxOf = (path: string, source: Source = CORE) => ({ source, path, query, csrf, agents: hhAgents });
    const send200 = (page: import('./vocab.js').Page, current: string, ctx: ReturnType<typeof ctxOf>, head?: AgentHead) =>
      html(renderPage(page, ctx, chrome(req, opts, pieces, skippedNames, current, csrf, flash), undefined, head), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
    if (pathname === '/') {
      const nowMs = Date.now();
      const store = storeFor(opts);
      const sinceMs = (req.headers['x-loom-live'] === '1' ? store.seenSince(Math.floor(nowMs / 1000)) : store.lookedAt(Math.floor(nowMs / 1000))) * 1000;
      const t = householdThread(hh, 24, nowMs);
      // Thread chips: All, each agent (when there's more than one), then each place it happened.
      // A row with no where ("?") is under All only: a pill for it says nothing.
      const surfaces = [...new Set(t.items.map((r) => surfaceOf(r.where)))].filter((w) => w !== '?').sort();
      const from = query.who && (hh.agents.includes(query.who) || surfaces.includes(query.who)) ? query.who : '';
      const agents = agentsOf(hh)!;
      const chips = [...(hh.agents.length > 1 ? hh.agents.map((a) => ({ value: a, label: agents[a].label })) : []),
        ...(surfaces.length > 1 ? surfaces.filter((s) => !hh.agents.includes(s)).map((s) => ({ value: s, label: whereLabel(s) })) : [])];
      const d: Dashboard = {
        label: 'Household',
        asks: [...proposalAsks(hh, t.proposals), ...pieceAsks(pieces, opts.env)],
        tiles: pieces.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) })),
        thread: t.items.filter((r) => !from || r.agent === from || surfaceOf(r.where) === from).slice(0, HOME_THREAD)
          .map((r) => ({ agent: r.agent, text: r.text, meta: [whereLabel(r.where), age(r.created, nowMs)].filter(Boolean).join(' · '), at: r.created, page: r.page })),
        sinceMs, sinceLabel: clockAt(sinceMs),
        filters: chips.length ? { param: 'who', current: from, options: [{ value: '', label: 'All' }, ...chips] } : undefined,
        shared: { pages: t.pages, people: t.people },
        firstRun: pieces.length ? undefined : firstRun(hh.agents.map((a) => agents[a].label)),
      };
      return html(renderDashboard(d, { ...ctxOf(''), agents }, chrome(req, opts, pieces, skippedNames, '', csrf, flash), nowMs));
    }
    if (pathname === '/knowledge') return send200(knowledgePage(hh, query), 'knowledge', ctxOf('knowledge'));
    if (pathname.startsWith('/knowledge/')) {
      const slug = decode(pathname.slice('/knowledge/'.length));
      return send200(slug && validPath(slug) ? knowledgeEntry(hh, slug) : notFound, 'knowledge', ctxOf('knowledge'));
    }
    if (pathname === '/people') return send200(householdPeople(hh), 'people', ctxOf('people'));
    if (pathname === '/pieces') return send200(piecesPage(opts.env, query), 'pieces', ctxOf('pieces'));
    if (pathname.startsWith('/people/')) {
      const slug = decode(pathname.slice('/people/'.length));
      return send200(slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? householdPerson(hh, slug) : notFound, 'people', ctxOf(`people/${slug}`));
    }
    if (pathname === '/new-agent') return send200(newAgentPage(hh), '', ctxOf('new-agent'));
    if (pathname === '/new-person') return send200(newPersonPage(), 'people', ctxOf('new-person'));
    if (pathname === '/new-fact') return send200(newFactPage(), 'knowledge', ctxOf('new-fact'));
    const a = /^\/a\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(pathname);
    if (a) {
      const agent = a[1];
      if (!hh.agents.includes(agent)) return send200(notFound, '', ctxOf(''));
      const rest = decode(a[2] ?? '') ?? '\0';
      const dir = agentDir(hh, agent);
      const src = agentSource(agent);
      if (rest === '' ) {
        // The agent's Today: its asks, Memories and its pieces' tiles (scope-aware ones), its own thread.
        const nowMs = Date.now();
        const t = householdThread({ ...hh, agents: [agent] }, 24, nowMs);
        const agents = agentsOf(hh)!;
        const scoped = pieces.filter((p) => p.manifest.scope);
        const d: Dashboard = {
          label: agents[agent].label,
          agent: { ...agents[agent], sub: `${t.items.length} today · ${t.memories[agent].toLocaleString('en-US')} memories`, tabs: agentTabs(agent, '') },
          asks: [...proposalAsks({ ...hh, agents: [agent] }, t.proposals), ...pieceAsks(pieces, opts.env).filter((a) => a.agent === agent || (!a.agent && scoped.some((p) => p.piece === a.source.id)))],
          tiles: [{ label: 'Memories', value: t.memories[agent].toLocaleString('en-US'), page: 'mind', source: src },
            ...scoped.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) }))],
          thread: t.items.slice(0, HOME_THREAD).map((r) => ({ text: r.text, meta: [whereLabel(r.where), age(r.created, nowMs)].filter(Boolean).join(' · '), at: r.created, page: r.page })),
        };
        return html(renderDashboard(d, { ...ctxOf('', src), agents }, chrome(req, opts, pieces, skippedNames, `a/${agent}`, csrf, flash), nowMs));
      }
      // Its Mind, People and Setup wear its head and tabs, like Today; a page under them keeps its own title.
      const head = (tab: string): AgentHead => ({ ...agentsOf(hh)![agent], tabs: agentTabs(agent, tab) });
      if (rest === 'setup') return send200(agentSetup(hh, agent), `a/${agent}`, ctxOf(`a/${agent}/setup`, CORE), head('setup'));
      const page = validPath(rest) ? corePage(dir, rest, query) : null;
      return send200(page ?? notFound, `a/${agent}`, ctxOf(validPath(rest) ? rest : '', src), page && (rest === 'mind' || rest === 'people') ? head(rest) : undefined);
    }
    // loom's own single-agent addresses land on the default agent's view.
    if (pathname === '/mind' || pathname.startsWith('/memory/')) {
      res.writeHead(302, { location: `/a/${hh.default}${pathname}${url.search}`, ...SECURITY_HEADERS });
      return void res.end();
    }
  }

  if (pathname === '/') {
    const home = homePage(opts.contextDir, query);
    const tiles: HomeTile[] = [
      { ...home.tile, source: CORE },
      ...pieces.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) })),
    ];
    const asks: HomeAsk[] = [
      ...piecesAsks(opts.env).map((a) => ({ ...a, source: CORE })),
      ...pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece) }))),
    ];
    return html(renderHome(home.page, { source: CORE, path: '', query, csrf }, chrome(req, opts, pieces, skippedNames, '', csrf, flash), tiles, asks));
  }

  if (pathname.startsWith('/p/')) {
    const rest = pathname.slice('/p/'.length);
    const slash = rest.indexOf('/');
    const piece = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : decode(rest.slice(slash + 1));
    const info = pieces.find((p) => p.piece === piece && hasPages(p));
    const ch = chrome(req, opts, pieces, skippedNames, `p/${piece}`, csrf, flash);
    if (!info || path === null || !validPath(path)) return html(renderPage(notFound, { source: pieceSource(piece), path: '', query: {}, csrf }, ch), 404);
    const page = await piecePage(info, path, query, scopedEnv);
    const ctx = { source: pieceSource(piece), path, query, csrf, agents: agentsOf(hhScope) };
    if (typeof page === 'string') {
      return html(renderPage({ title: info.manifest.tab?.label ?? piece, sections: [{ id: 'error', blocks: [{ type: 'callout', tone: 'bad', text: `${piece} couldn't show this page (${page}).` }] }] }, ctx, ch), 502);
    }
    // A piece that can't narrow to the selected agent says so, once, at the top.
    const unscoped = scopedEnv.LOOM_SCOPE && !info.manifest.scope ? agentName(agentDir(hhScope!, scopedEnv.LOOM_SCOPE)) : undefined;
    return html(renderPage(page, ctx, ch, unscoped), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
  }

  if (pathname === '/pieces') {
    const page = piecesPage(opts.env, query);
    return html(renderPage(page, { source: CORE, path: 'pieces', query, csrf }, chrome(req, opts, pieces, skippedNames, 'pieces', csrf, flash)));
  }

  const path = decode(pathname.slice(1)) ?? '\0';
  const top = path.split('/')[0];
  const ch = chrome(req, opts, pieces, skippedNames, top, csrf, flash);
  const page = validPath(path) ? corePage(opts.contextDir, path, query) : null;
  const ctx = { source: CORE, path: validPath(path) ? path : '', query, csrf };
  if (!page) return html(renderPage(notFound, ctx, ch), 404);
  return html(renderPage(page, ctx, ch), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
}
