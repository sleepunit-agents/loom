/** Clock's program read seam. The clock is trusted to carry its verified wake principal;
 * these are the same member/conversation filters as Home, never an unfiltered shared log. */
import { builtinWatchRegistry } from './watch-sources.js';
import { atWorkFor, asksFor, forOwner } from './ui/handler.js';
import { pieceManifests } from './ui/pieces.js';
import { pieceWithRole } from './needs-resolve.js';
import { firstOwner, memberOf, type Household } from './household.js';

export interface WatchTarget { kind: string; id: string }
export function watchReadShape(body: unknown): body is { agent: string; principal: string; targets: WatchTarget[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return typeof b.agent === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(b.agent)
    && typeof b.principal === 'string' && /^(owner|[a-z0-9][a-z0-9-]{0,127})$/.test(b.principal)
    && Array.isArray(b.targets) && b.targets.length > 0 && b.targets.length <= 20
    && b.targets.every(t => t && typeof t === 'object' && typeof t.kind === 'string'
      && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(t.kind)
      && typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 300 && !/[\x00-\x1f]/.test(t.id));
}

export async function readWatches(env: NodeJS.ProcessEnv, h: Household, body: { agent: string; principal: string; targets: WatchTarget[] }) {
  const member = body.principal === 'owner' ? firstOwner(h) : memberOf(h, body.principal);
  if (!member || !h.agents.includes(body.agent) || (member.agents !== '*' && !member.agents.includes(body.agent))) throw new Error('Principal cannot watch this agent');
  const own = member.agents === '*' ? undefined : member.agents.filter(a => h.agents.includes(a));
  const scopedEnv = own ? { ...env, LOOM_OWNER_SCOPE: own.join(',') } : env;
  const pieces = asksFor(atWorkFor(forOwner((await pieceManifests(scopedEnv, Date.now(), true)).pieces, own), h, member), h,
    { person: member.person, householdOwner: member.agents === '*' });
  const registry = builtinWatchRegistry(pieces, Object.fromEntries(['runtime', 'tasks', 'approvals', 'clock'].map(r => [r, pieceWithRole(env, r)?.name])));
  return { observations: body.targets.map(target => {
    try {
      const source = registry.source(target.kind);
      const item = { ...target, agent: body.agent, title: '', state: '' };
      return { ...target, identity: source.identity(item), value: source.observe(item) };
    } catch {
      // Missing bounded rows, computing and source failures are errors, never terminal values.
      return { ...target, error: 'Observation unavailable' };
    }
  }) };
}
