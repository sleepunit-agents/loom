/** What a person sees while an agent works on their Discord message: a reaction on the message once a job
 * has taken it, and the typing indicator in its channel while that job runs. Both are read from what the
 * database says (mail a running job has taken and not yet answered) and shown by the daemon, never by a
 * body. The reaction comes off when the mail is settled: by the reply, or by the job ending.
 *
 * Best effort throughout. Nothing here writes the database, and nothing that fails here is retried beyond
 * the next pass or reported as a failure of the job, the mail or the connection. Which messages carry the
 * reaction is remembered only in memory, so a restart can leave one behind (docs/accepted-tradeoffs.md,
 * "Taken and working are shown on Discord, best effort"). Slack is not shown: its app has no reactions
 * scope and Slack gives bots no typing call.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming, conversations, inbox, inboxRefs, jobs } from '../../core/data/schema.js';
import type { SecretUse } from '../secrets/role.js';
import { placeAddress, placeClosed } from '../../shared-place-mail.js';
import { isDiscordId } from './discord-id.js';
import { parseIncomingId } from './keys.js';

/** The reaction that says a job has taken a message: 👀, as the earlier bridge showed. */
export const TAKEN_REACTION = '\u{1F440}';
/** Discord shows typing for ten seconds after it is asked for; asking this often keeps it showing. */
export const TYPING_EVERY_MS = 5000;
const CALL_MS = 10_000;
/** Presence is optional. Leave the bot's shared request capacity for replies and file operations. */
const BURST_PER_SECOND = 8;

interface Channel { connection: string; channel: string }
interface Working extends Channel { message?: string }
type Taken = Channel & { message: string };
/** Every channel owed a reply. Only an identifiable human message gets a reaction. */
export function workingOn(db: DataDatabase): Working[] {
  const running = and(eq(inbox.state, 'taken'), eq(jobs.state, 'running'), eq(inbox.toKind, 'agent'),
    eq(inbox.to, jobs.agent), eq(inbox.conversation, jobs.conversation));
  const messages = db.selectDistinct({ id: bridgeIncoming.id, connection: bridgeIncoming.connection, channel: bridgeIncoming.channel,
    bot: bridgeIncoming.bot, webhook: bridgeIncoming.webhook, member: bridgeIncoming.member }).from(inbox)
    .innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id)).innerJoin(bridgeIncoming, eq(bridgeIncoming.id, inboxRefs.ref))
    .innerJoin(jobs, eq(jobs.id, inbox.job)).innerJoin(bridgeConnections, eq(bridgeConnections.id, bridgeIncoming.connection))
    .where(and(running, eq(inbox.source, 'discord'), eq(bridgeIncoming.state, 'delivered'),
      eq(bridgeConnections.platform, 'discord'), eq(bridgeConnections.enabled, true))).all();
  const result: Working[] = messages.map(row => {
    const human = !row.webhook && (row.bot === false || (row.bot === null && row.member !== null));
    const message = human && parseIncomingId(row.id, row.connection);
    return { connection: row.connection, channel: row.channel, ...(message ? {message} : {}) };
  });
  const placed = db.selectDistinct({ id: conversations.id, venue: conversations.venue, place: conversations.place, agent: conversations.agent })
    .from(inbox).innerJoin(jobs, eq(jobs.id, inbox.job)).innerJoin(conversations, eq(conversations.id, jobs.conversation))
    .where(and(running, eq(conversations.venue, 'discord'), inArray(inbox.source, ['trigger', 'handoff']), isNotNull(inbox.words))).all();
  for (const cv of placed) {
    const at = placeAddress(db, cv);
    if (at && !placeClosed(db, cv)) result.push({connection: at.connection, channel: at.channel});
  }
  return result;
}

/** Calls through one connection. Local throttling and Discord's rate limits defer the request.
 * A missing resource or permission suppresses that effect for the rest of this work. */
type CallResult = boolean | 'deferred' | 'denied';
export interface PresenceCalls { react(channel: string, message: string, on: boolean): Promise<CallResult>; typing(channel: string): Promise<CallResult> }
export function bridgePresenceApi(input: { tokenSecret: string; secrets: SecretUse; clock: Clock; current(): boolean; request?: typeof fetch }): PresenceCalls {
  let nextCallAt = 0, windowEnds = 0, remaining = 0;
  const call = async (method: 'PUT' | 'DELETE' | 'POST', path: string): Promise<CallResult> => {
    try {
      const now = input.clock.now();
      if (now < nextCallAt) return 'deferred';
      if (!input.current()) return false;
      if (now >= windowEnds) { windowEnds = now + 1000; remaining = BURST_PER_SECOND; }
      if (remaining === 0) return 'deferred';
      remaining--;
      return await input.secrets.withValue<CallResult>(input.tokenSecret, async token => {
        if (!input.current()) return false;
        // Caught here, inside the use of the credential: an error that left this callback would retire the
        // connection's whole lifetime (shared-secret-use.ts), and a reaction is not worth a reconnect.
        try {
          const response = await (input.request ?? fetch)(`https://discord.com/api/v10/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(CALL_MS), headers: { Authorization: `Bot ${token}` } });
          try {
            const limited = response.status === 429;
            if (limited || response.headers.get('X-RateLimit-Remaining') === '0') {
              let seconds = Number(response.headers.get(limited ? 'Retry-After' : 'X-RateLimit-Reset-After'));
              if (limited && !(seconds > 0)) seconds = Number((await response.json().catch(() => null))?.retry_after);
              nextCallAt = input.clock.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : TYPING_EVERY_MS);
              if (limited) return 'deferred';
            }
            if (response.status === 403 || response.status === 404) return 'denied';
            return response.ok;
          } finally { void response.body?.cancel().catch(() => {}); }
        } catch { return false; }
      });
    } catch { return false; }
  };
  const ids = (...values: string[]) => values.every(isDiscordId);
  return {
    react: async (channel, message, on) => ids(channel, message) && call(on ? 'PUT' : 'DELETE', `channels/${channel}/messages/${message}/reactions/${encodeURIComponent(TAKEN_REACTION)}/@me`),
    typing: async channel => ids(channel) && call('POST', `channels/${channel}/typing`),
  };
}

/** Shows what `workingOn` says. One pass at a time; a pass asked for while one runs is run after it. */
export class BridgePresence {
  private readonly shown = new Map<string, Taken>();
  private readonly attempted = new Map<string, number>();
  private readonly typed = new Map<string, number>();
  private running?: Promise<void>;
  private again = false;
  /** `calls` answers the calls for a connection that can be used now, or nothing. */
  constructor(private db: DataDatabase, private clock: Clock, private calls: (connection: string) => PresenceCalls | undefined) {}

  show(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = Promise.resolve().then(async () => { do { this.again = false; await this.pass(); } while (this.again); })
      .catch(() => { /* best effort: nothing here is anybody's failure */ }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async pass(): Promise<void> {
    const key = (row: Working) => JSON.stringify([row.connection, row.channel, row.message]);
    const working = workingOn(this.db);
    const wanted = new Map(working.filter((row): row is Taken => !!row.message).map(row => [key(row), row]));
    const now = this.clock.now();
    const channels = new Map(working.map(row => [JSON.stringify([row.connection, row.channel]), row]));
    for (const id of this.typed.keys()) if (!channels.has(id)) this.typed.delete(id);
    for (const [id, row] of channels) {
      if (this.again) return;
      if (now - (this.typed.get(id) ?? -Infinity) < TYPING_EVERY_MS) continue;
      const result = await this.calls(row.connection)?.typing(row.channel);
      if (result !== 'deferred') this.typed.set(id, result === 'denied' ? Infinity : now);
    }
    for (const id of this.attempted.keys()) if (!wanted.has(id)) this.attempted.delete(id);
    for (const [id, row] of wanted) {
      if (this.again) return;
      const now = this.clock.now();
      if (this.shown.has(id) || now < (this.attempted.get(id) ?? 0)) continue;
      const result = await this.calls(row.connection)?.react(row.channel, row.message, true);
      if (result === true) this.shown.set(id, row);
      else if (result !== 'deferred') this.attempted.set(id, result === 'denied' ? Infinity : now + TYPING_EVERY_MS);
    }
    for (const [id, row] of [...this.shown]) {
      if (wanted.has(id)) continue;
      if (this.again) return;
      const result = await this.calls(row.connection)?.react(row.channel, row.message, false);
      if (result !== 'deferred') this.shown.delete(id);
    }
  }
}
