/**
 * Agent grants: whether an agent may make a call to a piece (docs/specs/agent-runtime.md,
 * "6. Permissions", Agent grants; "Seams this needs from core", 2, `grants`).
 *
 * With one installed piece offering `grants` (the runtime), core asks it before an agent's call
 * to any piece (`/api/<piece>/…`, `/api/<piece>/run`, the relay tool's call to the clock) and
 * before forwarding a delivery for an agent (src/delivery.ts). The ask is the offer's argv with
 * `{agent, piece, path}` on stdin, in a pool of its own, with 2 s to answer `{allow: true}` or
 * `{allow: false, reason}`.
 *
 *  - **Fail closed:** a timeout, an error, an answer that isn't the contract's, or the authority
 *    uninstalled while the call was in flight: the call is refused with 503 and the reason.
 *  - **Refused:** `{allow: false, reason}` is a 403 with the authority's reason. The piece never runs.
 *  - **Fallback:** with no authority installed, there's nothing to ask: each piece decides by its
 *    own agent list, as before.
 *  - Owner calls never ask (the callers here are agents' only), nor does the authority's own piece
 *    asking about itself for a delivery (src/delivery.ts).
 */
import { grantsAuthority, runOffer } from './offers-registry.js';

export interface GrantAsk {
  agent: string;
  piece: string;
  path: string;
}

/** Undefined when the call may go on; else the status (403 refused, 503 couldn't ask) and why. */
export type GrantRefusal = { status: 403 | 503; error: string } | undefined;

/** The authority's answer checked: `{allow: true}`, or `{allow: false, reason}` (1-500 characters). */
export function parseGrantAnswer(v: unknown): { allow: true } | { allow: false; reason: string } | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const o = v as Record<string, unknown>;
  const bad = Object.keys(o).find((k) => k !== 'allow' && k !== 'reason');
  if (bad !== undefined) return `unknown key ${JSON.stringify(bad)}`;
  if (o.allow === true) return { allow: true };
  if (o.allow !== false) return 'allow is true or false';
  if (typeof o.reason !== 'string' || !o.reason.length || o.reason.length > 500) return 'a refusal says why (reason, 1-500 characters)';
  return { allow: false, reason: o.reason };
}

/**
 * Ask the grants authority, if one is installed, whether `agent` may make this call to `piece`.
 * A path is what follows /api/<piece>/ (`run` for a piece's remote CLI), or `deliver` for a
 * delivery the piece makes for the agent.
 */
export async function askGrant(env: NodeJS.ProcessEnv, ask: GrantAsk): Promise<GrantRefusal> {
  const auth = grantsAuthority(env);
  if (auth.piece === undefined) {
    if (auth.conflict) return { status: 503, error: `unavailable: more than one piece offers grants (${auth.conflict.join(', ')}); there's no authority to ask` };
    return undefined;
  }
  const who = `${ask.agent}'s call to ${ask.piece}`;
  const r = await runOffer(env, auth.piece, auth.argv, { kind: 'grants', stdin: JSON.stringify(ask), parse: parseGrantAnswer });
  // Uninstalled (or replaced by another authority) while it was asked: the answer is no one's now.
  if (grantsAuthority(env).piece !== auth.piece) return { status: 503, error: `unavailable: the grants authority (${auth.piece}) was removed while it was asked, so ${who} is refused` };
  if (!r.ok) return { status: 503, error: `unavailable: the grants authority (${auth.piece}) didn't answer (${r.error}), so ${who} is refused` };
  if (!r.value.allow) return { status: 403, error: `forbidden: ${r.value.reason}` };
  return undefined;
}
