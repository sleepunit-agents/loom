/** Browser sign-in routes, composed outside pieces; no legacy auth composition. */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { IncomingMessage } from 'node:http';
import type { Foundation } from './core/app.js';
import type { nextCredentials } from './next-auth.js';
import { SESSION_MAX_AGE_S, deviceOf } from './ui/sessions.js';
import { verifyAssertion, relyingParty } from './ui/passkeys.js';

export function nextSignin(app: Foundation, credentials: ReturnType<typeof nextCredentials>, publicUrl?: string) {
  const { browser, csrf, sessions, tokens, now, member, digest } = credentials;
  const routes = new Hono<{ Bindings: { incoming: IncomingMessage } }>();
  routes.use('*', bodyLimit({ maxSize: 16384 }));
  routes.use('*', async (c, next) => {
    c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
    // No cross-site sign-in, including login CSRF. No-Origin clients must declare JSON.
    if (c.req.method === 'POST' && (c.req.header('sec-fetch-site') === 'cross-site' || !c.req.header('content-type')?.startsWith('application/json'))) return c.json({ error: 'Forbidden' }, 403);
    if (c.req.method === 'POST' && browser(c.env.incoming) && !credentials.authenticate(c.env.incoming)) return c.json({ error: 'CSRF required' }, 403);
    await next();
  });
  routes.onError(() => Response.json({ error: 'Sign-in could not complete' }, { status: 400, headers: { 'cache-control': 'no-store' } }));
  const cookie = (id: string, req: IncomingMessage, maxAge = SESSION_MAX_AGE_S) => `loom_ui=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${publicUrl?.startsWith('https:') || ('encrypted' in req.socket && req.socket.encrypted) ? '; Secure' : ''}`;
  const signedIn = (c: Context<{ Bindings: { incoming: IncomingMessage } }>, id: string) => {
    c.header('set-cookie', cookie(id, c.env.incoming)); return c.json({ ok: true });
  };
  const open = (req: IncomingMessage, secret: Buffer, meta: Parameters<typeof sessions.create>[2]) => sessions.create(secret, now(), { ...meta, device: deviceOf(req.headers['user-agent']) }, s => !!member(s));
  routes.get('/session', c => {
    const b = browser(c.env.incoming);
    return b ? c.json({ member: b.member.person, csrf: csrf(b.id) }) : c.json({ error: 'Authentication required' }, 401);
  });
  routes.post('/token', async c => {
    const body = await c.req.json();
    if (typeof body?.token !== 'string' || body.token.length > 4096) return c.json({ error: 'Invalid token' }, 400);
    if (tokens.resolve(body.token, now() * 1000)?.kind !== 'owner' || !member(digest(body.token))) return c.json({ error: 'Sign-in refused' }, 401);
    const id = open(c.env.incoming, digest(body.token), { via: 'token' });
    return signedIn(c, id);
  });
  // POST only: opening or prefetching a link does not spend it.
  routes.post('/link', async c => {
    const body = await c.req.json();
    if (typeof body?.code !== 'string' || !/^[0-9a-f]{64}$/.test(body.code)) return c.json({ error: 'Invalid link' }, 400);
    const id = app.db.transaction(() => {
      const spent = sessions.spendLink(body.code, now());
      return spent && member(spent.secret) ? open(c.env.incoming, spent.secret, { ...spent, via: 'link' }) : undefined;
    }).immediate();
    if (!id) return c.json({ error: 'Sign-in refused' }, 401);
    return signedIn(c, id);
  });
  routes.post('/logout', c => {
    const b = browser(c.env.incoming);
    if (!b || !credentials.authenticate(c.env.incoming)) return c.json({ error: 'Authentication required' }, 403);
    sessions.delete(b.id); app.live.changed([{ type: 'core.access', id: 'household' }]);
    c.header('set-cookie', cookie('', c.env.incoming, 0)); return c.json({ ok: true });
  });
  const rp = relyingParty({ LOOM_PUBLIC_URL: publicUrl });
  routes.post('/passkey/options', c => {
    if (!rp) return c.json({ error: 'Passkeys require a public URL' }, 503);
    return c.json({ challenge: sessions.createChallenge('login', null, 300, now()), rpId: rp.rpId, userVerification: 'required', timeout: 300000 });
  });
  routes.post('/passkey', async c => {
    if (!rp) return c.json({ error: 'Passkeys require a public URL' }, 503);
    const body = await c.req.json();
    if (typeof body?.id !== 'string') return c.json({ error: 'Sign-in refused' }, 401);
    const stored = sessions.passkey(body.id);
    if (!stored || !member(Buffer.from(stored.secret, 'hex'))) return c.json({ error: 'Sign-in refused' }, 401);
    const assertion = verifyAssertion(body, stored, rp);
    const id = app.db.transaction(() => {
      if (!sessions.useChallenge(assertion.challenge, 'login', now())) return;
      const current = sessions.passkey(assertion.id);
      if (!current || current.publicKey !== stored.publicKey || current.secret !== stored.secret || !member(Buffer.from(current.secret, 'hex'))) return;
      const used = sessions.usePasskey(assertion.id, assertion.counter, now());
      return used ? open(c.env.incoming, Buffer.from(used.secret, 'hex'), { via: 'passkey' }) : undefined;
    }).immediate();
    if (!id) return c.json({ error: 'Sign-in refused' }, 401);
    return signedIn(c, id);
  });
  return routes;
}
