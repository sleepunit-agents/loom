// Whether an ask is still open, from loom now (t-1925; the Inbox's rule, inbox.tsx): an ask's buttons are live only once
// loom has said, just now, that it's still open (/inbox/open), and it's asked again right before one is sent. A copy
// kept on this device (page.ts, the service worker) may be of an ask answered since, and a copy can't tell: so no
// answer from loom (offline, a cached copy stamped x-loom-saved-at) leaves the buttons off. Used by the Inbox, the
// asks inside a Comms thread and the desktop's Needs you.
import { useEffect, useState } from 'react';
import type { Env } from './blocks';

export type Live = 'checking' | 'live' | 'gone' | 'unknown';

/** Which ask: its Inbox key (k), or, for an approval asked from a Comms thread, the approval's id (a). */
export type AskRef = { k: string } | { a: string };

/** Whether loom says, now, that the ask is still open. Never from a copy: a stamped one (x-loom-saved-at) can't tell. */
export async function stillOpen(ref: AskRef): Promise<Live> {
  try {
    const q = 'k' in ref ? `k=${encodeURIComponent(ref.k)}` : `a=${encodeURIComponent(ref.a)}`;
    const r = await fetch(`/inbox/open?${q}`, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok || r.headers.has('x-loom-saved-at') || !(r.headers.get('content-type') ?? '').startsWith('application/json')) return 'unknown';
    return ((await r.json()) as { open?: boolean }).open ? 'live' : 'gone';
  } catch { return 'unknown'; }
}

export const LIVE_SAYS: Record<Exclude<Live, 'live'>, string> = {
  checking: 'Checking it’s still open…',
  gone: 'This isn’t open any more: it was answered or changed since. Nothing was sent.',
  unknown: 'Can’t check with loom right now, so its buttons wait. Try again in a moment.',
};

/** An ask's liveness, checked when it's shown and again when `recheck` changes (the Inbox's pick), and a check to run
 * right before a send. `null`: nothing to answer, so nothing to check. */
export function useAskLive(ref: AskRef | null, recheck: unknown = 0): { live: Live; check: () => Promise<boolean> } {
  const id = ref ? ('k' in ref ? `k:${ref.k}` : `a:${ref.a}`) : '';
  const [live, setLive] = useState<Live>(ref ? 'checking' : 'live');
  const check = async () => { if (!ref) return true; const l = await stillOpen(ref); setLive(l); return l === 'live'; };
  useEffect(() => { if (!ref) { setLive('live'); return; } setLive('checking'); void check(); }, [id, recheck]);   // eslint-disable-line react-hooks/exhaustive-deps
  return { live, check };
}

/** An Env whose every send asks loom first that the ask is still open (and sends nothing when it isn't). */
export function guardedEnv(env: Env, check: () => Promise<boolean>): Env {
  const g = (e: Env): Env => ({ ...e,
    send: async (a, fields) => ((await check()) ? e.send(a, fields) : false),
    withSource: (s) => g(e.withSource(s)) });
  return g(env);
}
