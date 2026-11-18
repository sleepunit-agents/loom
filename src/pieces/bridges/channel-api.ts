import { isDiscordId } from './discord-id.js';
import type { Clock } from '../../core/clock.js';
import type { SecretUse } from '../secrets/role.js';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_BYTES = 1024 * 1024;

/** Metadata reads for an already authenticated connection. Root owns bot/workspace
 * authentication and invalidates current() when its connection or credential
 * changes. Pass the result to the bound BridgeChannels writer, which validates
 * channel kind/workspace. No legacy admission policy, retry, cache or DB writes.
 * Missing/refused/malformed results all leave the raw receipt waiting for retry.
 */
export function bridgeChannelApi(input: {
  platform: 'discord' | 'slack'; workspace: string; tokenSecret: string;
  secrets: SecretUse; clock: Clock; current(): boolean; request?: typeof fetch;
}) {
  const { platform, workspace, tokenSecret, secrets, clock } = input;
  const request = input.request ?? fetch;
  const discord = platform === 'discord';
  /** One bounded read of one JSON answer, with the connection's credential. Undefined for anything but a
   * whole, current, well-formed answer that `pick` accepts. */
  async function read<T>(valid: boolean, url: string, body: URLSearchParams | undefined, pick: (answer: unknown) => T | undefined): Promise<T | undefined> {
      if (!valid) return undefined;
      let expired = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const abort = new AbortController();
      const deadlineAt = clock.now() + 15_000;
      const current = () => !expired && clock.now() < deadlineAt && input.current();
      const cancelBody = () => { try { void reader?.cancel().catch(() => {}); } catch { /* no upstream diagnostics */ } };
      let cancel!: () => void;
      const deadline = new Promise<undefined>(resolve => {
        cancel = clock.at(deadlineAt, () => {
          expired = true; abort.abort(); cancelBody(); resolve(undefined);
        });
      });
      const once = async (): Promise<T | undefined> => {
        if (!current()) return undefined;
        const result = await secrets.withValue(tokenSecret, async token => {
          if (!current()) return undefined;
          const response = await request(url, {
            method: discord ? 'GET' : 'POST', redirect: 'error', signal: abort.signal,
            headers: discord ? { Authorization: `Bot ${token}` } : {
              Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded',
            },
            ...(discord ? {} : { body }),
          });
          try {
            reader = response.body?.getReader();
            if (!current() || !response.ok || response.redirected || !reader) return undefined;
            const length = response.headers.get('content-length');
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return undefined;
            const chunks: Buffer[] = []; let size = 0;
            while (current()) {
              const part = await reader.read();
              if (!current()) return undefined;
              if (part.done) break;
              size += part.value.byteLength;
              if (size > MAX_BYTES) return undefined;
              chunks.push(Buffer.from(part.value));
            }
            if (!current()) return undefined;
            return pick(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } finally { cancelBody(); }
        });
        return current() ? result : undefined;
      };
      try {
        const result = await Promise.race([once().catch(() => undefined), deadline]);
        return current() ? result : undefined;
      }
      finally { expired = true; cancel(); abort.abort(); cancelBody(); }
  }
  return {
    channel(id: string): Promise<Json | undefined> {
      const valid = discord ? isDiscordId(id) && isDiscordId(workspace)
        : /^[A-Z][A-Z0-9]{1,199}$/.test(id) && /^T[A-Z0-9]{1,199}$/.test(workspace);
      return read(valid, discord ? `https://discord.com/api/v10/channels/${id}` : 'https://slack.com/api/conversations.info',
        discord ? undefined : new URLSearchParams({ channel: id, team_id: workspace }), answer => {
          if (!object(answer)) return undefined;
          const channel = discord ? answer : answer.ok === true ? answer.channel : undefined;
          return object(channel) && channel.id === id ? channel : undefined;
        });
    },
    /** Discord only. Who wrote the message a thread was started from: a thread made from a message has
     * that message's id. Undefined when there is no such message (a thread made on its own, a deleted
     * starter) or it cannot be read; the thread then hangs under nobody's message. */
    starter(parent: string, thread: string): Promise<string | undefined> {
      return read(discord && isDiscordId(parent) && isDiscordId(thread) && isDiscordId(workspace),
        `https://discord.com/api/v10/channels/${parent}/messages/${thread}`, undefined, answer =>
          object(answer) && answer.id === thread && answer.channel_id === parent && object(answer.author) && isDiscordId(answer.author.id) ? answer.author.id : undefined);
    },
    /** Discord only. The guild's roles, as Discord lists them; BridgeChannels reads which are a bot's own. */
    roles(): Promise<unknown[] | undefined> {
      return read(discord && isDiscordId(workspace), `https://discord.com/api/v10/guilds/${workspace}/roles`, undefined,
        answer => Array.isArray(answer) ? answer : undefined);
    },
  };
}
