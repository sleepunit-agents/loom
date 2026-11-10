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

/**
 * A command for CollectionRuntime.command: an action (POST /act/…) posted as the page's script posts them, with the
 * operation id the runtime gives it.
 */
export function actCommand(act: string, fields: Record<string, string>, csrf: () => string): (op: string) => Promise<{ status: number; json: unknown }> {
  return async (op) => {
    const r = await fetch(act, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' }, credentials: 'same-origin',
      body: new URLSearchParams({ ...fields, _csrf: csrf(), _op: op }).toString() });
    let json: unknown = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json };
  };
}
