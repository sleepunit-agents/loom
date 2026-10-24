/**
 * loom's web UI on the HTTP daemon (full scope only): GET /ui, the page;
 * GET /ui/sections.json, the same sections as data; /ui/login and /ui/logout.
 *
 * Auth follows the daemon's bearer token. A browser logs in once by pasting
 * it; the cookie holds an HMAC of the token, never the token itself, so the
 * cookie can't be replayed as a bearer against /mcp or /cli. Scripts can send
 * the bearer header instead. With no token configured (a loopback daemon), the
 * UI is open, like /mcp. The page is read-only, has no script, and is served
 * under a CSP that forbids script and framing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkBearer } from '../transport/guards.js';
import { agentName, coreSections } from './core.js';
import { pieceSections } from './piece-sections.js';
import { renderLogin, renderPage } from './render.js';

const COOKIE = 'loom_ui';
const LOGIN_MAX_BYTES = 4096;
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

function cookieValue(secret: string): string {
  return createHmac('sha256', secret).update('loom-ui-v1').digest('hex');
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function authorized(req: IncomingMessage, opts: UiOptions): boolean {
  if (opts.secrets.length === 0) return true;
  const c = readCookie(req, COOKIE);
  if (c && opts.secrets.some((s) => safeEq(c, cookieValue(s)))) return true;
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
    let over = false;
    req.on('data', (d: Buffer) => {
      if (over) return;
      body += d.toString('utf-8');
      if (body.length > LOGIN_MAX_BYTES) { over = true; resolve(null); }
    });
    req.on('end', () => { if (!over) resolve(new URLSearchParams(body)); });
    req.on('error', () => resolve(null));
  });
}

async function sections(opts: UiOptions) {
  const core = coreSections(opts.contextDir);
  const { contributed, skipped } = await pieceSections(opts.env);
  return { core, pieces: contributed, skipped };
}

/** Handle a /ui request. The caller has already matched isUiPath. */
export async function handleUi(req: IncomingMessage, res: ServerResponse, pathname: string, opts: UiOptions): Promise<void> {
  const agent = agentName(opts.contextDir);
  const secure = req.headers['x-forwarded-proto'] === 'https';

  if (pathname === '/ui/login') {
    if (req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', renderLogin(agent));
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed');
    const form = await readForm(req);
    const token = form?.get('token')?.trim() ?? '';
    const match = opts.secrets.find((s) => safeEq(token, s));
    if (!match) return send(res, 401, 'text/html; charset=utf-8', renderLogin(agent, 'That token didn’t match.'));
    return redirect(res, '/ui', {
      'set-cookie': `${COOKIE}=${cookieValue(match)}; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`,
    });
  }
  if (pathname === '/ui/logout') {
    return redirect(res, '/ui/login', { 'set-cookie': `${COOKIE}=; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=0` });
  }
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
      generatedAt: new Date().toLocaleTimeString('en-US', { timeZone: process.env.TZ ?? 'America/Chicago', hour: '2-digit', minute: '2-digit' }),
    }));
  }
  return send(res, 404, 'text/plain', 'not found');
}
