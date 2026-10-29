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
import { changed, openStream, type Sees } from './live.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { brotliCompress, brotliCompressSync, constants as zlibConstants, gzip, gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';
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
import { agentSetup, householdAct, householdHome, householdMembers, householdPeople, householdPerson, knowledgeEntry, knowledgePage, newAgentPage, newFactPage, newPersonPage } from './household-pages.js';
import { agentDir, firstOwner, MARKS, memberOf, type Household, type Member } from '../household.js';
import { pieceAct, pieceManifests, piecePage, type ApiCaller, type PieceInfo } from './pieces.js';
import { age, type Dashboard } from './render.js';
import { agentSource, CORE, INBOX_FOLDERS, inFolder, pageHref, pieceSource, type AgentCard, type HouseHome, type InboxFolder, type InboxItem, renderLogin, renderLoginLink, type AgentHead, type Chrome, type Found, type HomeAsk, type HomeTile, type Source } from './render.js';
import { ID, LIMITS, QUERY_KEY, splitPage, validPath, type ActResult, type AgentState, type Page, type Section } from './vocab.js';

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
  // Script only from loom itself (the app under /app/; the sign-in pages' /app.js and /login/passkey.js), never inline: a piece's page
  // is data. Stylesheets from loom itself too (the app's), and data: images (its components' small SVG backgrounds).
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  /**
   * Set for an agent owner's request (docs/specs/owners.md): the agents they own. `household`
   * is then theirs alone, pieces are the ones that understand agent owners, and the
   * household's own pages and actions are refused.
   */
  ownerScope?: string[];
  /** The member signed in, for the account menu (docs/specs/owners.md). */
  viewer?: string;
}

/** Paths an agent owner's page may open: Home, the Inbox, Activity, their agents, opted-in pieces, their passkeys. */
function scopedPathOk(pathname: string): boolean {
  return pathname === '/' || pathname === '/inbox' || pathname === '/activity' || pathname === '/passkeys' || pathname === '/events'
    || pathname === '/scope' || pathname === '/places' || pathname === '/find' || pathname === '/setup'
    || pathname.startsWith('/a/') || pathname.startsWith('/p/') || pathname.startsWith('/act/');
}

/**
 * The pieces as an agent owner sees them: only those that understand agent owners (owners: 2),
 * each manifest cut to their agents' asks, notices, answered items and readings. An item that
 * names no agent is the household's, and a tile is a household figure, so both go.
 */
function forOwner(pieces: PieceInfo[], own: string[] | undefined): PieceInfo[] {
  if (!own) return pieces;
  const mine = <T extends { agent?: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => x.agent !== undefined && own.includes(x.agent));
  return pieces.filter((p) => p.manifest.owners === 2).map((p) => ({
    ...p,
    manifest: {
      ...p.manifest,
      tile: undefined,
      asks: mine(p.manifest.asks),
      notices: mine(p.manifest.notices),
      answered: mine(p.manifest.answered),
      agents: p.manifest.agents ? Object.fromEntries(Object.entries(p.manifest.agents).filter(([a]) => own.includes(a))) : undefined,
    },
  }));
}

/** Whose read state a request reads and writes: none for the first household owner (the household's own record), else the member. */
function readerFor(opts: UiOptions, who: Who): string | undefined {
  const m = who?.member;
  const h = opts.household?.();
  return !m || !h || m.person === firstOwner(h).person ? undefined : m.person;
}

/** A member's passkeys: those whose token is theirs. */
function passkeysOf(opts: UiOptions, m: Member) {
  return storeFor(opts).passkeys().filter((k) => opts.auth.member?.(Buffer.from(k.secret, 'hex'))?.person === m.person);
}

/** The household as an agent owner sees it: their agents only (the default, theirs too). */
function narrowed(h: Household, agents: string[]): Household {
  const own = h.agents.filter((a) => agents.includes(a));
  return { ...h, agents: own, default: own.includes(h.default) ? h.default : own[0] };
}

/** The built app (web/ → dist/web): beside this module's dist/ui, or from src/ui (tests, `npm run dev`) the repo's dist/web. */
const WEB_DIR = [new URL('../web/', import.meta.url), new URL('../../dist/web/', import.meta.url)]
  .map((u) => fileURLToPath(u)).find((d) => existsSync(join(d, 'index.html'))) ?? fileURLToPath(new URL('../web/', import.meta.url));
const WEB_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
/** A file of the built app, or null: never outside its folder. */
function webFile(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const p = normalize(join(WEB_DIR, rel));
  if (!p.startsWith(WEB_DIR.endsWith(sep) ? WEB_DIR : WEB_DIR + sep)) return null;
  try { return existsSync(p) && statSync(p).isFile() ? p : null; } catch { return null; }
}

/** Whose a live stream is, for its per-browser cap: the session, else the very credential presented (never a bucket two principals share). */
function streamOwner(req: IncomingMessage, who: NonNullable<Who>): string {
  if (who.kind === 'session') return `session:${who.cookie}`;
  return `bearer:${createHash('sha256').update(String(req.headers.authorization ?? '')).digest('base64url')}`;
}

const PAGE_ROOTS = ['/app', '/events', '/setup', '/members', '/push', '/app.js', '/sw.js', '/manifest.webmanifest', '/icons', '/fonts', '/scope', '/places', '/find', '/login', '/logout', '/pieces.json', '/pieces', '/passkeys', '/inbox', '/activity', '/mind', '/people', '/memory', '/p', '/act', '/knowledge', '/a', '/new-agent', '/new-person', '/new-fact'];

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
  /** The household member an owner token digest belongs to (docs/specs/owners.md); none outside a household. */
  member?(digest: Buffer): Member | undefined;
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
/** A signed-in request, and the member it is (docs/specs/owners.md): from its session's token, or the bearer's. */
type Who = { kind: 'session'; cookie: string; member?: Member } | { kind: 'bearer'; member?: Member } | null;

function whoIs(req: IncomingMessage, opts: UiOptions): Who {
  if (!opts.auth.enabled) return null;
  const c = readCookie(req, COOKIE);
  if (c && validSession(c, opts)) {
    const s = storeFor(opts).get(c);
    return { kind: 'session', cookie: c, member: s ? opts.auth.member?.(s.secret) : undefined };
  }
  const header = req.headers['authorization'];
  const presented = header?.replace(/^Bearer\s+/i, '').trim();
  const d = presented ? opts.auth.check(presented) : null;
  if (d) return { kind: 'bearer', member: opts.auth.member?.(d) };
  return null;
}

/** The WebAuthn user a member's passkeys are made under. */
function passkeyUser(m: Member | undefined, first: boolean, rpId: string): { id: string; name: string; displayName: string } {
  const seed = !m || first ? `loom-owner|${rpId}` : `loom-member|${m.person}|${rpId}`;
  return { id: Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16)).toString('base64url'), name: m?.person ?? 'owner', displayName: 'loom' };
}

/** The caller a piece's page or action is told about: the member, and what they own. */
function callerOf(who: Who): ApiCaller | undefined {
  return who?.member ? { kind: 'owner', who: who.member.person, agents: who.member.agents } : undefined;
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

/**
 * A body in the best encoding the browser takes (br, else gzip), and the headers that say so. The app's built
 * files are compressed once, at their best, and kept (Jonathan, 2026-10-29: "this site is sloooow": its script
 * went out as 786 KB); a page's data is compressed quickly, when it's big enough to be worth it.
 */
const packed = new Map<string, { br: Buffer; gzip: Buffer }>();
// The first visit after a deploy shouldn't pay for packing the script (a second, at brotli's best): pack them at
// start, off the event loop (zlib's thread pool), so nothing waits on it.
setTimeout(() => {
  const dir = join(WEB_DIR, 'assets');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const file = join(dir, f);
    if (!/\.(js|css|svg|json)$/.test(f) || packed.has(file)) continue;
    const body = readFileSync(file);
    void Promise.all([
      brotliAsync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } }),
      gzipAsync(body, { level: 9 }),
    ]).then(([br, gzip]) => { if (!packed.has(file)) packed.set(file, { br, gzip }); }).catch(() => {});
  }
}, 1_000).unref();
function encoded(req: IncomingMessage, body: Buffer, keep?: string): { body: Buffer; headers: Record<string, string> } {
  const accepts = String(req.headers['accept-encoding'] ?? '');
  const br = /\bbr\b/.test(accepts), gz = /\bgzip\b/.test(accepts);
  if ((!br && !gz) || body.length < 1024) return { body, headers: { vary: 'accept-encoding' } };
  let both = keep ? packed.get(keep) : undefined;
  if (!both) {
    const quality = keep ? 11 : 4;
    const make = (which: 'br' | 'gzip') => (which === 'br'
      ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : gzipSync(body, { level: keep ? 9 : 6 }));
    if (!keep) { const which = br ? 'br' : 'gzip'; return { body: make(which), headers: { 'content-encoding': which, vary: 'accept-encoding' } }; }
    both = { br: make('br'), gzip: make('gzip') };
    packed.set(keep, both);
  }
  return br ? { body: both.br, headers: { 'content-encoding': 'br', vary: 'accept-encoding' } } : { body: both.gzip, headers: { 'content-encoding': 'gzip', vary: 'accept-encoding' } };
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

/** undo: posted to `act` with `path` to land on: where the action came from (the app's toast offers it). */
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

/** On the household's pages: a tab that isn't only each agent's. */
function householdTab(p: PieceInfo): boolean {
  return hasPages(p) && p.manifest.tab?.level !== 'agent';
}

/** The tab a piece puts on each agent's own pages, if any: agentTab, or a tab whose level is 'agent'. */
function agentTabOf(p: PieceInfo): { label: string } | undefined {
  if (p.manifest.agentTab) return p.manifest.agentTab;
  return p.manifest.tab?.level === 'agent' ? { label: p.manifest.tab.label } : undefined;
}

/** A piece's pages as one agent's: links and actions stay under /a/<agent>/. */
const agentPieceSource = (agent: string, piece: string): Source => ({ id: piece, base: `/a/${agent}/p/${piece}/`, act: `/a/${agent}/act/${piece}` });

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

function agentTabs(agent: string, current: string, pieces: PieceInfo[] = []): AgentHead['tabs'] {
  // People are the household's (the nav has them), so an agent's own pages are its day, its mind and how it runs,
  // then each piece's tab for it (its clock, its bridges), before Setup.
  const own = pieces.flatMap((p) => { const t = agentTabOf(p); return t ? [[t.label, `p/${p.piece}`]] : []; })
    .sort((a, b) => a[0].localeCompare(b[0]));
  return [['Today', ''], ['Mind', 'mind'], ...own, ['Setup', 'setup']].map(([label, tab]) => ({ label, href: tab ? `/a/${agent}/${tab}` : `/a/${agent}`, current: tab === current }));
}

/** Your call, everywhere: the household's proposals and every piece's asks (or a lone agent's). For the push watch. */
export async function yourCall(opts: UiOptions): Promise<HomeAsk[]> {
  const { pieces } = await pieceManifests(opts.env);
  const hh = opts.household?.();
  const needs = (a: HomeAsk) => a.attention !== false;
  if (hh) return [...proposalAsks(hh, Object.fromEntries(hh.agents.map((a) => [a, pendingProposals(hh, a)]))), ...pieceAsks(pieces, opts.env)].filter(needs);
  return pieceAsks(pieces, opts.env).filter(needs);
}

/** One minute's push watch (push.ts): one of loom's listeners announces what's new in Your call. */
export async function pushWatch(opts: UiOptions): Promise<number> {
  const subject = opts.env.LOOM_PUBLIC_URL?.startsWith('https://') ? opts.env.LOOM_PUBLIC_URL : 'mailto:loom@localhost';
  const hh = opts.household?.();
  // Asks an agent owner may hear of: loom's own, or a piece's that understands agent owners (owners: 2).
  const ownersOk = new Set((await pieceManifests(opts.env)).pieces.filter((p) => p.manifest.owners === 2).map((p) => pieceSource(p.piece).id));
  // A device hears only of its member's agents; a household ask, only household owners (docs/specs/owners.md).
  const hears = (member: string | undefined, a: { agent?: string; open?: boolean }) => {
    const m = hh ? (member === undefined ? firstOwner(hh) : memberOf(hh, member)) : undefined;
    if (!hh) return true;
    if (!m) return false;
    return m.agents === '*' || (a.open === true && a.agent !== undefined && m.agents.includes(a.agent));
  };
  return watch(storeFor(opts), async () => (await yourCall(opts)).map((a) => ({
    key: askKey(a), title: `Your call · ${a.sourceLabel ?? a.source.id}`, body: a.text, ...(a.agent ? { agent: a.agent } : {}),
    open: a.source.id === CORE.id || ownersOk.has(a.source.id),
  })), subject, undefined, hears);
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

/**
 * Each agent's card: the worst state any piece reports for it (and that piece's reason), every piece's readings,
 * and what loom itself knows: when it was last on the tape, and where.
 */
function agentCards(h: Household, pieces: PieceInfo[], marks: Record<string, { label: string; bg: string; fg: string }>, nowMs: number): AgentCard[] {
  const rank: Record<AgentState, number> = { broken: 3, unavailable: 2, working: 1, available: 0 };
  return h.agents.map((a) => {
    const reports = pieces.flatMap((p) => (p.manifest.agents?.[a] ? [{ p, r: p.manifest.agents[a] }] : []));
    const worst = reports.filter((x) => x.r.state).sort((x, y) => rank[y.r.state!] - rank[x.r.state!])[0];
    const last = tapeRows(agentDir(h, a), 72, nowMs)[0];
    const lastLine = last ? `Last: ${last.title}` : 'Quiet for three days';
    const readings = reports.flatMap((x) => x.r.readings.map((r) => ({ ...r, source: pieceSource(x.p.piece) })));
    if (last) readings.push({ label: 'Last seen', value: `${age(last.created, nowMs)} ago`, detail: whereLabel(last.where), source: agentSource(a), page: '' });
    return { id: a, ...marks[a], state: worst?.r.state ?? 'available', reason: worst?.r.reason ?? lastLine, readings: readings.slice(0, 6) };
  });
}

/** Everything the Inbox files: the asks (loom's and every piece's), the pieces' notices and what they've answered, newest first. */
function inboxItems(h: Household, pieces: PieceInfo[], env: NodeJS.ProcessEnv): InboxItem[] {
  const asks = [...proposalAsks(h, Object.fromEntries(h.agents.map((a) => [a, pendingProposals(h, a)]))), ...pieceAsks(pieces, env)];
  const items: InboxItem[] = [
    ...asks.map((a): InboxItem => ({ key: askKey(a), kind: a.kind ?? 'decision', attention: a.attention !== false, unread: false,
      text: a.text, meta: a.meta, at: a.at, expires: a.expires, agent: a.agent, source: a.source, sourceLabel: a.sourceLabel, page: a.page, label: a.label, actions: a.actions })),
    ...pieces.flatMap((p) => {
      const source = pieceSource(p.piece);
      const sourceLabel = p.manifest.tab?.label ?? p.piece;
      return [
        ...(p.manifest.notices ?? []).map((n): InboxItem => ({ key: askKey({ source, text: n.text, page: `fyi:${n.at}` }), kind: 'fyi', attention: false, unread: false,
          text: n.text, meta: n.meta, at: n.at, agent: n.agent, source, sourceLabel, page: n.page })),
        ...(p.manifest.answered ?? []).map((a): InboxItem => ({ key: askKey({ source, text: a.text, page: `answered:${a.at}` }), kind: 'answered', attention: false, unread: false,
          text: a.text, outcome: a.outcome, at: a.at, agent: a.agent, source, sourceLabel, page: a.page })),
      ];
    }),
  ];
  // Newest first; an ask with no time stays where its piece put it, ahead of the dated ones.
  const t = (it: InboxItem) => (it.at ? Date.parse(it.at) : Number.POSITIVE_INFINITY);
  return items.map((it, i) => ({ it, i })).sort((x, y) => t(y.it) - t(x.it) || x.i - y.i).map((x) => x.it);
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
  // Knowledge and People are the household's: an agent owner's Find searches their agents' memories only.
  found.knowledge = opts.ownerScope ? [] : f.knowledge.map((k) => ({ label: k.title, href: `/knowledge/${k.slug}` }));
  found.people = opts.ownerScope ? [] : f.people.map((p) => ({ label: p.name, href: `/people/${p.slug}` }));
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
/**
 * Whose pages these are: the household's, always, unless the address is an agent's own (/a/<id>).
 * There's no picker any more (t-1625): the loom's pages are the household's, an agent's are under /a/.
 * An old loom_scope cookie is ignored (and /scope/<id> clears it).
 */
function scopeOf(_req: IncomingMessage, _h: Household | undefined): string {
  return 'household';
}

function chrome(req: IncomingMessage, opts: UiOptions, pieces: PieceInfo[], skipped: string[], current: string, csrf: string, flash?: Flash): Chrome {
  const tabs = pieces.filter(householdTab)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, piece: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const kinds = catalogKinds();
  const places = pieces.filter(householdTab)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, tone: p.manifest.tile?.tone, stat: p.manifest.tile?.value,
      kind: p.manifest.tab?.kind ?? kinds[p.piece] ?? 'place' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const asks = pieces.reduce((n, p) => n + p.manifest.asks.length, 0) + piecesAsks(opts.env).length;
  // The Inbox's count: what needs the owner (an ask that says nothing waits on it is filed, not counted).
  const needs = pieces.reduce((n, p) => n + p.manifest.asks.filter((a) => a.attention !== false).length, 0) + piecesAsks(opts.env).length;
  const tab = current === '' ? 'home' : current === 'places' || current === 'scope' || current === 'find' || current === 'setup' ? current : '';
  const h = opts.household?.();
  const back = backFor(new URL(req.url ?? '/', 'http://loom.invalid').pathname, places, h);
  if (h) {
    const marks = agentMarks(h);
    const scope = /^a\/([^/]+)/.exec(current)?.[1] ?? scopeOf(req, h);
    return {
      agent: h.owner ? `${h.owner}'s household` : 'household',
      nav: [
        { label: 'Home', href: '/', current: current === '', piece: false },
        // Knowledge, People and Pieces are the household's: not an agent owner's (docs/specs/owners.md).
        ...(opts.ownerScope ? [] : [
          { label: 'Knowledge', href: '/knowledge', current: current === 'knowledge', piece: false },
          { label: 'People', href: '/people', current: current === 'people', piece: false },
          { label: 'Pieces', href: '/pieces', current: current === 'pieces', piece: false },
        ]),
        ...h.agents.map((a) => ({ label: agentName(agentDir(h, a)), href: `/a/${a}`, current: current === `a/${a}`, piece: true })),
        ...tabs,
      ],
      clock: clock(),
      csrf,
      flash,
      skipped,
      shell: {
        owner: opts.viewer ?? h.owner ?? 'owner', scope, household: true, asks, tab, back, admin: !opts.ownerScope,
        home: '/',
        agents: h.agents.map((a) => ({ id: a, label: agentName(agentDir(h, a)), ...marks[a], href: `/a/${a}`, current: scope === a,
          asks: pendingProposals(h, a) + pieces.reduce((n, p) => n + p.manifest.asks.filter((x) => x.agent === a).length, 0),
          sub: lastActive(agentDir(h, a)) })),
        core: [
          // Memory proposals are one ask an agent (proposalAsks), like the Inbox shows them.
          { label: 'Activity', href: '/activity', current: current === 'activity' },
          { label: 'Inbox', href: '/inbox', current: current === 'inbox', count: needs + h.agents.filter((a) => pendingProposals(h, a) > 0).length },
          ...(opts.ownerScope ? [] : [
            { label: 'Knowledge', href: '/knowledge', current: current.startsWith('knowledge') },
            { label: 'People', href: '/people', current: current.startsWith('people') },
          ]),
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
  // Answered from the Inbox: back to the Inbox, whatever page the action would show next.
  if (splitPage(back)?.core && splitPage(back)?.path === 'inbox') return pageHref(back, source);
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
  // The app (docs/specs/ui-app.md): its built files, public like /app.js (no data in them).
  if (pathname.startsWith('/app/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
    const file = webFile(pathname.slice('/app/'.length));
    if (!file) return send(res, 404, 'text/plain', 'not found');
    const immutable = pathname.startsWith('/app/assets/');
    const type = WEB_TYPES[extname(file)] ?? 'application/octet-stream';
    // Fonts and images are compressed already; the script and the stylesheet are text, packed once (their names change with them).
    const out = /^(text|application\/(javascript|json))|svg/.test(type) ? encoded(req, readFileSync(file), immutable ? file : undefined) : { body: readFileSync(file), headers: {} };
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...out.headers });
    return void res.end(req.method === 'HEAD' ? undefined : out.body);
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
  // An agent owner (docs/specs/owners.md): from here on, the household is theirs alone and the
  // pieces are the ones that understand them. The household's own pages are refused.
  const full = opts.household?.();
  // The account menu names who's signed in; the first household owner keeps the household's name for them.
  if (full && who?.member && who.member.person !== firstOwner(full).person) opts = { ...opts, viewer: who.member.person };
  if (full && who?.member && who.member.agents !== '*') {
    const own = who.member.agents;
    if (!scopedPathOk(pathname)) return send(res, 403, 'text/plain', 'That page is the household\'s: ask a household owner.');
    const base = opts.household!;
    opts = { ...opts, household: () => narrowed(base(), own), ownerScope: own, env: { ...opts.env, LOOM_OWNER_SCOPE: own.join(',') } };
  }
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
    // And the copies of pages this browser kept for offline (https only; the sign-in page's /app.js also asks the worker).
    return redirect(res, '/login', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, 'clear-site-data': '"cache", "storage"' });
  }

  if (!who) {
    if (pathname.endsWith('.json')) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    if (req.method === 'GET') return redirect(res, '/login');
    return send(res, 401, 'text/plain', 'unauthorized');
  }

  const url = new URL(req.url ?? pathname, 'http://loom.invalid');

  // The app's live stream (src/ui/live.ts): "something changed", and nothing else.
  if (pathname === '/events') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
    const hh = opts.household?.();
    const home = hh?.home ?? opts.contextDir;
    // Whose a changed file is: under an agent's folder, that agent's; anything else, the household's.
    const place = (file: string): Sees => {
      const h = opts.household?.();
      if (!h) return '*';
      const abs = join(home, file);
      const a = h.agents.find((x) => abs.startsWith(agentDir(h, x) + sep));
      return a ? [a] : '*';
    };
    return openStream(res, scopedEnv, home, SECURITY_HEADERS, { sees: opts.ownerScope ?? '*', session: streamOwner(req, who), place });
  }

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
    else storeFor(opts).addPushSub(who.cookie, sub, undefined, readerFor(opts, who));
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
        // One user per member (docs/specs/owners.md): a stable id that says nothing. The first household
        // owner keeps the household's old id, so the passkeys made before members stay theirs.
        user: passkeyUser(who.member, !!who.member && opts.household !== undefined && firstOwner(opts.household()).person === who.member.person, rp.rpId),
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
  const agentAct = hh ? /^\/a\/([a-z][a-z0-9-]{0,39})\/act\/(loom|[a-z][a-z0-9-]{0,39})$/.exec(pathname) : null;
  if (pathname.startsWith('/act/') || agentAct) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    if (agentAct && !hh!.agents.includes(agentAct[1])) return send(res, 404, 'text/plain', 'not found');
    const sourceId = agentAct ? agentAct[2] : pathname.slice('/act/'.length);
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
    if (agentAct && agentAct[2] !== 'loom') {
      // A piece's action from its tab on this agent's pages: called with LOOM_SCOPE=<agent>, landing back there.
      const pieces = forOwner((await pieceManifests(scopedEnv)).pieces, opts.ownerScope);
      const info = pieces.find((p) => p.piece === agentAct[2] && agentTabOf(p));
      if (!info) return send(res, 404, 'text/plain', 'not found');
      source = agentPieceSource(agentAct[1], info.piece);
      const sp = splitPage(backLink);
      const path = sp && !sp.core ? sp.path : '';
      result = await pieceAct(info, { action, path, fields }, scopedEnv, callerOf(who));
    } else if (agentAct) {
      // One agent's own actions (archive, ratify, reject), on its stack.
      source = agentSource(agentAct[1]);
      result = await coreAct(agentDir(hh!, agentAct[1]), action, fields);
    } else if (opts.ownerScope && sourceId === 'loom' && action !== 'passkey-remove' && action !== 'signin-link') {
      // An agent owner's core actions are their agents' own (/a/<agent>/act/loom); the household's are refused.
      source = CORE;
      result = { ok: false, message: 'That\'s the household\'s to do: ask a household owner.' };
    } else if (sourceId === 'loom' && action === 'passkey-remove') {
      source = CORE;
      const own = opts.ownerScope && who?.member ? passkeysOf(opts, who.member) : undefined;
      result = (!own || own.some((k) => k.id === fields.id)) && storeFor(opts).removePasskey(fields.id ?? '')
        ? { ok: true, message: 'Removed. That device can\'t sign in with it any more.', page: 'loom:passkeys' }
        : { ok: false, message: 'No such passkey.', page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'signin-link' && hh) {
      source = CORE;
      const base = (opts.env.LOOM_PUBLIC_URL ?? '').replace(/\/+$/, '');
      // A household session always is a member; one that isn't gets no link, rather than the first owner's.
      result = who?.member
        ? { ok: true, keep: true, page: 'loom:passkeys', message: `One sign-in, within 10 minutes: ${base}/login/${signinLink(hh, 600, who.member.person)}` }
        : { ok: false, message: 'This session isn\'t a member of the household; sign in again.', page: 'loom:passkeys' };
    } else if (sourceId === 'loom' && action === 'member-link' && hh) {
      // A household owner makes a sign-in link for a member (Members): it opens a session as them.
      source = CORE;
      const base = (opts.env.LOOM_PUBLIC_URL ?? '').replace(/\/+$/, '');
      const m = memberOf(hh, fields.person);
      result = m
        ? { ok: true, keep: true, page: 'loom:members', message: `For ${m.person}, one sign-in within 10 minutes: ${base}/login/${signinLink(hh, 600, m.person)}` }
        : { ok: false, message: 'No such member.', page: 'loom:members' };
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
      const pieces = forOwner((await pieceManifests(scopedEnv)).pieces, opts.ownerScope);
      const info = pieces.find((p) => p.piece === sourceId);
      if (!info) return send(res, 404, 'text/plain', 'not found');
      source = pieceSource(info.piece);
      const sp = splitPage(backLink);
      const path = sp && !sp.core ? sp.path : '';
      result = await pieceAct(info, { action, path, fields }, scopedEnv, callerOf(who));
    }
    changed(opts.ownerScope ?? '*');   // whatever it did, the open apps that may see it look again
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
    const m0 = await pieceManifests(scopedEnv);
    const m = { ...m0, pieces: forOwner(m0.pieces, opts.ownerScope) };
    return send(res, 200, 'application/json', JSON.stringify({
      agent: agentName(opts.contextDir),
      pieces: m.pieces.map((p) => ({ piece: p.piece, manifest: p.manifest })),
      skipped: m.skipped,
    }));
  }
  const pick = /^\/scope\/([a-z][a-z0-9-]{0,39}|household)$/.exec(pathname);
  if (pick) {
    const hh2 = opts.household?.();
    const id = pick[1] === 'household' || !hh2?.agents.includes(pick[1]) ? 'household' : pick[1];
    // No scope to choose any more: an old link goes to the agent's own pages, and the old cookie goes.
    res.writeHead(303, { location: id === 'household' ? '/' : `/a/${id}`, 'set-cookie': `${SCOPE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`, ...SECURITY_HEADERS });
    return void res.end();
  }
  const query = pageQuery(url);
  const asJson = /^application\/json\b/.test(String(req.headers.accept ?? ''));
  // Every page is the app (web/, docs/specs/ui-app.md; the old HTML renderer went 2026-10-29, Jonathan: "let's just
  // remove classic entirely"). A browser loads the app's one page at any path, and the app asks the same path for the
  // page's data as JSON: the same auth, scoping and CSRF answer both. Only the sign-in pages are still loom's HTML.
  // The page load returns before anything is read or spent: a one-time message (?_flash=) is the JSON's to take.
  const app = (status = 200) => {
    const shell = webFile('index.html');
    if (!shell) return send(res, 503, 'text/plain; charset=utf-8', 'loom\'s app isn\'t built here (npm run build:web).');
    return send(res, status, 'text/html; charset=utf-8', readFileSync(shell, 'utf-8'), { 'cache-control': 'no-cache' });
  };
  if (req.method === 'GET' && !asJson) return app();
  const flash = takeFlash(url.searchParams.get('_flash'));
  const { pieces: allPieces, skipped } = await pieceManifests(scopedEnv);
  const pieces = forOwner(allPieces, opts.ownerScope);
  const skippedNames = skipped.map((s) => s.piece);
  const view = (kind: string, data: Record<string, unknown>, status = 200) => {
    if (!asJson) return app(status);
    const text = JSON.stringify({ view: kind, ...data });
    // The data's fingerprint (without the clock it was drawn at): an app that already has this answer gets a 304.
    const etag = `W/"${createHash('sha256').update(JSON.stringify({ view: kind, ...data, now: undefined })).digest('base64url').slice(0, 22)}"`;
    if (status === 200 && String(req.headers['if-none-match'] ?? '') === etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, etag, vary: 'accept-encoding' });
      return void res.end();
    }
    const out = encoded(req, Buffer.from(text));
    res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS, etag, ...out.headers });
    res.end(out.body);
  };

  // The shell's sheets (Scope, Places, Find, Setup): the app draws them as pages.
  if (pathname === '/scope' || pathname === '/places' || pathname === '/find' || pathname === '/setup') {
    const tab = pathname.slice(1);
    const ch = chrome(req, opts, pieces, skippedNames, tab, csrf, flash);
    const q = (url.searchParams.get('q') ?? '').slice(0, 100);
    { const which = tab as 'scope' | 'places' | 'find' | 'setup'; const found = tab === 'find' && q.trim() ? findAll(q.trim(), req, opts, pieces) : undefined;
      return view('sheet', { which, chrome: ch, q, found }); }
  }

  if (pathname === '/passkeys') {
    const tz = uiTimeZone();
    const when = (s?: number) => (s ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s * 1000)) : 'never');
    // An agent owner sees their own passkeys; a household owner, every one.
    const keys = opts.ownerScope && who?.member ? passkeysOf(opts, who.member) : storeFor(opts).passkeys();
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
    // The app draws the list, and adds loom's own "add a passkey" control (WebAuthn) and the push switch beside it.
    return view('passkeys', { page, ctx: { source: CORE, path: 'passkeys', query, csrf }, chrome: ch, add });
  }

  if (hh) {
    const hhAgents = agentsOf(hh);
    const ctxOf = (path: string, source: Source = CORE) => ({ source, path, query, csrf, agents: hhAgents });
    const send200 = (page: import('./vocab.js').Page, current: string, ctx: ReturnType<typeof ctxOf>, head?: AgentHead) =>
      { const ch = chrome(req, opts, pieces, skippedNames, current, csrf, flash);
        return view('page', { page, ctx, chrome: ch, head }, page.title === 'Not found' && page.sections.length === 0 ? 404 : 200); }
    if (pathname === '/') {
      const nowMs = Date.now();
      const agents = agentsOf(hh)!;
      const waiting = inboxItems(hh, pieces, opts.env).filter((it) => it.attention);
      const cards = agentCards(hh, pieces, agents, nowMs);
      const down = (st: AgentState) => cards.filter((c) => c.state === st).map((c) => c.label);
      const say = (names: string[], what: string) => `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} ${what}`;
      const broken = down('broken');
      const out = down('unavailable');
      const headline = broken.length ? say(broken, 'broken') : out.length ? say(out, 'unavailable') : 'Everyone\u2019s fine';
      const moving = pieces.flatMap((p) => Object.entries(p.manifest.agents ?? {}).filter(([a, r]) => hh.agents.includes(a) && r.state === 'working')
        .map(([a, r]) => ({ agent: a, text: r.reason ?? `${agents[a].label} is working`, meta: p.manifest.tab?.label ?? p.piece })));
      const d: HouseHome = {
        headline, needs: waiting.length, firstNeed: waiting[0]?.text, cards, moving,
        // Home is the agents and what's moving (Jonathan, 2026-10-27): the pieces' tiles live on their own pages.
        firstRun: pieces.length ? undefined : firstRun(hh.agents.map((a) => agents[a].label)),
      };
      { const ctx = { ...ctxOf(''), agents }; const ch = chrome(req, opts, pieces, skippedNames, '', csrf, flash);
        return view('house-home', { home: d, ctx, chrome: ch }); }
    }
    // Activity: everything that happened (the household's thread), what Home was before it showed how the agents are.
    if (pathname === '/activity') {
      const at = 'activity';
      const nowMs = Date.now();
      const store = storeFor(opts);
      const reader = readerFor(opts, who);
      const sinceMs = (req.headers['x-loom-live'] === '1' ? store.seenSince(Math.floor(nowMs / 1000), reader) : store.lookedAt(Math.floor(nowMs / 1000), reader)) * 1000;
      const t = householdThread(hh, 24, nowMs);
      // Thread chips: All, each agent (when there's more than one), then each place it happened.
      // A row with no where ("?") is under All only: a pill for it says nothing.
      const surfaces = [...new Set(t.items.map((r) => surfaceOf(r.where)))].filter((w) => w !== '?').sort();
      const from = query.who && (hh.agents.includes(query.who) || surfaces.includes(query.who)) ? query.who : '';
      const agents = agentsOf(hh)!;
      const chips = [...(hh.agents.length > 1 ? hh.agents.map((a) => ({ value: a, label: agents[a].label })) : []),
        ...(surfaces.length > 1 ? surfaces.filter((s) => !hh.agents.includes(s)).map((s) => ({ value: s, label: whereLabel(s) })) : [])];
      // Activity is the thread, and the house's tiles beside it: what Home was before it showed how the agents are.
      const d: Dashboard = {
        label: 'Activity',
        title: 'Everything today',
        asks: [],
        tiles: pieces.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) })),
        thread: t.items.filter((r) => !from || r.agent === from || surfaceOf(r.where) === from).slice(0, HOME_THREAD)
          .map((r) => ({ agent: r.agent, text: r.text, meta: [whereLabel(r.where), age(r.created, nowMs)].filter(Boolean).join(' · '), at: r.created, page: r.page })),
        sinceMs, sinceLabel: clockAt(sinceMs),
        filters: chips.length ? { param: 'who', current: from, options: [{ value: '', label: 'All' }, ...chips] } : undefined,
      };
      { const ctx = { ...ctxOf(at), agents }; const ch = chrome(req, opts, pieces, skippedNames, at, csrf, flash);
        return view('dashboard', { dashboard: d, ctx, chrome: ch, now: nowMs }); }
    }
    if (pathname === '/inbox') {
      const nowMs = Date.now();
      const store = storeFor(opts);
      const items = inboxItems(hh, pieces, opts.env);
      const folder = (INBOX_FOLDERS.find((f) => f.id === query.f)?.id ?? 'needs') as InboxFolder;
      const open = query.i && /^[0-9a-f]{16}$/.test(query.i) ? items.find((it) => it.key === query.i) : undefined;
      // Opening an attention item reads it; nothing else is ever unread.
      const reader = readerFor(opts, who);
      if (open?.attention) store.markOpened(open.key, Math.floor(nowMs / 1000), reader);
      const opened = store.openedKeys(reader);
      for (const it of items) it.unread = it.attention && !opened.has(it.key);
      // The open item's own page (a task's, for a task), drawn in the Inbox: only a piece's ask that links to
      // one of its pages (not its main page) and has no buttons of its own.
      // The open item as the page draws it: the one asked for when it's in this folder, else the folder's first.
      const here = items.filter((it) => inFolder(folder, it));
      const shown = here.find((it) => it.key === open?.key) ?? here[0];
      let inline: { key: string; sections: Section[] } | undefined;
      const info = shown && !shown.actions?.length && shown.kind !== 'answered' && shown.page ? pieces.find((p) => pieceSource(p.piece).id === shown.source.id && hasPages(p)) : undefined;
      const sp = info ? splitPage(shown!.page!) : null;
      if (info && sp && !sp.core && sp.path !== '') {
        const pg = await piecePage(info, sp.path, sp.query, scopedEnv, callerOf(who));
        if (typeof pg !== 'string') inline = { key: shown!.key, sections: pg.sections };
      }
      const ch = chrome(req, opts, pieces, skippedNames, 'inbox', csrf, flash);
      // An item open: on a phone it's its own screen, and the bar's back goes to its folder.
      if (open && shown?.key === open.key && ch.shell) {
        ch.shell.back = { label: INBOX_FOLDERS.find((f) => f.id === folder)!.label, href: folder === 'needs' ? '/inbox' : `/inbox?f=${folder}` };
      }
      { const ctx = { ...ctxOf('inbox'), agents: agentsOf(hh)! };
        return view('inbox', { items, folder, open: open?.key, ctx, chrome: ch, now: nowMs, inline }); }
    }
    if (pathname === '/knowledge') return send200(knowledgePage(hh, query), 'knowledge', ctxOf('knowledge'));
    if (pathname.startsWith('/knowledge/')) {
      const slug = decode(pathname.slice('/knowledge/'.length));
      return send200(slug && validPath(slug) ? knowledgeEntry(hh, slug) : notFound, 'knowledge', ctxOf('knowledge'));
    }
    if (pathname === '/people') return send200(householdPeople(hh, query), 'people', ctxOf('people'));
    if (pathname === '/pieces') return send200(piecesPage(opts.env, query), 'pieces', ctxOf('pieces'));
    if (pathname.startsWith('/people/')) {
      const slug = decode(pathname.slice('/people/'.length));
      return send200(slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? householdPerson(hh, slug) : notFound, 'people', ctxOf(`people/${slug}`));
    }
    if (pathname === '/members') return send200(householdMembers(hh), 'members', ctxOf('members'));
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
          agent: { ...agents[agent], sub: `${t.items.length} today · ${t.memories[agent].toLocaleString('en-US')} memories`, tabs: agentTabs(agent, '', pieces) },
          asks: [...proposalAsks({ ...hh, agents: [agent] }, t.proposals), ...pieceAsks(pieces, opts.env).filter((a) => a.agent === agent || (!a.agent && scoped.some((p) => p.piece === a.source.id)))],
          tiles: [{ label: 'Memories', value: t.memories[agent].toLocaleString('en-US'), page: 'mind', source: src },
            ...scoped.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) }))],
          thread: t.items.slice(0, HOME_THREAD).map((r) => ({ text: r.text, meta: [whereLabel(r.where), age(r.created, nowMs)].filter(Boolean).join(' · '), at: r.created, page: r.page })),
        };
        { const ctx = { ...ctxOf('', src), agents }; const ch = chrome(req, opts, pieces, skippedNames, `a/${agent}`, csrf, flash);
          return view('dashboard', { dashboard: d, ctx, chrome: ch, now: nowMs }); }
      }
      // Its Mind, People and Setup wear its head and tabs, like Today; a page under them keeps its own title.
      const head = (tab: string): AgentHead => ({ ...agentsOf(hh)![agent], tabs: agentTabs(agent, tab, pieces) });
      // A piece's tab for this agent: its pages, called with LOOM_SCOPE=<agent>, links and actions kept here.
      const pp = /^p\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(rest);
      if (pp) {
        const info = pieces.find((p) => p.piece === pp[1] && agentTabOf(p));
        const path = pp[2] ?? '';
        const asrc = agentPieceSource(agent, pp[1]);
        if (!info || !validPath(path)) return send200(notFound, `a/${agent}`, ctxOf('', asrc), head(`p/${pp[1]}`));
        const pg = await piecePage(info, path, query, scopedEnv, callerOf(who));
        if (typeof pg === 'string') {
          return send200({ title: agentTabOf(info)!.label, sections: [{ id: 'error', blocks: [{ type: 'callout', tone: 'bad', text: `${pp[1]} couldn't show this page (${pg}).` }] }] },
            `a/${agent}`, ctxOf(path, asrc), head(`p/${pp[1]}`));
        }
        return send200(pg, `a/${agent}`, ctxOf(path, asrc), head(`p/${pp[1]}`));
      }
      if (rest === 'setup') return send200(agentSetup(hh, agent, { ownerTokens: !opts.ownerScope }), `a/${agent}`, ctxOf(`a/${agent}/setup`, CORE), head('setup'));
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
    { const ctx = { source: CORE, path: '', query, csrf }; const ch = chrome(req, opts, pieces, skippedNames, '', csrf, flash);
      return view('home', { page: home.page, ctx, chrome: ch, tiles, asks }); }
  }

  if (pathname.startsWith('/p/')) {
    const rest = pathname.slice('/p/'.length);
    const slash = rest.indexOf('/');
    const piece = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : decode(rest.slice(slash + 1));
    const info = pieces.find((p) => p.piece === piece && hasPages(p));
    const ch = chrome(req, opts, pieces, skippedNames, `p/${piece}`, csrf, flash);
    if (!info || path === null || !validPath(path)) { const ctx = { source: pieceSource(piece), path: '', query: {}, csrf }; return view('page', { page: notFound, ctx, chrome: ch }, 404); }
    const page = await piecePage(info, path, query, scopedEnv, callerOf(who));
    const ctx = { source: pieceSource(piece), path, query, csrf, agents: agentsOf(hhScope) };
    if (typeof page === 'string') {
      { const err = { title: info.manifest.tab?.label ?? piece, sections: [{ id: 'error', blocks: [{ type: 'callout' as const, tone: 'bad' as const, text: `${piece} couldn't show this page (${page}).` }] }] };
        return view('page', { page: err, ctx, chrome: ch }, 502); }
    }
    // A piece that can't narrow to the selected agent says so, once, at the top.
    const unscoped = scopedEnv.LOOM_SCOPE && !info.manifest.scope ? agentName(agentDir(hhScope!, scopedEnv.LOOM_SCOPE)) : undefined;
    return view('page', { page, ctx, chrome: ch, unscoped }, page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
  }

  if (pathname === '/pieces') {
    const page = piecesPage(opts.env, query);
    { const ctx = { source: CORE, path: 'pieces', query, csrf }; const ch = chrome(req, opts, pieces, skippedNames, 'pieces', csrf, flash);
      return view('page', { page, ctx, chrome: ch }); }
  }

  const path = decode(pathname.slice(1)) ?? '\0';
  const top = path.split('/')[0];
  const ch = chrome(req, opts, pieces, skippedNames, top, csrf, flash);
  const page = validPath(path) ? corePage(opts.contextDir, path, query) : null;
  const ctx = { source: CORE, path: validPath(path) ? path : '', query, csrf };
  if (!page) return view('page', { page: notFound, ctx, chrome: ch }, 404);
  return view('page', { page, ctx, chrome: ch }, page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
}
