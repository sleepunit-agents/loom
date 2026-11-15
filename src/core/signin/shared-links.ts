import { sharedPasskeys } from './shared-passkeys.js';
import { bodyLimit } from 'hono/body-limit';
/** Shared-model sign-in links. Trusted issuers name an existing member token;
 * the HTTP door binds that token to the authenticated bearer. */
import { createHash, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Clock } from '../clock.js';
import type { DataDatabase } from '../data/database.js';
import { notificationDevices, sessions, signinLinks, tokens, notificationQueue } from '../data/schema.js';
import { dataAuthentication } from '../data/authentication.js';
import { sharedTokens, sharedTokenInput, sharedTokenOwner, activeMemberToken } from './shared-tokens.js';
import { OperationError } from '../operations/index.js';
import type { DataWrites } from '../data/writes.js';

const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const LINK_MS = 5 * 60_000;
const PERSON_MS = 30 * 86400_000, AGENT_MS = 6 * 3600_000;
function browserDevice(ua: string): { device: string; isAgent: boolean } {
  const isAgent = /HeadlessChrome\//.test(ua);
  const browser = isAgent ? 'HeadlessChrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  return { device: system ? `${browser} on ${system}` : browser, isAgent };
}
export function sharedSigninLinks(db: DataDatabase, clock: Clock) {
  const token = (id: string) => activeMemberToken(db,clock,id);
  return {
    makeLink(id: string) {
      const current = token(id), code = secret();
      const expiresAt = new Date(Math.min(clock.now() + LINK_MS, current.expiresAt ? Date.parse(current.expiresAt) : Infinity)).toISOString();
      db.insert(signinLinks).values({ id: fingerprint(code), token: id, label: current.label, expiresAt }).run();
      return { path: `/login/${code}`, expiresAt };
    },
    redeem(code: string, userAgent: string, isAgent = false) {
      if (!/^[0-9a-f]{64}$/.test(code)) throw new Error('Sign-in refused');
      return db.transaction(() => {
        const link = db.select().from(signinLinks).where(eq(signinLinks.id, fingerprint(code))).get();
        if (!link || Date.parse(link.expiresAt) <= clock.now()) throw new Error('Sign-in refused');
        const current = token(link.token), cookie = secret(), at = new Date(clock.now()).toISOString();
        const browser = browserDevice(userAgent), agent = isAgent || browser.isAgent;
        db.delete(signinLinks).where(eq(signinLinks.id, link.id)).run();
        db.insert(sessions).values({ id: fingerprint(cookie), token: current.fingerprint, device: browser.device,
          via: 'link', isAgent: agent, issuedAt: at, seenAt: at, provedAt: at }).run();
        const expires = Math.min(clock.now() + (agent ? AGENT_MS : PERSON_MS), current.expiresAt ? Date.parse(current.expiresAt) : Infinity);
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
  const rp=options.publicOrigin?new URL(options.publicOrigin):undefined;
  const passkeys=rp&&(rp.protocol==='https:'||rp.hostname==='localhost')?sharedPasskeys(options.db,options.clock,{origin:rp.origin,rpId:rp.hostname}):undefined;
  for(const path of ['/api/signin/link','/api/signin/token','/login/*','/passkeys','/passkeys/options','/logout'])routes.use(path,bodyLimit({maxSize:32768}));
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
  routes.use('/api/signin/token', guard); routes.use('/api/signin/link', guard); routes.use('/login/*', guard);
  for(const path of ['/login/passkey/options','/login/passkey','/passkeys/options','/passkeys'])routes.use(path,guard);
  routes.use('/auth/session', guard); routes.use('/logout', guard);
  routes.onError(() => Response.json({ error: 'Sign-in could not complete' }, { status: 401, headers: { 'cache-control': 'no-store' } }));
  const write = <T>(action: () => T): T => {
    const committed = options.writes.run(() => { if(!options.admitted())throw Error('Sign-in unavailable'); return action(); });
    for (const error of committed.notificationErrors) { try { options.reportError(error); } catch { /* preserve committed sign-in */ } }
    return committed.value;
  };
  const cookieHeader = (cookie: string, maxAge: number, url: string) => {
    const secure = (options.publicOrigin ?? new URL(url).origin).startsWith('https:');
    return `loom_ui=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };
  routes.post('/api/signin/token', async c => {
    const input = sharedTokenInput.safeParse(await c.req.json().catch(() => null));
    const auth = authenticate(c.req.raw);
    if (!auth?.valid() || !sharedTokenOwner(options.db, auth.viewer)) return c.json({ error: 'Household owner required' }, 403);
    if (!input.success) return c.json({ error: 'Invalid token request' }, 400);
    try { return c.json({ ok: true, value: write(() => {
      if(!auth.valid() || !sharedTokenOwner(options.db, auth.viewer))throw new OperationError('denied','Household owner required');
      return sharedTokens(options.db, options.clock).issue(input.data);
    }) }); }
    catch (error) {
      if (error instanceof OperationError) return c.json({ error: error.message }, error.code === 'denied' ? 403 : error.code === 'conflict' ? 409 : 400);
      throw error;
    }
  });
  routes.post('/api/signin/link', c => {
    const bearer = /^Bearer ([^\s]{32,4096})$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const auth = authenticate(c.req.raw);
    if (!auth?.valid() || auth.viewer.kind !== 'member') return c.json({ error: 'Member authentication required' }, 401);
    const cookie = c.req.header('cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith('loom_ui='))?.slice(8);
    const token = bearer ? fingerprint(bearer) : cookie ? options.db.select({token:sessions.token}).from(sessions).where(eq(sessions.id,fingerprint(cookie))).get()?.token : undefined;
    if(!token)return c.json({error:'Member authentication required'},401);
    // Request input cannot choose a token/member or impersonate an agent.
    return c.json({ ok: true, value: write(() => { if(!auth.valid())throw Error('Authentication ended'); return signin.makeLink(token); }) });
  });
  routes.get('/auth/session', c => {
    const auth = authenticate(c.req.raw);
    return c.json({ viewer: auth?.valid() && auth.viewer.kind === 'member' ? auth.viewer : null });
  });
  routes.post('/logout', c => {
    const cookie = c.req.header('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('loom_ui='))?.slice(8);
    // A stale cookie may be cleared locally, but must not authorize server
    // changes. Authenticate the cookie itself; an unrelated bearer cannot help.
    const auth = cookie ? authenticate(new Request(c.req.url, { headers: { cookie: `loom_ui=${cookie}` } })) : undefined;
    if (auth?.valid() && auth.viewer.kind === 'member' && cookie) write(() => {
      if(!auth.valid())return;
      const id = fingerprint(cookie);
      options.db.delete(notificationQueue).where(inArray(notificationQueue.device,options.db.select({endpoint:notificationDevices.endpoint}).from(notificationDevices).where(eq(notificationDevices.session,id)))).run();
      options.db.delete(notificationDevices).where(eq(notificationDevices.session, id)).run();
      options.db.delete(sessions).where(eq(sessions.id, id)).run();
    });
    c.header('set-cookie', cookieHeader('', 0, c.req.url));
    return c.json({ ok: true });
  });
  for(const path of ['/login/passkey/options','/login/passkey','/passkeys/options','/passkeys'])routes.post(path,async c=>{
    if(!passkeys||new URL(c.req.url).host!==rp!.host)return c.json({error:'Passkeys unavailable at this address'},404);
    const body=await c.req.json().catch(()=>null);
    if(!body||typeof body!=='object'||Array.isArray(body))return c.json({error:'Invalid request'},400);
    if(!options.admitted())return c.json({error:'Sign-in unavailable'},503);
    if(path==='/login/passkey/options')return c.json(passkeys.loginOptions());
    if(path==='/login/passkey'){
      const value=write(()=>passkeys.login(body,c.req.header('user-agent')??'Browser'));
      c.header('set-cookie',cookieHeader(value.cookie,value.maxAge,c.req.url));return c.json({ok:true});
    }
    const cookie=c.req.header('cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith('loom_ui='))?.slice(8);
    if(!cookie)return c.json({error:'Sign in again before adding a passkey'},403);
    if(path==='/passkeys/options')return c.json(passkeys.registrationOptions(cookie));
    return c.json(write(()=>passkeys.register(cookie,body)));
  });
  routes.get('/login/:code', c => {
    if (!/^[0-9a-f]{64}$/.test(c.req.param('code'))) return c.notFound();
    // no-referrer also nulls a native form's Origin (Fetch section 3.2).
    // Keep the code path out of referrers while retaining same-origin POSTs.
    c.header('referrer-policy', 'strict-origin');
    c.header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html('<!doctype html><html><head><title>Sign in to loom</title></head><body><h1>Sign in to loom</h1><form method="post"><button>Sign in</button></form></body></html>');
  });
  routes.post('/login/:code', c => {
    const result = write(() => signin.redeem(c.req.param('code'), c.req.header('user-agent') ?? 'Browser'));
    c.header('set-cookie', cookieHeader(result.cookie, result.maxAge, c.req.url));
    return c.redirect('/', 303);
  });
  return routes;
}
