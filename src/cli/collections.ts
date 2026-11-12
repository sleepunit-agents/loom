/** Provider write hints: local core store, or the existing authenticated HTTP seam. */
import { householdHome } from '../household.js';
import { nudge } from '../collections/pull.js';
import { parseVerb } from './args.js';
import { pieceRunEndpoint, requestHeaders } from './remote.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom collections nudge <provider/type|provider/*>

Hint that a provider wrote. Core pulls soon; no domain existence is disclosed.
With --url or LOOM_URL, use that loom's authenticated nudge endpoint.
`;

export async function run(argv: string[], io: IOStreams, url?: string): Promise<number> {
  const p = parseVerb(argv, {}, USAGE, io);
  if (typeof p === 'number') return p;
  const [op, domain, extra] = p.positionals;
  if (op !== 'nudge' || !domain || extra !== undefined ||
      !/^[a-z][a-z0-9-]{0,39}\/([a-z][a-z0-9-]{0,31}|\*)$/.test(domain)) {
    io.stderr(USAGE); return 2;
  }
  if (!url) { await nudge(householdHome(io.env), domain); return 0; }
  // Never touch a local derived store in a remote house. /cli is deliberately not widened.
  if (argv.some(a => a === '--context-dir' || a.startsWith('--context-dir='))) {
    io.stderr('loom collections: --context-dir is local; drop --url / unset LOOM_URL to use it.\n'); return 2;
  }
  let endpoint: URL;
  try { endpoint = pieceRunEndpoint(url, 'loom'); endpoint.pathname = endpoint.pathname.replace(/run$/, 'collections/nudge'); }
  catch { io.stderr('loom collections: not a URL\n'); return 2; }
  const headers = await requestHeaders(io);
  if (!headers) return 1;
  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ domain }), signal: AbortSignal.timeout(1000) });
    // The endpoint's fixed accepted response says nothing about the domain.
    await res.body?.cancel();
    if (res.status === 202) return 0;
    io.stderr(`loom collections: nudge answered ${res.status}\n`); return 1;
  } catch {
    io.stderr('loom collections: cannot send nudge\n'); return 1;
  }
}
