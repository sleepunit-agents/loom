/** Unregistered platform evidence for describe. Runtime owns people, tiers,
 * restrictions, brief selection and caller authority; this never starts a body. */
import type { SecretUse } from '../secrets/role.js';
import { venueSchema, type Venue } from './model.js';

export interface SlackDescribePermit {
  readonly agent: string;
  readonly venue: string;
  readonly workspace: string;
  readonly kind: 'dm' | 'group';
  /** A human user id for dm, an existing MPIM channel id for group. */
  readonly place: string;
  /** Owning authentication, setup, credential lifetime and exact-place policy. */
  current(): boolean;
}
export interface SlackDescribeEvidence { kind: 'dm' | 'group'; place: string; humans: string[] }
type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const userId = (v: unknown): v is string => typeof v === 'string' && /^[UW][A-Z0-9]{1,199}$/.test(v);
const failed = () => Error('Bridge describe unavailable');

/** Fresh reads only: no intake cache, open, post, stored evidence or public input.
 * Every request reacquires the service credential. Results are all-or-nothing. */
export function slackDescribe(input: Venue, permit: SlackDescribePermit, secrets: SecretUse,
  beforeRead: () => boolean, request: typeof fetch = fetch) {
  const venue = venueSchema.parse(structuredClone(input));
  const bound = {agent:permit.agent,venue:permit.venue,workspace:permit.workspace,kind:permit.kind,place:permit.place};
  const valid = venue.enabled && venue.platform === 'slack' && bound.agent === venue.agent
    && bound.venue === venue.id && bound.workspace === venue.workspace && /^T[A-Z0-9]{1,199}$/.test(bound.workspace)
    && userId(venue.bot) && (bound.kind === 'dm' ? userId(bound.place) && bound.place !== venue.bot && bound.place !== 'USLACKBOT'
      : bound.kind === 'group' && /^G[A-Z0-9]{1,199}$/.test(bound.place));
  const current = () => valid && Object.entries(bound).every(([k,v]) => permit[k as keyof typeof bound] === v)
    && permit.current() && beforeRead();
  async function call(method: string, fields: Record<string,string>): Promise<Json> {
    if (!current()) throw failed();
    const result = await secrets.withValue(venue.tokenSecret, async token => {
      if (!current()) throw failed();
      const response = await request(`https://slack.com/api/${method}`, {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(15_000),
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams(fields),
      });
      if (!current() || !response.ok) { await response.body?.cancel(); throw failed(); }
      const reader = response.body?.getReader();
      if (!reader) throw failed();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          if (!current()) throw failed();
          const next = await reader.read();
          if (!current()) throw failed();
          if (next.done) break;
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
    async describe(): Promise<SlackDescribeEvidence> {
      try {
        if (!current()) throw failed();
        let humans: string[];
        if (bound.kind === 'dm') humans = [bound.place];
        else {
          const {channel} = await call('conversations.info',{channel:bound.place});
          if (!object(channel) || channel.id !== bound.place || channel.is_mpim !== true || channel.is_im !== false
            || ['is_ext_shared','is_org_shared'].some(k => channel[k] !== undefined && channel[k] !== false)) throw failed();
          const members = new Set<string>(), cursors = new Set<string>(); let cursor = '', pages = 0;
          do {
            if (++pages > 50) throw failed();
            const page = await call('conversations.members',{channel:bound.place,limit:'200',...(cursor?{cursor}:{})});
            if (!Array.isArray(page.members) || page.members.length > 200 || !page.members.every(userId)) throw failed();
            for (const member of page.members) {
              if (members.has(member) || members.size >= 10_000) throw failed();
              members.add(member);
            }
            if (!object(page.response_metadata) || typeof page.response_metadata.next_cursor !== 'string') throw failed();
            cursor = page.response_metadata.next_cursor;
            if (cursor && (cursor.length > 2000 || cursors.has(cursor))) throw failed();
            cursors.add(cursor);
          } while (cursor);
          if (!members.has(venue.bot) || members.size < 3) throw failed();
          humans = [...members].filter(id => id !== venue.bot);
        }
        for (const id of humans) {
          if (id === 'USLACKBOT') throw failed();
          const {user} = await call('users.info',{user:id});
          if (!object(user) || user.id !== id || user.team_id !== bound.workspace
            || ['deleted','is_bot','is_restricted','is_ultra_restricted'].some(k => user[k] !== false)
            || (user.is_stranger !== undefined && user.is_stranger !== false)) throw failed();
        }
        if (!current()) throw failed();
        // Id order is deterministic. Runtime maps ids to people and sorts names.
        return {kind:bound.kind,place:bound.place,humans:humans.sort()};
      } catch { throw failed(); }
    },
  };
}
