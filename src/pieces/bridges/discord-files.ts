/** Fetches the attachments of one delivered Discord message, to be kept in bridge_files beside Slack's.
 *
 * A Discord attachment's link is signed by Discord and needs no credential, so none is used here. Only a
 * link on Discord's own file hosts is fetched, with no redirect followed. Each file is on its own: one
 * that cannot be fetched (too large, gone, refused, an HTML page) is left out and the rest are kept, and
 * the message's words still carry every link (normalize.ts). Nothing is stored and nothing is retried
 * here; the caller keeps what comes back and decides whether to ask again.
 */
import { z } from 'zod';
import { isDiscordId } from './discord-id.js';
import { HANDED_FILE_BYTES } from './files.js';
import { SLACK_FILES_PER_MESSAGE } from './slack-files.js';
import { discordFileLink } from './discord-link.js';
import { plainFileName } from './file-name.js';

/** As many of a message's attachments as are kept: the same count as a Slack message's. */
export const DISCORD_FILES_PER_MESSAGE = SLACK_FILES_PER_MESSAGE;
const FETCH_MS = 15_000;
const descriptor = z.object({ id: z.string(), filename: z.string().max(4096), size: z.number().int().nonnegative(), url: z.string().max(8192) }).passthrough();
export interface DiscordFile { id: string; name: string; url: string }
export interface FetchedDiscordFile { id: string; name: string; bytes: Buffer }

/** The attachments of a MESSAGE_CREATE frame that are worth fetching: the first few, each with a Discord
 * id, a link on Discord's hosts and a stated size a body can be handed. Anything else is only a link. */
export function discordFiles(data: unknown): DiscordFile[] {
  const list = z.object({ attachments: z.array(z.unknown()).optional() }).passthrough().safeParse(data);
  if (!list.success) return [];
  return (list.data.attachments ?? []).slice(0, DISCORD_FILES_PER_MESSAGE).flatMap(raw => {
    const file = descriptor.safeParse(raw);
    return file.success && isDiscordId(file.data.id) && file.data.size <= HANDED_FILE_BYTES && discordFileLink(file.data.url)
      ? [{ id: file.data.id, name: plainFileName(file.data.filename), url: file.data.url }] : [];
  });
}

export async function fetchDiscordFiles(files: readonly DiscordFile[], current: () => boolean, request: typeof fetch = fetch): Promise<FetchedDiscordFile[]> {
  const fetched: FetchedDiscordFile[] = [];
  for (const file of files.slice(0, DISCORD_FILES_PER_MESSAGE)) {
    if (!current()) break;
    if (!discordFileLink(file.url)) continue;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Buffer[] = [];
    try {
      const response = await request(file.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
      reader = response.body?.getReader();
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), length = response.headers.get('content-length');
      if (response.status !== 200 || response.redirected || !reader || type === 'text/html' || type === 'application/xhtml+xml'
        || length !== null && (!/^\d+$/.test(length) || Number(length) > HANDED_FILE_BYTES)) continue;
      let size = 0, whole = true;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > HANDED_FILE_BYTES || !current()) { whole = false; break; }
        chunks.push(Buffer.from(part.value));
      }
      if (whole) fetched.push({ id: file.id, name: file.name, bytes: Buffer.concat(chunks) });
    } catch { /* this file is only a link */ }
    finally { void reader?.cancel().catch(() => {}); }
  }
  return fetched;
}
