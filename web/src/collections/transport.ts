/**
 * The page's side of the shared collections: its anti-forgery token on every ask, and its one live stream (page.ts).
 */
import { onStreamEvent } from '../page';
import type { Transport } from './runtime';

export function pageTransport(csrf: () => string): Transport {
  return {
    post: async (body, signal) => {
      const r = await fetch('/collections/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: csrf(), ...body }), signal, credentials: 'same-origin' });
      let json: unknown = null;
      try { json = await r.json(); } catch { /* not JSON: the status says enough */ }
      return { status: r.status, json };
    },
    on: (event, f) => onStreamEvent(event, f),
  };
}
