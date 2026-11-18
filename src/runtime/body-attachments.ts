/** Writes the attachments of the bridge messages a body took into the body's own scratch directory before
 * the harness starts, and says where they are, so a model with file tools can open a picture it was sent.
 *
 * The files are the ones loom keeps for the message (bridge_files, read through `bridges.file` as this
 * body). Best effort: a file that cannot be read or written is left out, the message's words still carry
 * its link, and nothing here fails the job. The scratch directory is the body's alone and goes with it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { bodyCommandClient } from './body-command-client.js';
import { plainFileName } from '../pieces/bridges/file-name.js';

/** The most files written for one run, across every message it took. */
export const BODY_ATTACHMENTS = 10;
/** The most bytes written for one run. */
export const BODY_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const listed = z.object({ files: z.array(z.object({ file: z.string(), name: z.string(), bytes: z.number().int().nonnegative(), fetchedAt: z.string(), contents: z.string().optional() }).strict()) }).strict();

/** Returns the words to add to the body's input, or null when nothing was written. */
export async function saveBodyAttachments(client: Pick<ReturnType<typeof bodyCommandClient>, 'command'>, incoming: readonly string[], scratch: string | undefined,
  write: (path: string, bytes: Buffer) => void = (path, bytes) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); }): Promise<string | null> {
  if (!scratch || !incoming.length) return null;
  const lines: string[] = [], directory = join(scratch, 'attachments-' + randomUUID()); let total = 0;
  try {
    for (const message of incoming) {
      const list = await client.command('bridges.file', { incoming: message }, randomUUID());
      if (!list.ok) continue;
      for (const file of listed.parse(list.value).files) {
        if (lines.length >= BODY_ATTACHMENTS || total + file.bytes > BODY_ATTACHMENT_BYTES) return finish();
        const whole = await client.command('bridges.file', { incoming: message, file: file.file }, randomUUID());
        if (!whole.ok) continue;
        const contents = listed.parse(whole.value).files[0]?.contents;
        if (contents === undefined) continue;
        const bytes = Buffer.from(contents, 'base64');
        try {
          const path = join(directory, `${lines.length + 1}-${plainFileName(file.name)}`);
          write(path, bytes); total += bytes.byteLength;
          lines.push(`- ${path} (${plainFileName(file.name)}, ${bytes.byteLength} bytes)`);
        } finally { bytes.fill(0); }
      }
    }
  } catch { /* what was written so far is still worth naming */ }
  return finish();
  function finish() { return lines.length ? 'Files sent with these messages are saved here for you to open:\n' + lines.join('\n') : null; }
}
