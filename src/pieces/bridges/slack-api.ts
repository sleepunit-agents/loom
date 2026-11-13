/** Slack Web API reads. Composition supplies the bridges SERVICE's SecretUse.
 * No token is retained, returned or included in errors. No intake cache. */
import type { SecretUse } from '../secrets/service.js';
import type { Venue, Message } from './model.js';
import type { Inspection } from './role.js';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,199}$/.test(value);
const denied = new Set(['channel_not_found', 'not_in_channel', 'user_not_found', 'user_not_visible']);
class Refused extends Error {}
/** beforeRead is the composition root's staging gate, evaluated before EVERY call.
 * A held read returns wait. HTTP is injectable only for in-process fixtures.
 * No retry here: the durable bridge queue owns retry/backoff.
 */
export function slackApi(secrets: SecretUse, beforeRead: () => boolean, request: typeof fetch = fetch) {
  async function call(venue: Venue, method: string, fields: Record<string, string>): Promise<Json> {
    if (!beforeRead()) throw Error('Read held');
    // secretUseRole normalizes callback exceptions; classify the response afterwards.
    const result = await secrets.withValue(venue.tokenSecret, async token => {
      const response = await request(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      });
      if (!response.ok) throw Error('Slack unavailable');
      // A bounded reply also bounds member pagination memory. Never reflect its text.
      const reader = response.body?.getReader();
      if (!reader) throw Error('Slack unavailable');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 1024 * 1024) throw Error('Slack reply too large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(parsed)) throw Error('Slack unavailable');
      return parsed;
    });
    if (result.ok !== true) {
      if (result.ok === false && typeof result.error === 'string' && denied.has(result.error)) throw new Refused();
      throw Error('Slack unavailable');
    }
    return result;
  }
  return {
    /** Returns platform evidence only. Runtime still admits each linked human.
     * Unknown flags and incomplete pagination fail closed as wait.
     */
    async inspect(venue: Venue, message: Message): Promise<Inspection> {
      if (venue.platform !== 'slack' || message.user === venue.bot) return 'drop';
      if (!id(venue.workspace) || !id(venue.bot) || !id(message.channel) || !id(message.user)) return 'wait';
      try {
        const info = await call(venue, 'conversations.info', { channel: message.channel });
        const channel = info.channel;
        if (!object(channel) || channel.id !== message.channel) return 'wait';
        if (typeof channel.is_im !== 'boolean' || typeof channel.is_mpim !== 'boolean' || (channel.is_im && channel.is_mpim)) return 'wait';
        const group = !!message.group || !message.channel.startsWith('D');
        if (group ? channel.is_mpim !== true : channel.is_im !== true) return 'drop';
        // Slack IM info identifies the other participant. Never trust the event alone.
        if (!group && !id(channel.user)) return 'wait';
        if (!group && channel.user !== message.user) return 'drop';
        const members: string[] = [];
        if (group) {
          const cursors = new Set<string>(); let cursor = '';
          do {
            const page = await call(venue, 'conversations.members', { channel: message.channel, limit: '200', ...(cursor ? {cursor} : {}) });
            if (!Array.isArray(page.members) || !page.members.every(id)) return 'wait';
            members.push(...page.members);
            if (members.length > 10_000 || new Set(members).size !== members.length) return 'wait';
            if (!object(page.response_metadata) || typeof page.response_metadata.next_cursor !== 'string') return 'wait';
            cursor = page.response_metadata.next_cursor;
            if (cursor && (cursor.length > 2000 || cursors.has(cursor))) return 'wait';
            cursors.add(cursor);
          } while (cursor);
          if (!members.includes(venue.bot) || !members.includes(message.user) || members.length < 3) return 'drop';
        } else members.push(venue.bot, message.user);
        for (const member of members.filter(value => value !== venue.bot)) {
          const result = await call(venue, 'users.info', { user: member });
          const user = result.user;
          if (!object(user) || user.id !== member) return 'wait';
          if (!id(user.team_id) || ['deleted', 'is_bot', 'is_restricted', 'is_ultra_restricted'].some(flag => typeof user[flag] !== 'boolean')
            || (user.is_stranger !== undefined && typeof user.is_stranger !== 'boolean')) return 'wait';
          if (user.team_id !== venue.workspace || user.deleted !== false || user.is_bot !== false || user.is_restricted !== false || user.is_ultra_restricted !== false || user.is_stranger === true || user.id === 'USLACKBOT') return 'drop';
        }
        return { kind: 'allow', members };
      } catch (error) { return error instanceof Refused ? 'drop' : 'wait'; }
    },
  };
}
