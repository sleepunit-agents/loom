/** Shared-model sign-in links. Trusted issuers name an existing member token;
 * the HTTP door binds that token to the authenticated bearer. */
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Clock } from '../clock.js';
import type { DataDatabase } from '../data/database.js';
import { members, sessions, signinLinks, tokens } from '../data/schema.js';
import { dataAuthentication } from '../data/authentication.js';
import type { DataWrites } from '../data/writes.js';

const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const LINK_MS = 5 * 60_000;
const PERSON_MS = 30 * 86400_000, AGENT_MS = 6 * 3600_000;
function browserDevice(ua: string): string {
  const browser = /HeadlessChrome\//.test(ua) ? 'HeadlessChrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  return system ? `${browser} on ${system}` : browser;
}
export function sharedSigninLinks(db: DataDatabase, clock: Clock) {
  const token = (id: string) => {
    const value = db.select().from(tokens).where(eq(tokens.fingerprint, id)).get();
    if (!value || value.kind !== 'owner' || !value.member || value.revokedAt ||
      (value.expiresAt && Date.parse(value.expiresAt) <= clock.now()) ||
      !db.select({ id: members.id }).from(members).where(eq(members.id, value.member)).get()) throw new Error('Sign-in refused');
    return value;
  };
  return {
    makeLink(id: string) {
      const current = token(id), code = secret();
      const expiresAt = new Date(Math.min(clock.now() + LINK_MS, current.expiresAt ? Date.parse(current.expiresAt) : Infinity)).toISOString();
      db.insert(signinLinks).values({ id: fingerprint(code), token: id, label: current.label, expiresAt }).run();
      return { path: `/login/${code}`, expiresAt };
    },
    redeem(code: string, device: string, isAgent = false) {
      if (!/^[0-9a-f]{64}$/.test(code)) throw new Error('Sign-in refused');
      return db.transaction(() => {
        const link = db.select().from(signinLinks).where(eq(signinLinks.id, fingerprint(code))).get();
        if (!link || Date.parse(link.expiresAt) <= clock.now()) throw new Error('Sign-in refused');
        const current = token(link.token), cookie = secret(), at = new Date(clock.now()).toISOString();
        db.delete(signinLinks).where(eq(signinLinks.id, link.id)).run();
        db.insert(sessions).values({ id: fingerprint(cookie), token: current.fingerprint, device: browserDevice(device),
          via: 'link', isAgent, issuedAt: at, seenAt: at, provedAt: at }).run();
        const expires = Math.min(clock.now() + (isAgent ? AGENT_MS : PERSON_MS), current.expiresAt ? Date.parse(current.expiresAt) : Infinity);
        return { cookie, maxAge: Math.floor((expires - clock.now()) / 1000) };
      });
    },
  };
}

/** Public identity door, using the same connection and committed notifications
 * as queries/commands. No session cookie or raw link enters retry receipts. */
export function sharedSigninLinkRoutes(options: { db: DataDatabase; clock: Clock; writes: DataWrites; publicOrigin?: string; admitted(): boolean; reportError(error: unknown): void }) {
  const signin = sharedSigninLinks(options.db, options.clock);
  const authenticate = dataAuthentication(options.db, () => options.clock.now());
  const routes = new Hono();
  const guard: MiddlewareHandler = async (c, next) => {
    c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
    c.header('x-content-type-options', 'nosniff');
    if (!options.admitted()) return c.json({ error: 'Sign-in unavailable' }, 503);
    if (c.req.method === 'POST') {
      const origin = c.req.header('origin'), url = new URL(c.req.url);
      if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin && !(origin === options.publicOrigin && new URL(origin).host === url.host)))
        return c.json({ error: 'Cross-origin request refused' }, 403);
    }
    await next();
  };
  routes.use('/api/signin/link', guard); routes.use('/login/*', guard);
  routes.use('/auth/session', guard); routes.use('/logout', guard);
  routes.onError(() => Response.json({ error: 'Sign-in could not complete' }, { status: 401, headers: { 'cache-control': 'no-store' } }));
  const write = <T>(action: () => T): T => {
    const committed = options.writes.run(action);
    for (const error of committed.notificationErrors) { try { options.reportError(error); } catch { /* preserve committed sign-in */ } }
    return committed.value;
  };
  const cookieHeader = (cookie: string, maxAge: number, url: string) => {
    const secure = (options.publicOrigin ?? new URL(url).origin).startsWith('https:');
    return `loom_ui=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };
  routes.post('/api/signin/link', c => {
    const bearer = /^Bearer ([^\s]{32,4096})$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const auth = bearer ? authenticate(c.req.raw) : undefined;
    if (!auth?.valid() || auth.viewer.kind !== 'member') return c.json({ error: 'Member bearer authentication required' }, 401);
    // Request input cannot choose a token/member or impersonate an agent.
    return c.json({ ok: true, value: write(() => signin.makeLink(fingerprint(bearer!))) });
  });
  routes.get('/auth/session', c => {
    const auth = authenticate(c.req.raw);
    return c.json({ viewer: auth?.valid() && auth.viewer.kind === 'member' ? auth.viewer : null });
  });
  routes.post('/logout', c => {
    const cookie = c.req.header('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('loom_ui='))?.slice(8);
    if (cookie && /^[a-zA-Z0-9_-]{32,4096}$/.test(cookie)) write(() => options.db.delete(sessions).where(eq(sessions.id, fingerprint(cookie))).run());
    c.header('set-cookie', cookieHeader('', 0, c.req.url));
    return c.json({ ok: true });
  });
  routes.get('/login/:code', c => {
    if (!/^[0-9a-f]{64}$/.test(c.req.param('code'))) return c.notFound();
    c.header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html('<!doctype html><html><head><title>Sign in to loom</title></head><body><h1>Sign in to loom</h1><form method="post"><button>Sign in</button></form></body></html>');
  });
  routes.post('/login/:code', c => {
    const result = write(() => signin.redeem(c.req.param('code'), c.req.header('user-agent') ?? 'Browser', /HeadlessChrome\//.test(c.req.header('user-agent') ?? '')));
    c.header('set-cookie', cookieHeader(result.cookie, result.maxAge, c.req.url));
    return c.redirect('/', 303);
  });
  return routes;
}
