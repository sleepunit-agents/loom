/**
 * Who may relay to whom without asking (docs/specs/agent-runtime.md, "Agent-to-agent relay"): the
 * runtime's permissions, not household.json. Pairing moved out of the household's file into the
 * grants authority's own grants document (its store's `grants/household`, key `relay`:
 * {sender: [agents]}), which the owner sets on that piece's page (Permissions).
 *
 * Core only reads it here, for an agent's Setup page. Core never names the piece: it's the
 * grants authority (offers-registry.ts). With none installed, or nothing in its store, there are
 * no pairs: every relay asks the owner first (and with no runtime there's no relay at all).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { grantsAuthority } from './offers-registry.js';
import { PieceStore, storesDir } from './stores.js';

export interface RelayPairs {
  /** The grants authority the pairs are read from; undefined when none is installed. */
  authority?: string;
  /** sender → the agents it may relay to without asking. */
  pairs: Record<string, string[]>;
}

export function relayPairs(home: string, env: NodeJS.ProcessEnv = process.env): RelayPairs {
  const auth = grantsAuthority({ ...env, LOOM_HOME: home });
  if (auth.piece === undefined) return { pairs: {} };
  const out: RelayPairs = { authority: auth.piece, pairs: {} };
  if (!existsSync(join(storesDir(home), `${auth.piece}.db`))) return out;
  let st: PieceStore | undefined;
  try {
    st = new PieceStore(home, auth.piece);
    const relay = (st.get('grants', 'household')?.doc as { relay?: unknown } | undefined)?.relay;
    if (relay && typeof relay === 'object' && !Array.isArray(relay)) {
      for (const [a, to] of Object.entries(relay as Record<string, unknown>)) {
        if (Array.isArray(to)) out.pairs[a] = to.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // A store that can't be read shows no pairs; the runtime's own page says why.
  } finally {
    st?.close();
  }
  return out;
}

/** Who `agent` may relay to without asking: the household's other agents among its pairs. */
export function relayOf(home: string, agents: readonly string[], agent: string, env: NodeJS.ProcessEnv = process.env): { authority?: string; to: string[] } {
  const r = relayPairs(home, env);
  return { authority: r.authority, to: (r.pairs[agent] ?? []).filter((a) => a !== agent && agents.includes(a)) };
}
