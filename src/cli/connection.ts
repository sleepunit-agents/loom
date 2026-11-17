/** How a program outside the daemon reaches it and proves itself: LOOM_URL and LOOM_TOKEN_FILE.
 * One reading of the token file for every client (`loom-token` and its siblings, `loom-taskstore`,
 * `loom mcp`, and the worker), so a file one of them accepts is accepted by all.
 *
 * The address is one rule too: `privateOrigin` (src/core/private-origin.ts), which every program that sends
 * a credential uses. https, or plain http to this machine only: a token is never sent in the clear to
 * another machine. */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { privateOrigin } from '../core/private-origin.js';

/** What went wrong, in words a client may print. Never carries any part of the token. */
export class ConnectionError extends Error {}

/** A token file is small; anything larger is not one. */
const TOKEN_FILE_BYTES = 8192;
/** A token is printable ASCII with no space in it. Surrounding whitespace (a final newline) is not part of it. */
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** The token a file's text holds. For a caller that is handed the file as text (the worker, whose reader is
 * its own so tests can supply it); everyone else reads through readDoorToken, which also wipes the bytes. */
export function doorTokenIn(text: string): string {
  if (Buffer.byteLength(text) > TOKEN_FILE_BYTES) throw new ConnectionError('Token file is not a token');
  const token = text.trim();
  if (!token) throw new ConnectionError('Token file is empty');
  if (!TOKEN.test(token)) throw new ConnectionError('Token file is not a token');
  return token;
}
/** The token a file's bytes hold. The caller's buffer is wiped whether or not it held one. */
function tokenIn(bytes: Buffer): string {
  try {
    if (bytes.length > TOKEN_FILE_BYTES) throw new ConnectionError('Token file is not a token');
    return doorTokenIn(bytes.toString('utf8'));
  } finally { bytes.fill(0); }
}
export async function readDoorToken(file: string | undefined): Promise<string> {
  if (!file) throw new ConnectionError('LOOM_TOKEN_FILE is required');
  return tokenIn(await readFile(file));
}
export function readDoorTokenSync(file: string): string { return tokenIn(readFileSync(file)); }

/** The daemon's address for a command-line client: an origin and nothing else, by the one rule. */
export function doorUrl(value: string | undefined): URL {
  if (!value) throw new ConnectionError('LOOM_URL is required');
  try { return privateOrigin(value); }
  catch { throw new ConnectionError('Invalid LOOM_URL: use https, or http to this machine only'); }
}
/** Both, from a client's environment. Any failure that is not one of the above (an unreadable file) is reported plainly. */
export async function doorConnection(env: NodeJS.ProcessEnv): Promise<{ base: URL; token: string }> {
  try { return { base: doorUrl(env.LOOM_URL), token: await readDoorToken(env.LOOM_TOKEN_FILE) }; }
  catch (error) { throw error instanceof ConnectionError ? error : new ConnectionError('Cannot configure loom connection'); }
}
