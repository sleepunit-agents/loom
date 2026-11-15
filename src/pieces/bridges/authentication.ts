import type { Clock } from '../../core/clock.js';
import type { SecretUse } from '../secrets/role.js';
import { isDiscordId } from './discord-id.js';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const slackId = (value: unknown, prefix: string): value is string => typeof value === 'string' && new RegExp(`^[${prefix}][A-Z0-9]{1,199}$`).test(value);
export type BridgeAuthentication = { bot: string; workspace: string; app?: string };

/** Point-in-time platform evidence, not a household admission decision or token
 * lease. Root supplies the configured bot/workspace and invalidates current on
 * connection or credential changes. Authenticate before binding BridgeChannels
 * or starting ingress. No legacy Venue, permission checks, cache or retry.
 * Slack app-token/socket authentication remains the socket owner's job.
 */
export function bridgeAuthentication(input: {
  platform: 'discord' | 'slack'; bot: string; workspace: string; tokenSecret: string;
  secrets: SecretUse; clock: Clock; current(): boolean; request?: typeof fetch;
}) {
  const { platform, bot, workspace, tokenSecret, secrets, clock } = input;
  const request = input.request ?? fetch;
  return {
    async authenticate(): Promise<BridgeAuthentication | undefined> {
      if (!(platform === 'discord' ? isDiscordId(bot) && isDiscordId(workspace)
        : slackId(bot, 'UW') && slackId(workspace, 'T'))) return undefined;
      let expired = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const abort = new AbortController(), deadlineAt = clock.now() + 15_000;
      const current = () => !expired && clock.now() < deadlineAt && input.current();
      const cancelBody = () => { try { void reader?.cancel().catch(() => {}); } catch { /* discard diagnostics */ } };
      let cancel!: () => void;
      const deadline = new Promise<undefined>(resolve => {
        cancel = clock.at(deadlineAt, () => { expired = true; abort.abort(); cancelBody(); resolve(undefined); });
      });
      async function call(path: string, fields: Record<string, string> = {}): Promise<Json | undefined> {
        if (!current()) return undefined;
        const value = await secrets.withValue(tokenSecret, async token => {
          if (!current()) return undefined;
          const discord = platform === 'discord';
          const response = await request(discord ? `https://discord.com/api/v10/${path}` : `https://slack.com/api/${path}`, {
            method: discord ? 'GET' : 'POST', redirect: 'error', signal: abort.signal,
            headers: discord ? { Authorization: `Bot ${token}` } : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            ...(discord ? {} : { body: new URLSearchParams(fields) }),
          });
          try {
            reader = response.body?.getReader();
            if (!current() || !response.ok || response.redirected || !reader) return undefined;
            const length = response.headers.get('content-length');
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) return undefined;
            const chunks: Buffer[] = []; let size = 0;
            while (current()) {
              const part = await reader.read();
              if (!current()) return undefined;
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 1024 * 1024) return undefined;
              chunks.push(Buffer.from(part.value));
            }
            if (!current()) return undefined;
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            return object(parsed) && (discord || parsed.ok === true) ? parsed : undefined;
          } finally { cancelBody(); }
        });
        return current() ? value : undefined;
      }
      async function read(): Promise<BridgeAuthentication | undefined> {
        if (platform === 'discord') {
          const user = await call('users/@me');
          if (!current() || user?.id !== bot || user.bot !== true) return undefined;
          const guild = await call(`guilds/${workspace}`);
          if (!current() || guild?.id !== workspace || guild.unavailable === true) return undefined;
          return { bot, workspace };
        }
        const auth = await call('auth.test');
        if (!current() || auth?.team_id !== workspace || auth.user_id !== bot || !slackId(auth.bot_id, 'B')) return undefined;
        const info = await call('bots.info', { bot: auth.bot_id, team_id: workspace });
        const found = info?.bot;
        if (!current() || !object(found) || found.id !== auth.bot_id || found.user_id !== bot
          || found.deleted !== false || !slackId(found.app_id, 'A')) return undefined;
        return { bot, workspace, app: found.app_id };
      }
      try { return await Promise.race([read().catch(() => undefined), deadline]); }
      finally { expired = true; cancel(); abort.abort(); cancelBody(); }
    },
  };
}
