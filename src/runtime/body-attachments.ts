/** Writes the attachments of the bridge messages a body took into the body's own scratch directory before
 * the harness starts, and says where they are, so a model with file tools can open a picture it was sent.
 *
 * The files are the ones loom keeps for the message (bridge_files, read through `bridges.file` as this
 * body). A failure is described alongside any saved paths. The scratch directory is the body's alone and goes with it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { bodyCommandClient } from './body-command-client.js';
import { discordAttachmentLabels } from '../pieces/bridges/discord-link.js';
import { plainFileName } from '../pieces/bridges/file-name.js';

import { BODY_ATTACHMENTS, BODY_ATTACHMENT_BYTES, discordFileOutcome, HANDED_FILE_BYTES } from '../pieces/bridges/attachment-limits.js';
export { BODY_ATTACHMENTS, BODY_ATTACHMENT_BYTES } from '../pieces/bridges/attachment-limits.js';
const listed = z.object({ files: z.array(z.object({ file: z.string(), name: z.string(), bytes: z.number().int().nonnegative(), fetchedAt: z.string(), contents: z.string().optional() }).strict()) }).strict();

type Commands = Pick<ReturnType<typeof bodyCommandClient>, 'command'>;

/** Labels are for display only. The daemon derives the count, IDs and signed URLs from Discord. */
async function prepareDiscordAttachments(client: Commands, incoming: string, words: string, budget: { files: number; bytes: number }): Promise<string[]> {
  const labels = discordAttachmentLabels(words).map(label=>label.name);
  const unavailable: string[] = [];
  let count = 1;
  for (let index = 0; index < count; index++) {
    if (!budget.files) {
      for (const name of (index===0?labels:labels.slice(-count).slice(index))) unavailable.push(name + ' (run attachment limit)');
      break;
    }
    try {
      const prepared = await client.command('bridges.prepareFile', { incoming, index, maxBytes: budget.bytes }, randomUUID());
      if (!prepared.ok) throw Error();
      const outcome = discordFileOutcome.parse(prepared.value);
      count = outcome.count;
      const name = labels.slice(-count)[index] ?? `Attachment ${index + 1}`;
      if (outcome.state === 'saved' || outcome.state === 'unavailable' && count) {
        budget.files--;
        budget.bytes -= outcome.bytes;
      }
      if (outcome.state === 'saved') continue;
      if (outcome.state === 'changed') {
        unavailable.push('The Discord message changed. Only previously saved files can be opened.');
        break;
      } else if (outcome.state === 'absent') {
        if (labels.length) unavailable.push('Discord no longer lists the attachments.');
        break;
      } else if (!count) {
        unavailable.push('Discord could not return the original message.');
        break;
      } else {
        const reason = { limit: 'run attachment limit', 'too-large': 'too large or unavailable from Discord', unavailable: 'download failed' }[outcome.state];
        unavailable.push(`${name} (${reason})`);
      }
    } catch {
      // A lost response can follow a completed download. Its size and outcome are unknown.
      budget.files--;
      budget.bytes -= Math.min(budget.bytes, HANDED_FILE_BYTES);
      unavailable.push('Discord attachments could not be retrieved.');
      break;
    }
  }
  return unavailable;
}

/** Returns the saved paths and any attachments the body could not open. */
export async function saveBodyAttachments(client: Commands, incoming: readonly string[], scratch: string | undefined,
  write: (path: string, bytes: Buffer) => void = (path, bytes) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); }, discordMessages?: ReadonlyMap<string,string>): Promise<string | null> {
  if (!incoming.length) return null;
  if (!scratch) return discordMessages?.size ? 'Attachments cannot be opened because this body has no scratch directory.' : null;
  const lines: string[] = [], unavailable: string[] = [], directory = join(scratch, 'attachments-' + randomUUID());
  const preparation = {files:BODY_ATTACHMENTS,bytes:BODY_ATTACHMENT_BYTES};
  let readFiles = 0, readBytes = 0;
  messages: for (const message of incoming) {
    try {
      const words = discordMessages?.get(message);
      const labels = words === undefined ? [] : discordAttachmentLabels(words);
      if (discordMessages && words === undefined) continue;
      if (words !== undefined) {
        // Files read from the pre-upgrade cache also consume this run's scratch allowance.
        preparation.files = Math.min(preparation.files, BODY_ATTACHMENTS - readFiles);
        preparation.bytes = Math.min(preparation.bytes, BODY_ATTACHMENT_BYTES - readBytes);
        unavailable.push(...await prepareDiscordAttachments(client, message, words, preparation));
      }
      const list = await client.command('bridges.file', { incoming: message }, randomUUID());
      if (!list.ok) { if (discordMessages?.has(message)) unavailable.push('Kept attachments could not be listed.'); continue; }
      for (const file of listed.parse(list.value).files) {
        const name = plainFileName(file.name);
        // Discord may now be unreachable. The original message still records how long its file was.
        const originals = labels.filter(label => plainFileName(label.name) === name);
        if (originals.length && !originals.some(label => label.bytes === file.bytes)) {
          unavailable.push(name + ' (incomplete cached file)'); continue;
        }
        if (readFiles >= BODY_ATTACHMENTS || readBytes + file.bytes > BODY_ATTACHMENT_BYTES) {
          if (!discordMessages) break messages;
          unavailable.push(name + ' (run attachment limit)'); continue;
        }
        if (discordMessages) { readFiles++; readBytes += file.bytes; }
        try {
          const whole = await client.command('bridges.file', { incoming: message, file: file.file }, randomUUID());
          const contents = whole.ok && listed.parse(whole.value).files[0]?.contents;
          if (typeof contents !== 'string') { if (discordMessages) unavailable.push(name + ' (read failed)'); continue; }
          const bytes = Buffer.from(contents, 'base64');
          try {
            if (discordMessages && bytes.byteLength !== file.bytes) { unavailable.push(name + ' (size changed)'); continue; }
            const path = join(directory, `${lines.length + 1}-${name}`);
            write(path, bytes);
            if (!discordMessages) { readFiles++; readBytes += bytes.byteLength; }
            lines.push(`- ${path} (${name}, ${bytes.byteLength} bytes)`);
          } finally { bytes.fill(0); }
        } catch { if (!discordMessages) break messages; unavailable.push(name + ' (read or write failed)'); }
      }
    } catch { if (!discordMessages) break; unavailable.push('Attachments could not be listed.'); }
  }
  return [lines.length ? 'Files sent with these messages are saved here for you to open:\n' + lines.join('\n') : '',
    unavailable.length ? 'Attachments you cannot open: ' + unavailable.join(', ') : ''].filter(Boolean).join('\n') || null;
}
