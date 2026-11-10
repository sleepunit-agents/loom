/**
 * Push for Your call (HANDOFF "Push": only for Your call; a tap opens Home
 * with that ask focused, never a piece's tab).
 *
 * A browser subscribes from Profile (its session, its anti-forgery token). The
 * subscription is its person's and the device's (t-1978), kept in ui-sessions.json
 * by endpoint: it outlives the session it was made in, and goes only when it's
 * turned off there, removed on Profile, gone at the push service, or its person
 * leaves the household (sessions.ts PushDevice). Each minute one of loom's listeners takes the watch
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
/**
 * A push's title says what it is (Jonathan, 2026-10-30: alerts go to loom and push like everything else): an alert,
 * a permission, a to-do; a decision or a reply is Your call.
 */
export function pushTitle(kind: string | undefined, from: string): string {
  const what = kind === 'alert' ? 'Alert' : kind === 'permission' ? 'Permission' : kind === 'todo' ? 'To do' : 'Your call';
  return `${what} · ${from}`;
}

export function askKey(a: { source: { id: string }; text: string; page?: string }): string {
  return createHash('sha256').update(`${a.source.id}\0${a.text}\0${a.page ?? ''}`).digest('hex').slice(0, 16);
}

/**
 * A conversation's open Needs you as the Inbox words it: its ask, or, written as a plain string, "<agent> needs you: …".
 * With needsAskKey, how any page (the Projects page) links to that very ask in the Inbox (/inbox?i=<key>).
 */
export function needsAskText(agentName: string, ask: string, legacy: boolean): string {
  return legacy ? `${agentName} needs you: ${ask}` : ask;
}

/** The Inbox key of a conversation's open Needs you: askKey of the Inbox's own item (its source is loom's). */
export function needsAskKey(text: string, conversation: string): string {
  return askKey({ source: { id: 'loom' }, text, page: `loom:conversation/${conversation}` });
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

/** agent: whose it is, so only that agent's owners hear of it (docs/specs/owners.md); none is the household's. */
export interface Announce {
  key: string; title: string; body: string; agent?: string;
  /** Only this member's devices hear it (a Comms reply: comms.md, "Notifications"). */
  member?: string;
  /** Only these members' devices hear it (an attention record's audience: the members whose Inbox has it, t-2025). */
  members?: string[];
  /** Where a tap opens (else the ask in the Inbox). */
  url?: string;
  /** Whether an agent owner may hear of it: loom's own, or from a piece that understands agent owners. */
  open?: boolean;
}

/**
 * One watch: if this process has it, announce the asks not announced before.
 * The record is kept current whether or not anyone is subscribed, so a new
 * subscription hears what's new from then on, not a backlog.
 */
export async function watch(store: SessionStore, asks: () => Promise<Announce[]>, subject: string, send = webpush.sendNotification.bind(webpush),
  /** Whether a device's member may hear of an ask for this agent (none: the household's). Everyone, without it. */
  hears: (member: string | undefined, a: Announce) => boolean = () => true,
  /** Whose a device with no member is (the first household owner), for an announcement meant for one member. */
  firstMember?: () => string | undefined,
  /** Whether a device's member is still in the household; one who isn't loses their devices. */
  belongs?: (member: string | undefined) => boolean): Promise<number> {
  const w = store.takePushWatch(WATCH_S, undefined, belongs);
  if (!w) return 0;
  const now = await asks();
  // The first watch only records what's there (SEEDED marks that it has run).
  const fresh = SEEDED in w.pushed ? now.filter((a) => !(a.key in w.pushed)) : [];
  // Five a minute at most; the rest wait for the next minute, unmarked, so none is dropped (a reply behind five asks).
  const later = new Set(fresh.slice(5).map((a) => a.key));
  store.markPushed([...now.map((a) => a.key).filter((k) => !later.has(k)), SEEDED]);
  if (!fresh.length || !w.subs.length) return 0;
  const vapid = store.pushKeys(() => webpush.generateVAPIDKeys());
  let sent = 0;
  for (const a of fresh.slice(0, 5)) {
    // Only what it is and who it's from, and where a tap opens: never the ask's words or a thread's title, which a
    // locked phone's screen or the push service's logs would show (t-1978 review). The page says the rest, signed in.
    const payload = JSON.stringify({ title: a.title, body: '', tag: `ask-${a.key}`, url: a.url ?? `/inbox?i=${a.key}` });
    for (const { member, ...sub } of w.subs) {
      if (a.member !== undefined && (member ?? firstMember?.()) !== a.member) continue;
      if (a.members !== undefined && !a.members.includes(member ?? firstMember?.() ?? '')) continue;
      if (!hears(member, a)) continue;
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

/**
 * One test notification to one device (Profile's "Send a test notification", pressed by its person): 'sent', 'gone'
 * (the push service no longer has it: forgotten, like the watch does), or what went wrong.
 */
export async function sendTest(store: SessionStore, sub: PushSub, subject: string, send = webpush.sendNotification.bind(webpush)): Promise<'sent' | 'gone' | string> {
  const vapid = store.pushKeys(() => webpush.generateVAPIDKeys());
  const payload = JSON.stringify({ title: 'loom · test', body: 'Notifications reach this device.', tag: 'loom-test', url: '/account' });
  try {
    await send(sub, payload, { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 600, urgency: 'high' });
    return 'sent';
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) { store.removePushSub(sub.endpoint); return 'gone'; }
    return code ? `the push service said ${code}` : 'the push service couldn\'t be reached';
  }
}
