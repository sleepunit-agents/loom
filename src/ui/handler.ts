/**
 * loom's web UI on the HTTP daemon (full scope only): GET /ui, the page;
 * GET /ui/sections.json, the same sections as data; /ui/login and /ui/logout.
 *
 * Auth follows the daemon's bearer token, and the UI needs one: a daemon with
 * no token serves no /ui (like /cli), because an open page would be readable
 * by any site that DNS-rebinds a name to the loopback address. A browser logs
 * in once by pasting the token. The cookie is `<issued-at>.<mac>`, a MAC under
 * a key this process made at start, over the issued-at time and a digest of
 * the token. It isn't the token and isn't derivable from it, so it can't be
 * replayed as a bearer or used to guess the token offline. It lasts 30 days,
 * or until the daemon restarts (log in again). Scripts can send the bearer
 * header instead. The page is read-only, has no script, and is served under a
 * CSP that forbids script and framing.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkBearer } from '../transport/guards.js';
import { agentName, coreSections, uiTimeZone } from './core.js';
import { pieceSections } from './piece-sections.js';
import { renderLogin, renderPage } from './render.js';

const COOKIE = 'loom_ui';
const LOGIN_MAX_BYTES = 4096;
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
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

function authorized(req: IncomingMessage, opts: UiOptions): boolean {
  if (opts.secrets.length === 0) return false;
  const c = readCookie(req, COOKIE);
  if (c && validCookie(c, opts.secrets)) return true;
  const header = req.headers['authorization'];
  return header !== undefined && opts.secrets.some((s) => checkBearer(s, header).ok);
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function redirect(res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { location: to, ...SECURITY_HEADERS, ...extra });
  res.end();
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    let body = '';
    let done = false;
    const finish = (v: URLSearchParams | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (d: Buffer) => {
      if (done) return;
      body += d.toString('utf-8');
      if (body.length > LOGIN_MAX_BYTES) { finish(null); req.destroy(); }
    });
    req.on('end', () => finish(new URLSearchParams(body)));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

async function sections(opts: UiOptions) {
  const core = coreSections(opts.contextDir);
  const { contributed, skipped } = await pieceSections(opts.env);
  return { core, pieces: contributed, skipped };
}

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
    const form = await readForm(req);
    if (!form) return send(res, 413, 'text/plain', 'too large');
    const token = form.get('token')?.trim() ?? '';
    const match = opts.secrets.find((s) => safeEq(token, s));
    if (!match) return send(res, 401, 'text/html; charset=utf-8', renderLogin('That token didn’t match.'));
    return redirect(res, '/ui', {
      'set-cookie': `${COOKIE}=${cookieValue(match)}; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`,
    });
  }
  if (pathname === '/ui/logout') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    return redirect(res, '/ui/login', { 'set-cookie': `${COOKIE}=; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=0` });
  }
  const agent = agentName(opts.contextDir);
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed');

  if (pathname === '/ui/sections.json') {
    if (!authorized(req, opts)) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    const s = await sections(opts);
    return send(res, 200, 'application/json', JSON.stringify({ agent, ...s }));
  }
  if (pathname === '/ui' || pathname === '/ui/') {
    if (!authorized(req, opts)) return redirect(res, '/ui/login');
    const s = await sections(opts);
    return send(res, 200, 'text/html; charset=utf-8', renderPage({
      agent,
      core: s.core,
      pieces: s.pieces,
      skipped: s.skipped,
      generatedAt: new Date().toLocaleTimeString('en-US', { timeZone: uiTimeZone(), hour: '2-digit', minute: '2-digit' }),
    }));
  }
  return send(res, 404, 'text/plain', 'not found');
}
