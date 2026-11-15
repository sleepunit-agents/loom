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
  return {
    async channel(id: string): Promise<Json | undefined> {
      const valid = platform === 'discord' ? /^\d{1,20}$/.test(id) && /^\d{1,20}$/.test(workspace)
        : /^[A-Z][A-Z0-9]{1,199}$/.test(id) && /^T[A-Z0-9]{1,199}$/.test(workspace);
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
      const read = async (): Promise<Json | undefined> => {
        if (!current()) return undefined;
        const result = await secrets.withValue(tokenSecret, async token => {
          if (!current()) return undefined;
          const discord = platform === 'discord';
          const response = await request(discord ? `https://discord.com/api/v10/channels/${id}` : 'https://slack.com/api/conversations.info', {
            method: discord ? 'GET' : 'POST', redirect: 'error', signal: abort.signal,
            headers: discord ? { Authorization: `Bot ${token}` } : {
              Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded',
            },
            ...(discord ? {} : { body: new URLSearchParams({ channel: id, team_id: workspace }) }),
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
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!object(body)) return undefined;
            const channel = discord ? body : body.ok === true ? body.channel : undefined;
            return object(channel) && channel.id === id ? channel : undefined;
          } finally { cancelBody(); }
        });
        return current() ? result : undefined;
      };
      try {
        const result = await Promise.race([read().catch(() => undefined), deadline]);
        return current() ? result : undefined;
      }
      finally { expired = true; cancel(); abort.abort(); cancelBody(); }
    },
  };
}
