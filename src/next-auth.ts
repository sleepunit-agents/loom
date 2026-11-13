/** Next credentials use only the explicitly supplied household row stores. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Foundation } from './core/app.js';
import type { Authentication } from './core/live/index.js';
import { clock as realClock, type Clock } from './core/clock.js';
import { HouseholdDatabase } from './core/household/document.js';
import { TokenDatabase } from './core/household/tokens.js';
import { HouseholdRows } from './core/household/rows.js';
import { TokenResolver, isLive, firstOwner, memberOf } from './household.js';
import { SessionDatabase } from './ui/session-db.js';
import { SessionStore, sessionEnded, SESSION_MAX_AGE_S, AGENT_SESSION_MAX_AGE_S } from './ui/sessions.js';

export function nextCredentials(app: Foundation, home: string, clock: Clock = realClock) {
  const households = new HouseholdDatabase(app.db);
  const tokenStore = new TokenDatabase(app.db);
  const bindings = new HouseholdRows<string>(app.db, 'settings');
  const tokens = new TokenResolver(() => {
    const h = households.household(home);
    if (!h) throw new Error('Household is not initialized');
    return h;
  }, { persistence: tokenStore });
  const sessions = new SessionStore(home, new SessionDatabase(app.db));
  const now = () => Math.floor(clock.now() / 1000);
  const member = (secret: Buffer) => {
    const hex = secret.toString('hex');
    const record = tokenStore.records(hex).find(t => t.role === 'owner' && isLive(t, clock.now()));
    const h = households.household(home);
    if (!record || !h) return;
    let person = bindings.get('owner-token-member:' + hex);
    if (!person) {
      person = record.member ?? firstOwner(h)?.person;
      if (!person) return;
      bindings.put('owner-token-member:' + hex, person);
    }
    if (record.member !== undefined && record.member !== person) return;
    return memberOf(h, person);
  };
  // Bind imported unnamed owner credentials before later membership changes.
  const initialHousehold = households.household(home);
  for (const record of tokenStore.list()) if (record.role === 'owner' && initialHousehold && !bindings.get('owner-token-member:' + record.sha256)) {
    bindings.put('owner-token-member:' + record.sha256, record.member ?? firstOwner(initialHousehold).person);
  }
  const proofMatches = (got: unknown, want: string) => { const a = Buffer.from(typeof got === 'string' ? got : ''); const b = Buffer.from(want); return a.length === b.length && timingSafeEqual(a,b); };
  const csrf = (id: string) => createHmac('sha256', sessions.key).update(`loom-ui-csrf|${id}`).digest('hex');
  const browser = (req: IncomingMessage) => {
    const id = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('loom_ui='))?.slice(8);
    if (!id || !/^[0-9a-f]{64}$/.test(id)) return;
    const s = sessions.get(id);
    const m = s && !sessionEnded(s, now()) && member(s.secret);
    return m && s ? { id, session: s, member: m } : undefined;
  };
  const authenticate = (req: IncomingMessage): Authentication | undefined => {
    try {
      const b = browser(req);
      if (b) {
        if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
          if (!proofMatches(req.headers['x-loom-csrf'], csrf(b.id))) return;
        }
        sessions.touch(b.id, now());
        return { viewer: { kind: 'member', id: b.member.person }, window: !b.session.agent, authorizeCall: proof => proofMatches(proof, csrf(b.id)),
          expiresAt: (b.session.issuedAt + (b.session.agent ? AGENT_SESSION_MAX_AGE_S : SESSION_MAX_AGE_S) + 1) * 1000,
          valid: () => {
            try { const current = browser(req); return !!current && current.member.person === b.member.person && current.session.secret.equals(b.session.secret); }
            catch { return false; }
          } };
      }
      const raw = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!raw) return;
      const role = tokens.resolve(raw, clock.now());
      if (!role || (role.kind !== 'owner' && role.kind !== 'agent')) return;
      const owner = role.kind === 'owner' ? member(createHash('sha256').update(raw).digest()) : undefined;
      if (role.kind === 'owner' && !owner) return;
      const viewer = role.kind === 'owner' ? { kind: 'member' as const, id: owner!.person } : { kind: 'agent' as const, id: role.agent };
      return { viewer, valid: () => {
        try { const current = tokens.resolve(raw, clock.now()); return current?.kind === role.kind && (current.kind === 'owner' ? member(createHash('sha256').update(raw).digest())?.person === viewer.id : current.kind === 'agent' && current.agent === viewer.id); }
        catch { return false; }
      } };
    } catch { return; }
  };
  return { authenticate, browser, csrf, sessions, tokens, now, member,
    digest: (raw: string) => createHash('sha256').update(raw).digest() };
}
