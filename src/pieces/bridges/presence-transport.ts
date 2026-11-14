/** Unregistered service IO for presence. The owning Runtime source is still
 * absent: this seam grants no admission and must not be wired to a fake in production. */
import type { SecretUse } from '../secrets/role.js';
import { venueSchema, type Venue } from './model.js';
import { isDiscordId } from './discord-id.js';
import type { PresenceEffects } from './presence.js';

/** Trusted exact-place proof from the owning lifecycle, never public input.
 * current includes authenticated setup and credential-generation lifetime.
 * Composition supplies staging separately; the controller supplies fresh facts. */
export interface PresencePlace {
  readonly agent: string;
  readonly venue: string;
  readonly platform: Venue['platform'];
  readonly workspace: string;
  readonly channel: string;
  current(): boolean;
}
const slackId = (id: string) => /^[A-Z][A-Z0-9]{1,199}$/.test(id);
const slackTs = (id: string) => /^\d{10}\.\d{6}$/.test(id);
const failed = () => Error('Bridge presence attempt uncertain');

/** One attempt, one service-scoped secret use per HTTP request. Nothing retains
 * credential bytes. Injected fetch is only for fixtures. No public registration. */
export function presenceTransport(input: Venue, place: PresencePlace, secrets: SecretUse,
  beforeEffect: () => boolean, request: typeof fetch = fetch): PresenceEffects {
  const venue = venueSchema.parse(structuredClone(input));
  const bound = {agent:place.agent,venue:place.venue,platform:place.platform,workspace:place.workspace,channel:place.channel};
  const valid = venue.enabled && bound.agent === venue.agent && bound.venue === venue.id
    && bound.platform === venue.platform && bound.workspace === venue.workspace
    && (venue.platform === 'discord'
      ? [venue.bot,venue.workspace,bound.channel].every(isDiscordId)
      : slackId(venue.bot) && slackId(venue.workspace) && /^[CDG][A-Z0-9]{1,199}$/.test(bound.channel));
  function current(facts: () => boolean) {
    return valid && Object.entries(bound).every(([key,value]) => place[key as keyof typeof bound] === value)
      && place.current() && beforeEffect() && facts();
  }
  async function perform(path: string, method: string, fields: Record<string,string> | undefined,
    facts: () => boolean, absent?: string) {
    try {
      if (!current(facts)) throw failed();
      const accepted = await secrets.withValue(venue.tokenSecret, async token => {
        // A holder can return after revocation, staging, done, or a post.
        if (!current(facts)) throw failed();
        const discord = venue.platform === 'discord';
        const response = await request(discord ? `https://discord.com/api/v10/${path}` : `https://slack.com/api/${path}`, {
          method, redirect:'error', signal:AbortSignal.timeout(15_000),
          headers: discord ? {Authorization:`Bot ${token}`} : {Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},
          ...(fields ? {body:new URLSearchParams(fields)} : {}),
        });
        // Once issued, the mutation may have happened even if facts changed.
        // Acknowledge platform success so the controller can clean up late adds.
        if (discord) { await response.body?.cancel(); return response.status === 204; }
        if (!response.ok) { await response.body?.cancel(); return false; }
        const reader = response.body?.getReader();
        if (!reader) return false;
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            if (size > 4096) throw failed();
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return !!result && typeof result === 'object' && !Array.isArray(result)
          && ('ok' in result && result.ok === true
            || 'ok' in result && result.ok === false && 'error' in result && result.error === absent);
      });
      if (!accepted) throw failed();
    } catch { throw failed(); }
  }
  const effects: PresenceEffects = {
    async reaction(id, add, facts) {
      if (typeof add !== 'boolean' || !(venue.platform === 'discord' ? isDiscordId(id) : slackTs(id))) throw failed();
      if (venue.platform === 'discord') {
        await perform(`channels/${bound.channel}/messages/${id}/reactions/${encodeURIComponent('👀')}/@me`, add ? 'PUT' : 'DELETE', undefined, facts);
      } else {
        await perform(add ? 'reactions.add' : 'reactions.remove', 'POST', {channel:bound.channel,timestamp:id,name:'eyes'}, facts, add ? 'already_reacted' : 'no_reaction');
      }
    },
  };
  if (venue.platform === 'discord') effects.typing = facts => perform(`channels/${bound.channel}/typing`, 'POST', undefined, facts);
  return effects;
}
