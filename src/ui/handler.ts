/**
 * loom's web UI on the HTTP daemon (full scope only).
 *
 *   GET  /ui                       Home: the tape, tiles, "Your call"
 *   GET  /ui/mind, /ui/people[/<slug>], /ui/memory/<ref>   loom's own pages
 *   GET  /ui/p/<piece>[/<path>]    a piece's page
 *   GET  /ui/pieces.json           the installed pieces' manifests, for scripts
 *   POST /ui/act/<source>          an action (source = loom or a piece)
 *   GET/POST /ui/login, POST /ui/logout
 *
 * Auth follows the daemon's bearer token, and the UI needs one: a daemon with
 * no token serves no /ui (like /cli), because an open page would be readable
 * by any site that DNS-rebinds a name to the loopback address. A browser logs
 * in once by pasting the token. The cookie is `<issued-at>.<mac>`, a MAC under
 * a key this process made at start, over the issued-at time and a digest of
 * the token. It isn't the token and isn't derivable from it, so it can't be
 * replayed as a bearer or used to guess the token offline. It lasts 30 days,
 * or until the daemon restarts (log in again). Scripts can send the bearer
 * header instead.
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
import { checkBearer } from '../transport/guards.js';
import { agentName, coreAct, corePage, homePage, uiTimeZone } from './core.js';
import { pieceAct, pieceManifests, piecePage, type PieceInfo } from './pieces.js';
import { CORE, pieceSource, renderHome, renderLogin, renderPage, type Chrome, type HomeAsk, type HomeTile, type Source } from './render.js';
import { ID, LIMITS, QUERY_KEY, splitPage, validPath, type ActResult, type Page } from './vocab.js';

const COOKIE = 'loom_ui';
const LOGIN_MAX_BYTES = 4096;
const ACT_MAX_BYTES = 64 * 1024;
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const FLASH_TTL_MS = 60_000;
const FLASH_MAX = 200;
/** This process's cookie key. Never written anywhere: a restart means logging in again. */
const COOKIE_KEY = randomBytes(32);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export interface UiOptions {
  contextDir: string;
  /** Configured bearer secrets (the single token, or the token map's values). Empty = open. */
  secrets: string[];
  /** Env for piece discovery and piece processes (PATH decides which pieces exist). */
  env: NodeJS.ProcessEnv;
}

export function isUiPath(pathname: string): boolean {
  return pathname === '/ui' || pathname.startsWith('/ui/');
}

const digest = (s: string) => createHash('sha256').update(s).digest();

function mac(issuedAt: number, secret: string): string {
  return createHmac('sha256', COOKIE_KEY).update(`loom-ui-v2|${issuedAt}|`).update(digest(secret)).digest('hex');
}

function cookieValue(secret: string, issuedAt = Math.floor(Date.now() / 1000)): string {
  return `${issuedAt}.${mac(issuedAt, secret)}`;
}

/** The anti-forgery token for a session: bound to its cookie, useless without it. */
function csrfFor(cookie: string): string {
  return createHmac('sha256', COOKIE_KEY).update(`loom-ui-csrf|${cookie}`).digest('hex');
}

/** Equal-length digests, so neither the content nor the length of a guess leaks. */
function safeEq(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function validCookie(value: string, secrets: string[], nowS = Math.floor(Date.now() / 1000)): boolean {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  if (issuedAt > nowS + 60 || nowS - issuedAt > COOKIE_MAX_AGE_S) return false;
  return secrets.some((s) => safeEq(m[2], mac(issuedAt, s)));
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
  if (opts.secrets.length === 0) return null;
  const c = readCookie(req, COOKIE);
  if (c && validCookie(c, opts.secrets)) return { kind: 'session', cookie: c };
  const header = req.headers['authorization'];
  if (header !== undefined && opts.secrets.some((s) => checkBearer(s, header).ok)) return { kind: 'bearer' };
  return null;
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
  const q: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (!QUERY_KEY.test(k) || v.length > LIMITS.queryValue || k in q) continue;
    if (++n > LIMITS.query) break;
    q[k] = v;
  }
  return q;
}

// ─── One-time result messages ────────────────────────────────────────────────

const flashes = new Map<string, { at: number; result: ActResult }>();

function putFlash(result: ActResult): string {
  const now = Date.now();
  for (const [k, v] of flashes) if (now - v.at > FLASH_TTL_MS || flashes.size > FLASH_MAX) flashes.delete(k);
  const id = randomBytes(12).toString('hex');
  flashes.set(id, { at: now, result });
  return id;
}

function takeFlash(id: string | null): ActResult | undefined {
  if (!id) return undefined;
  const f = flashes.get(id);
  flashes.delete(id);
  return f && Date.now() - f.at <= FLASH_TTL_MS ? f.result : undefined;
}

// ─── Assembling a page ───────────────────────────────────────────────────────

function clock(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: uiTimeZone(), weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());
}

function hasPages(p: PieceInfo): boolean {
  return Boolean(p.manifest.tab || p.manifest.legacy?.length);
}

function chrome(opts: UiOptions, pieces: PieceInfo[], skipped: string[], current: string, csrf: string, flash?: ActResult): Chrome {
  const tabs = pieces.filter(hasPages)
    .map((p) => ({ label: p.manifest.tab?.label ?? p.piece, href: `/ui/p/${p.piece}`, current: current === `p/${p.piece}`, piece: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    agent: agentName(opts.contextDir),
    nav: [
      { label: 'Home', href: '/ui', current: current === '', piece: false },
      { label: 'Mind', href: '/ui/mind', current: current === 'mind', piece: false },
      { label: 'People', href: '/ui/people', current: current === 'people', piece: false },
      ...tabs,
    ],
    clock: clock(),
    csrf,
    flash: flash ? { ok: flash.ok, message: flash.message } : undefined,
    skipped,
  };
}

/** Where to land after an action: the page the piece names, or back where the form was. */
function landing(source: Source, result: ActResult, back: string): string {
  if (result.page !== undefined) {
    const s = splitPage(result.page);
    if (s) return result.page.startsWith('loom:') ? `/ui${s.path ? `/${s.path}` : ''}` : (source.id === 'loom' ? `/ui${s.path ? `/${s.path}` : ''}` : `/ui/p/${source.id}${s.path ? `/${s.path}` : ''}`);
  }
  const s = splitPage(back);
  const path = s?.path ?? '';
  const q = s ? new URLSearchParams(s.query).toString() : '';
  const base = source.id === 'loom' ? `/ui${path ? `/${path}` : ''}` : `/ui/p/${source.id}${path ? `/${path}` : ''}`;
  return q ? `${base}?${q}` : base;
}

function withFlash(to: string, id: string): string {
  return `${to}${to.includes('?') ? '&' : '?'}_flash=${id}`;
}

const notFound: Page = { title: 'Not found', sections: [] };

/** Handle a /ui request. The caller has already matched isUiPath. */
export async function handleUi(req: IncomingMessage, res: ServerResponse, pathname: string, opts: UiOptions): Promise<void> {
  // No token, no page: an open /ui would be readable by any site that
  // DNS-rebinds a name to the loopback address (the same rule as /cli).
  if (opts.secrets.length === 0) {
    return send(res, 403, 'text/plain', 'forbidden: loom\'s page requires LOOM_BEARER_TOKEN');
  }
  const secure = req.headers['x-forwarded-proto'] === 'https';

  if (pathname === '/ui/login') {
    // Unauthenticated: the login page names no agent.
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLogin());
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const form = await readForm(req, LOGIN_MAX_BYTES);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    const token = form.get('token')?.trim() ?? '';
    const match = opts.secrets.find((s) => safeEq(token, s));
    if (!match) return send(res, 401, 'text/html; charset=utf-8', renderLogin('That token didn’t match.'));
    return redirect(res, '/ui', {
      'set-cookie': `${COOKIE}=${cookieValue(match)}; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }

  const who = whoIs(req, opts);
  const csrf = who?.kind === 'session' ? csrfFor(who.cookie) : '';

  if (pathname === '/ui/logout') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    return redirect(res, '/ui/login', { 'set-cookie': `${COOKIE}=; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  if (!who) {
    if (pathname.endsWith('.json')) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    if (req.method === 'GET') return redirect(res, '/ui/login');
    return send(res, 401, 'text/plain', 'unauthorized');
  }

  const url = new URL(req.url ?? pathname, 'http://loom.invalid');

  if (pathname.startsWith('/ui/act/')) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'forbidden: cross-site request');
    const sourceId = pathname.slice('/ui/act/'.length);
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
    const fields: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of form) {
      if (k.startsWith('_') || !/^[a-z][a-z0-9_-]{0,39}$/.test(k) || k in fields) continue;
      if (++n > LIMITS.fields) break;
      fields[k] = v;
    }
    let source: Source;
    let result: ActResult;
    if (sourceId === 'loom') {
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
    return redirect(res, withFlash(to, putFlash(result)));
  }

  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');
  if (pathname === '/ui/pieces.json') {
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

  if (pathname === '/ui' || pathname === '/ui/') {
    const home = homePage(opts.contextDir, query);
    const tiles: HomeTile[] = [
      { ...home.tile, source: CORE },
      ...pieces.filter((p) => p.manifest.tile).map((p) => ({ ...p.manifest.tile!, source: pieceSource(p.piece) })),
    ];
    const asks: HomeAsk[] = pieces.flatMap((p) => p.manifest.asks.map((a) => ({ ...a, source: pieceSource(p.piece) })));
    return html(renderHome(home.page, { source: CORE, path: '', query, csrf }, chrome(opts, pieces, skippedNames, '', csrf, flash), tiles, asks));
  }

  if (pathname.startsWith('/ui/p/')) {
    const rest = pathname.slice('/ui/p/'.length);
    const slash = rest.indexOf('/');
    const piece = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
    const info = pieces.find((p) => p.piece === piece && hasPages(p));
    const ch = chrome(opts, pieces, skippedNames, `p/${piece}`, csrf, flash);
    if (!info || !validPath(path)) return html(renderPage(notFound, { source: pieceSource(piece), path: '', query: {}, csrf }, ch), 404);
    const page = await piecePage(info, path, query, opts.env);
    const ctx = { source: pieceSource(piece), path, query, csrf };
    if (typeof page === 'string') {
      return html(renderPage({ title: info.manifest.tab?.label ?? piece, sections: [{ id: 'error', blocks: [{ type: 'callout', tone: 'bad', text: `${piece} couldn't show this page (${page}).` }] }] }, ctx, ch), 502);
    }
    return html(renderPage(page, ctx, ch), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
  }

  const path = decodeURIComponent(pathname.slice('/ui/'.length));
  const top = path.split('/')[0];
  const ch = chrome(opts, pieces, skippedNames, top, csrf, flash);
  const page = validPath(path) ? corePage(opts.contextDir, path, query) : null;
  const ctx = { source: CORE, path: validPath(path) ? path : '', query, csrf };
  if (!page) return html(renderPage(notFound, ctx, ch), 404);
  return html(renderPage(page, ctx, ch), page.title === 'Not found' && page.sections.length === 0 ? 404 : 200);
}
