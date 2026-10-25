/**
 * loom's web UI on the HTTP daemon (full scope only).
 *
 *   GET  /                         Home: the tape, tiles, "Your call"
 *   GET  /mind, /people[/<slug>], /memory/<ref>   loom's own pages
 *   GET  /p/<piece>[/<path>]       a piece's page
 *   GET  /pieces.json              the installed pieces' manifests, for scripts
 *   POST /act/<source>             an action (source = loom or a piece)
 *   GET/POST /login, POST /logout
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
import { sessionStore } from './sessions.js';
import { checkBearer } from '../transport/guards.js';
import { agentName, coreAct, corePage, homePage, uiTimeZone } from './core.js';
import { agentSetup, householdAct, householdHome, householdPeople, householdPerson, knowledgeEntry, knowledgePage, newAgentPage } from './household-pages.js';
import { agentDir, type Household } from '../household.js';
import { pieceAct, pieceManifests, piecePage, type PieceInfo } from './pieces.js';
import { agentSource, CORE, pageHref, pieceSource, renderHome, renderLogin, renderLoginLink, renderPage, type Chrome, type HomeAsk, type HomeTile, type Source } from './render.js';
import { ID, LIMITS, QUERY_KEY, splitPage, validPath, type ActResult, type Page } from './vocab.js';

const COOKIE = 'loom_ui';
const LOGIN_MAX_BYTES = 4096;
const ACT_MAX_BYTES = 64 * 1024;
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const FLASH_TTL_MS = 60_000;
const FLASH_MAX = 200;
/** This process's cookie key. Never written anywhere: a restart means logging in again. */
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

const PAGE_ROOTS = ['/login', '/logout', '/pieces.json', '/mind', '/people', '/memory', '/p', '/act', '/knowledge', '/a', '/new-agent'];

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

function readForm(req: IncomingMessage, max: number): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (v: URLSearchParams | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (d: Buffer) => {
      if (done) return;
      bytes += d.length;
      if (bytes > max) { finish(null); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => finish(new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

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

interface Flash { ok: boolean; message: string; from?: string }
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

function chrome(opts: UiOptions, pieces: PieceInfo[], skipped: string[], current: string, csrf: string, flash?: Flash): Chrome {
  const tabs = pieces.filter(hasPages)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/p/${p.piece}`, current: current === `p/${p.piece}`, piece: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const h = opts.household?.();
  if (h) {
    return {
      agent: h.owner ? `${h.owner}'s household` : 'household',
      nav: [
        { label: 'Home', href: '/', current: current === '', piece: false },
        { label: 'Knowledge', href: '/knowledge', current: current === 'knowledge', piece: false },
        { label: 'People', href: '/people', current: current === 'people', piece: false },
        ...h.agents.map((a) => ({ label: agentName(agentDir(h, a)), href: `/a/${a}`, current: current === `a/${a}`, piece: true })),
        ...tabs,
      ],
      clock: clock(),
      csrf,
      flash,
      skipped,
    };
  }
  return {
    agent: agentName(opts.contextDir),
    nav: [
      { label: 'Home', href: '/', current: current === '', piece: false },
      { label: 'Mind', href: '/mind', current: current === 'mind', piece: false },
      { label: 'People', href: '/people', current: current === 'people', piece: false },
      ...tabs,
    ],
    clock: clock(),
    csrf,
    flash,
    skipped,
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

  if (pathname === '/login') {
    // Unauthenticated: the login page names no agent.
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLogin());
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const form = await readForm(req, LOGIN_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    const token = form.get('token')?.trim() ?? '';
    const match = token ? opts.auth.check(token) : null;
    if (!match) return send(res, 401, 'text/html; charset=utf-8', renderLogin('That token didn’t match.'));
    return redirect(res, '/', {
      'set-cookie': `${COOKIE}=${storeFor(opts).create(match)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }

  const who = whoIs(req, opts);
  const csrf = who?.kind === 'session' ? csrfFor(who.cookie, storeFor(opts).key) : '';

  if (pathname === '/logout') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    // Revoke it server-side, so a copy of the cookie stops working too.
    const c = readCookie(req, COOKIE);
    if (c && /^[0-9a-f]{64}$/.test(c)) storeFor(opts).delete(c);
    return redirect(res, '/login', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  if (!who) {
    if (pathname.endsWith('.json')) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    if (req.method === 'GET') return redirect(res, '/login');
    return send(res, 401, 'text/plain', 'unauthorized');
  }

  const url = new URL(req.url ?? pathname, 'http://loom.invalid');

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
    } else if (sourceId === 'loom' && hh) {
      // The household's: tokens and agents.
      source = CORE;
      result = await householdAct(hh, action, fields);
    } else if (sourceId === 'loom') {
      source = CORE;
      result = await coreAct(opts.contextDir, action, fields);
    } else {
      const { pieces } = await pieceManifests(opts.env);
      const info = pieces.find((p) => p.piece === sourceId);
      if (!info) return send(res, 404, 'text/plain', 'not found');
      source = pieceSource(info.piece);
      const path = splitPage(backLink)?.path ?? '';
      result = await pieceAct(info, { action, path, fields }, opts.env);
    }
    const to = landing(source, result, backLink);
    // A piece's message is labeled with the piece, so it can't pass as loom's.
    const from = source.id === 'loom' ? undefined : source.id;
    return redirect(res, withFlash(to, putFlash({ ok: result.ok, message: result.message, from })));
  }

  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
  if (!allowedGet(req)) return send(res, 403, 'text/plain', 'forbidden: loom\'s page can only be opened, not embedded or fetched from another site');
  if (pathname === '/pieces.json') {
    const m = await pieceManifests(opts.env);
    return send(res, 200, 'application/json', JSON.stringify({
      agent: agentName(opts.contextDir),
      pieces: m.pieces.map((p) => ({ piece: p.piece, manifest: p.manifest })),
      skipped: m.skipped,
    }));
  }
  const query = pageQuery(url);
  const flash = takeFlash(url.searchParams.get('_flash'));
  const { pieces, skipped } = await pieceManifests(opts.env);
  const skippedNames = skipped.map((s) => s.piece);
  const html = (body: string, status = 200) => send(res, status, 'text/html; charset=utf-8', body);

  if (hh) {
    const ctxOf = (path: string, source: Source = CORE) => ({ source, path, query, csrf });
    const send200 = (page: import('./vocab.js').Page, current: string, ctx: ReturnType<typeof ctxOf>) =>
      html(renderPage(page, ctx, chrome(opts, pieces, skippedNames, current, csrf, flash)), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
    if (pathname === '/') {
      const home = householdHome(hh);
      const tiles: HomeTile[] = [
        ...home.tiles.map((t) => ({ ...t, source: CORE })),
        ...pieces.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) })),
      ];
      const asks: HomeAsk[] = pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece) })));
      return html(renderHome(home.page, ctxOf(''), chrome(opts, pieces, skippedNames, '', csrf, flash), tiles, asks));
    }
    if (pathname === '/knowledge') return send200(knowledgePage(hh, query), 'knowledge', ctxOf('knowledge'));
    if (pathname.startsWith('/knowledge/')) {
      const slug = decode(pathname.slice('/knowledge/'.length));
      return send200(slug && validPath(slug) ? knowledgeEntry(hh, slug) : notFound, 'knowledge', ctxOf('knowledge'));
    }
    if (pathname === '/people') return send200(householdPeople(hh), 'people', ctxOf('people'));
    if (pathname.startsWith('/people/')) {
      const slug = decode(pathname.slice('/people/'.length));
      return send200(slug && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? householdPerson(hh, slug) : notFound, 'people', ctxOf(`people/${slug}`));
    }
    if (pathname === '/new-agent') return send200(newAgentPage(), '', ctxOf('new-agent'));
    const a = /^\/a\/([a-z][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(pathname);
    if (a) {
      const agent = a[1];
      if (!hh.agents.includes(agent)) return send200(notFound, '', ctxOf(''));
      const rest = decode(a[2] ?? '') ?? '\0';
      const dir = agentDir(hh, agent);
      const src = agentSource(agent);
      if (rest === '' ) {
        const home = homePage(dir, query);
        home.page.sections.unshift({ id: 'agent-nav', side: true, blocks: [{ type: 'list', items: [
          { text: 'Mind', meta: 'what it wakes up holding, and why', page: 'mind' },
          { text: 'People', meta: 'as it sees them', page: 'people' },
          { text: 'Setup', meta: 'identity, tokens, health', page: `loom:a/${agent}/setup` },
        ] }] });
        const tiles: HomeTile[] = [{ ...home.tile, source: src }];
        return html(renderHome(home.page, ctxOf('', src), chrome(opts, pieces, skippedNames, `a/${agent}`, csrf, flash), tiles, []));
      }
      if (rest === 'setup') return send200(agentSetup(hh, agent), `a/${agent}`, ctxOf(`a/${agent}/setup`, CORE));
      const page = validPath(rest) ? corePage(dir, rest, query) : null;
      return send200(page ?? notFound, `a/${agent}`, ctxOf(validPath(rest) ? rest : '', src));
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
    const asks: HomeAsk[] = pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece) })));
    return html(renderHome(home.page, { source: CORE, path: '', query, csrf }, chrome(opts, pieces, skippedNames, '', csrf, flash), tiles, asks));
  }

  if (pathname.startsWith('/p/')) {
    const rest = pathname.slice('/p/'.length);
    const slash = rest.indexOf('/');
    const piece = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : decode(rest.slice(slash + 1));
    const info = pieces.find((p) => p.piece === piece && hasPages(p));
    const ch = chrome(opts, pieces, skippedNames, `p/${piece}`, csrf, flash);
    if (!info || path === null || !validPath(path)) return html(renderPage(notFound, { source: pieceSource(piece), path: '', query: {}, csrf }, ch), 404);
    const page = await piecePage(info, path, query, opts.env);
    const ctx = { source: pieceSource(piece), path, query, csrf };
    if (typeof page === 'string') {
      return html(renderPage({ title: info.manifest.tab?.label ?? piece, sections: [{ id: 'error', blocks: [{ type: 'callout', tone: 'bad', text: `${piece} couldn't show this page (${page}).` }] }] }, ctx, ch), 502);
    }
    return html(renderPage(page, ctx, ch), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
  }

  const path = decode(pathname.slice(1)) ?? '\0';
  const top = path.split('/')[0];
  const ch = chrome(opts, pieces, skippedNames, top, csrf, flash);
  const page = validPath(path) ? corePage(opts.contextDir, path, query) : null;
  const ctx = { source: CORE, path: validPath(path) ? path : '', query, csrf };
  if (!page) return html(renderPage(notFound, ctx, ch), 404);
  return html(renderPage(page, ctx, ch), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
}
