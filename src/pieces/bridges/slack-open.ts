/** Unregistered first-DM transport. Runtime must supply recipient authority;
 * platform eligibility and a People link never grant permission to contact them. */
import type { SecretUse } from '../secrets/role.js';
import { venueSchema, type Venue } from './model.js';

/** Trusted owning role, never public input. current() includes authenticated bot
 * setup, credential-generation lifetime and current recipient authorization. */
export interface SlackRecipient {
  readonly agent: string;
  readonly venue: string;
  readonly workspace: string;
  readonly user: string;
  current(): boolean;
}
type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const userId = (v: unknown): v is string => typeof v === 'string' && /^[UW][A-Z0-9]{1,199}$/.test(v);
const failed = () => Error('Bridge DM open attempt uncertain');

/** One open attempt; no posting, caching, local retry, receipt or registration.
 * Opening is an outside effect even without message words. The composition gate
 * and exact recipient proof are checked after EVERY service credential acquisition.
 */
export function slackOpen(input: Venue, recipient: SlackRecipient, secrets: SecretUse,
  beforeEffect: () => boolean, request: typeof fetch = fetch) {
  const venue = venueSchema.parse(structuredClone(input));
  const bound = {agent:recipient.agent,venue:recipient.venue,workspace:recipient.workspace,user:recipient.user};
  const valid = venue.enabled && venue.platform === 'slack' && bound.agent === venue.agent
    && bound.venue === venue.id && bound.workspace === venue.workspace && /^T[A-Z0-9]{1,199}$/.test(bound.workspace)
    && userId(venue.bot) && userId(bound.user) && bound.user !== venue.bot && bound.user !== 'USLACKBOT';
  const current = () => valid && Object.entries(bound).every(([k,v]) => recipient[k as keyof typeof bound] === v)
    && recipient.current() && beforeEffect();
  async function call(method: string, fields: Record<string,string>): Promise<Json> {
    if (!current()) throw failed();
    const result = await secrets.withValue(venue.tokenSecret, async token => {
      if (!current()) throw failed();
      const response = await request(`https://slack.com/api/${method}`, {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(15_000),
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams(fields),
      });
      if (!response.ok) { await response.body?.cancel(); throw failed(); }
      const reader = response.body?.getReader();
      if (!reader) throw failed();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 1024 * 1024) throw failed();
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(parsed) || parsed.ok !== true) throw failed();
      return parsed;
    });
    if (!current()) throw failed();
    return result;
  }
  return {
    async open(): Promise<{channel:string}> {
      try {
        // Same-workspace human eligibility, independent of authority to contact.
        const {user} = await call('users.info',{user:bound.user});
        if (!object(user) || user.id !== bound.user || user.team_id !== bound.workspace
          || ['deleted','is_bot','is_restricted','is_ultra_restricted'].some(k => user[k] !== false)
          || (user.is_stranger !== undefined && user.is_stranger !== false)) throw failed();
        const {channel} = await call('conversations.open',{users:bound.user,return_im:'true'});
        if (!object(channel) || typeof channel.id !== 'string' || !/^D[A-Z0-9]{1,199}$/.test(channel.id)
          || channel.is_im !== true || channel.user !== bound.user || channel.is_mpim === true
          || channel.is_org_shared === true || channel.is_ext_shared === true) throw failed();
        return {channel:channel.id};
      } catch { throw failed(); }
    },
  };
}
