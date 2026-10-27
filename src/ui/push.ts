/**
 * Push for Your call (HANDOFF "Push": only for Your call; a tap opens Home
 * with that ask focused, never a piece's tab).
 *
 * A browser subscribes from the Passkeys page (its session, its anti-forgery
 * token); the subscription lives with its session in ui-sessions.json and goes
 * when the session does. Each minute one of loom's listeners takes the watch
 * (sessions.ts takePushWatch: there are three processes), works out Your call,
 * and announces each ask it hasn't before. The first watch only records what's
 * there, so turning this on doesn't announce a backlog.
 *
 * The payload is encrypted to the browser (RFC 8291, by web-push); the push
 * service sees only ciphertext. Endpoints must be https on a known push
 * service, so the server never posts to an address a page made up.
 */
import { createHash } from 'node:crypto';
import webpush from 'web-push';
import type { PushSub, SessionStore } from './sessions.js';

export const WATCH_S = 60;
const SEEDED = '~seeded';

/** An ask's stable key: where it comes from and what it says. */
export function askKey(a: { source: { id: string }; text: string; page?: string }): string {
  return createHash('sha256').update(`${a.source.id}\0${a.text}\0${a.page ?? ''}`).digest('hex').slice(0, 16);
}

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/** A subscription a browser hands over, if it's one loom will send to. */
export function pushSub(v: unknown): PushSub | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof o.endpoint !== 'string' || o.endpoint.length > 1000) return null;
  let u: URL;
  try { u = new URL(o.endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || !PUSH_HOSTS.some((h) => h.test(u.hostname))) return null;
  const { p256dh, auth } = o.keys ?? {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,64}$/.test(auth)) return null;
  return { endpoint: o.endpoint, keys: { p256dh, auth } };
}

export function publicKey(store: SessionStore): string {
  return store.pushKeys(() => webpush.generateVAPIDKeys()).publicKey;
}

export interface Announce { key: string; title: string; body: string }

/**
 * One watch: if this process has it, announce the asks not announced before.
 * The record is kept current whether or not anyone is subscribed, so a new
 * subscription hears what's new from then on, not a backlog.
 */
export async function watch(store: SessionStore, asks: () => Promise<Announce[]>, subject: string, send = webpush.sendNotification.bind(webpush)): Promise<number> {
  const w = store.takePushWatch(WATCH_S);
  if (!w) return 0;
  const now = await asks();
  // The first watch only records what's there (SEEDED marks that it has run).
  const fresh = SEEDED in w.pushed ? now.filter((a) => !(a.key in w.pushed)) : [];
  store.markPushed([...now.map((a) => a.key), SEEDED]);
  if (!fresh.length || !w.subs.length) return 0;
  const vapid = store.pushKeys(() => webpush.generateVAPIDKeys());
  let sent = 0;
  for (const a of fresh.slice(0, 5)) {
    const payload = JSON.stringify({ title: a.title, body: a.body.slice(0, 200), tag: `ask-${a.key}`, url: `/inbox?i=${a.key}` });
    for (const sub of w.subs) {
      try {
        await send(sub, payload, { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 6 * 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        // Gone (the browser unsubscribed, or the subscription expired): forget it.
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) store.removePushSub(sub.endpoint);
      }
    }
  }
  return sent;
}
