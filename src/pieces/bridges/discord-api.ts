/** Fresh Discord REST evidence. No admission, receipt storage or registration. */
import type { SecretUse } from '../secrets/role.js';
import type { Venue } from './model.js';
import type { DiscordChannel } from './discord.js';

type Json = Record<string, unknown>;
const object = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
const snowflake = (x: unknown): x is string => typeof x === 'string' && /^[1-9]\d{0,19}$/.test(x) && BigInt(x) <= 18446744073709551615n;
const setup = (v: Venue) => v.enabled && v.platform === 'discord' && snowflake(v.bot) && snowflake(v.workspace);
class Refused extends Error {}
export interface DiscordPlace { channel: string; user: string; dm: boolean }
/** Composition supplies the service's SecretUse and current lifetime/staging gate.
 * Every HTTP call reacquires authority; no token or metadata cache survives it. */
export function discordApi(secrets: SecretUse, beforeRead: () => boolean, request: typeof fetch = fetch) {
  async function read(venue: Venue, path: string): Promise<Json | 'refused'> {
    if (!beforeRead()) throw Error('Discord read held');
    // A holder may complete after setup, staging or the lifetime has changed.
    return secrets.withValue(venue.tokenSecret, async token => {
      if (!beforeRead()) throw Error('Discord read held');
      const response = await request(`https://discord.com/api/v10/${path}`, {
        method:'GET', redirect:'error', signal:AbortSignal.timeout(15_000),
        headers:{Authorization:`Bot ${token}`},
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Only a completed platform refusal is final. Credential, rate-limit and
        // server errors wait for repair/retry; upstream text is never reflected.
        return response.status === 403 || response.status === 404 ? 'refused' : Promise.reject(Error('Discord unavailable'));
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error('Discord unavailable');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 1024*1024) throw Error('Discord reply too large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(parsed)) throw Error('Discord unavailable');
      return parsed;
    });
  }
  async function call(venue: Venue, path: string): Promise<Json> {
    const result = await read(venue,path);
    // Classify outside withValue: the holder sanitizes callback exceptions.
    if (!beforeRead()) throw Error('Discord lifetime ended');
    if (result === 'refused') throw new Refused();
    return result;
  }
  return {
    /** Bot-token identity and access to the configured guild, never an authority
     * lease. Composition must recreate after setup/credential-generation changes. */
    async authenticate(input: Venue): Promise<{bot:string;workspace:string} | 'wait'> {
      const venue = structuredClone(input);
      if (!setup(venue)) return 'wait';
      try {
        const user = await call(venue,'users/@me');
        if (user.id !== venue.bot || user.bot !== true) return 'wait';
        const guild = await call(venue,`guilds/${venue.workspace}`);
        if (guild.id !== venue.workspace || guild.unavailable === true) return 'wait';
        return {bot:venue.bot,workspace:venue.workspace};
      } catch { return 'wait'; }
    },
    /** Resolve fresh channel kind/parent and safe labels. Runtime still gates
     * linked people, peers, paired webhooks and routes. Group DMs are unsupported. */
    async channel(input: Venue, inputPlace: DiscordPlace): Promise<DiscordChannel | 'drop' | 'wait'> {
      const venue = structuredClone(input), place = {...inputPlace};
      if (!setup(venue) || !snowflake(place.channel) || !snowflake(place.user) || typeof place.dm !== 'boolean') return 'wait';
      try {
        const ch = await call(venue,`channels/${place.channel}`);
        if (ch.id !== place.channel || !Number.isInteger(ch.type)) return 'wait';
        if (place.dm) {
          if (ch.guild_id !== undefined && ch.guild_id !== null && !snowflake(ch.guild_id)) return 'wait';
          if (ch.type !== 1 || ch.guild_id !== undefined && ch.guild_id !== null) return 'drop';
          if (!Array.isArray(ch.recipients) || ch.recipients.length !== 1 || !object(ch.recipients[0]) || !snowflake(ch.recipients[0].id)) return 'wait';
          if (ch.recipients[0].id !== place.user || place.user === venue.bot) return 'drop';
          return {id:place.channel,kind:'dm'};
        }
        if (!snowflake(ch.guild_id)) return 'wait';
        if (ch.guild_id !== venue.workspace) return 'drop';
        if (ch.type === 0 || ch.type === 5) return {id:place.channel,kind:'channel',...(typeof ch.name === 'string' ? {name:ch.name} : {})};
        if (![10,11,12].includes(ch.type as number)) return 'drop';
        if (!snowflake(ch.parent_id) || ch.parent_id === ch.id) return 'wait';
        const parent = await call(venue,`channels/${ch.parent_id}`);
        if (parent.id !== ch.parent_id || !snowflake(parent.guild_id) || !Number.isInteger(parent.type)) return 'wait';
        if (parent.guild_id !== venue.workspace) return 'drop';
        if (![0,5,15,16].includes(parent.type as number)) return 'drop';
        // Never return the thread name: Discord may derive it from private words.
        return {id:place.channel,kind:'thread',parent:ch.parent_id,...(typeof parent.name === 'string' ? {parentName:parent.name} : {})};
      } catch (error) { return error instanceof Refused ? 'drop' : 'wait'; }
    },
  };
}
