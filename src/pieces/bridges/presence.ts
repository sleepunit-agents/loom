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
import { and, eq, inArray } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { claimedJobStates } from '../../core/data/job-states.js';
import { bridgeConnections, bridgeIncoming, inbox, inboxRefs, jobs } from '../../core/data/schema.js';
import type { SecretUse } from '../secrets/role.js';
import { isDiscordId } from './discord-id.js';
import { parseIncomingId } from './keys.js';

/** The reaction that says a job has taken a message: 👀, as the earlier bridge showed. */
export const TAKEN_REACTION = '\u{1F440}';
/** Discord shows typing for ten seconds after it is asked for; asking this often keeps it showing. */
export const TYPING_EVERY_MS = 5000;
const CALL_MS = 10_000;

export interface Working { connection: string; channel: string; message: string }
/** The Discord messages a claimed job has taken and not yet answered, on connections that are in use. */
export function workingOn(db: DataDatabase): Working[] {
  return db.selectDistinct({ id: bridgeIncoming.id, connection: bridgeIncoming.connection, channel: bridgeIncoming.channel }).from(inbox)
    .innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id)).innerJoin(bridgeIncoming, eq(bridgeIncoming.id, inboxRefs.ref))
    .innerJoin(jobs, eq(jobs.id, inbox.job)).innerJoin(bridgeConnections, eq(bridgeConnections.id, bridgeIncoming.connection))
    .where(and(eq(inbox.state, 'taken'), inArray(jobs.state, claimedJobStates), eq(bridgeIncoming.state, 'delivered'),
      eq(bridgeConnections.platform, 'discord'), eq(bridgeConnections.enabled, true))).all()
    .flatMap(row => { const message = parseIncomingId(row.id, row.connection); return message ? [{ connection: row.connection, channel: row.channel, message }] : []; });
}

/** The three calls, each already bound to one connection's credential. Each answers whether Discord took
 * it and never throws. */
export interface PresenceCalls { react(channel: string, message: string, on: boolean): Promise<boolean>; typing(channel: string): Promise<boolean> }
export function bridgePresenceApi(input: { tokenSecret: string; secrets: SecretUse; current(): boolean; request?: typeof fetch }): PresenceCalls {
  const call = async (method: 'PUT' | 'DELETE' | 'POST', path: string): Promise<boolean> => {
    try {
      if (!input.current()) return false;
      return await input.secrets.withValue(input.tokenSecret, async token => {
        if (!input.current()) return false;
        // Caught here, inside the use of the credential: an error that left this callback would retire the
        // connection's whole lifetime (shared-secret-use.ts), and a reaction is not worth a reconnect.
        try {
          const response = await (input.request ?? fetch)(`https://discord.com/api/v10/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(CALL_MS), headers: { Authorization: `Bot ${token}` } });
          try { return response.ok; } finally { void response.body?.cancel().catch(() => {}); }
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
  private readonly shown = new Map<string, Working>();
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
    const wanted = new Map(workingOn(this.db).map(row => [key(row), row]));
    for (const [id, row] of wanted) {
      if (this.shown.has(id)) continue;
      // Shown only once Discord has it: a refused reaction is tried again on a later pass, while it is wanted.
      if (await this.calls(row.connection)?.react(row.channel, row.message, true)) this.shown.set(id, row);
    }
    for (const [id, row] of [...this.shown]) {
      if (wanted.has(id)) continue;
      // Forgotten whatever Discord answers: a reaction that cannot be taken off is not asked about for ever.
      this.shown.delete(id);
      await this.calls(row.connection)?.react(row.channel, row.message, false);
    }
    const now = this.clock.now(), channels = new Map([...wanted.values()].map(row => [JSON.stringify([row.connection, row.channel]), row]));
    for (const id of [...this.typed.keys()]) if (!channels.has(id)) this.typed.delete(id);
    for (const [id, row] of channels) {
      if (now - (this.typed.get(id) ?? -Infinity) < TYPING_EVERY_MS) continue;
      this.typed.set(id, now);
      await this.calls(row.connection)?.typing(row.channel);
    }
  }
}
