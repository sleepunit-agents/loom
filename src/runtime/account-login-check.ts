/** What a harness's own sign-in files on this machine say: signed in or not, and when the sign-in ends where
 * the files say. A read of one local file. Nothing is asked of the provider, nothing is spent, and no token
 * leaves this function: only the state, an end time and a fixed reason are returned.
 *
 * This is the worker's own knowledge of the harnesses loom runs, so that a household needs no program of
 * its own to know its sign-ins. A harness not listed here is not watched.
 *
 * The files cannot say that a provider has withdrawn a sign-in early. A job that got a model reply is the
 * evidence that one works (AccountLogins.replied); this is the evidence that one is missing or ending. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

/** Why a sign-in is not there, as one of a fixed set of words. Loom writes the sentence (account-logins.ts). */
export const LOGIN_REASONS = ['no-file', 'no-sign-in', 'ended'] as const;
export type LoginReason = typeof LOGIN_REASONS[number];
export interface LoginRead { state: 'signed-in' | 'signed-out'; expiresAt?: string; why?: LoginReason }
type Read = (path: string) => Promise<string>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** The last instant of the year 9999: the latest time the household database keeps. */
const LAST_MS = 253_402_300_799_999;
/** The start of 2020: before any sign-in this reader could meet. */
const FIRST_MS = 1_577_836_800_000;
/** More than any sign-in file holds. A larger file is not one. */
const FILE_BYTES = 1024 * 1024;

/** The sign-in directory houses mount is writable by the bodies that run there, so the name the worker opens
 * in it may be anything a body could make: a link to another path, a pipe that never answers, a device
 * with no end. Only an ordinary file of ordinary size is read. The link is not followed, the open does not
 * wait on a pipe, and the kind and size are asked of the open file itself, so they cannot change between
 * the asking and the reading. Anything else is unreadable, which is not knowing. */
async function ordinaryFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const found = await handle.stat();
    if (!found.isFile() || found.size > FILE_BYTES) throw new Error('Not a sign-in file');
    const bytes = Buffer.alloc(found.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > found.size) throw new Error('Not a sign-in file');
    return bytes.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}
const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const out = (why: LoginReason): LoginRead => ({ state: 'signed-out', why });

/** The file as written, or why there is no sign-in to read from it. */
async function file(read: Read, path: string): Promise<{ json: Record<string, unknown> } | { none: LoginRead }> {
  let text: string;
  try { text = await read(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { none: out('no-file') };
    // Unreadable is not signed out: the caller leaves what was last learned as it is.
    throw new Error('Sign-in file unreadable');
  }
  // A harness rewrites this file when it renews a token, so a read can land on half of it. That is not
  // knowing either, and the next read settles it.
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error('Sign-in file unreadable'); }
  // Whole JSON that is not an object is not a sign-in file this reader knows: not knowing, again.
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('Sign-in file unreadable');
  return { json: json as Record<string, unknown> };
}

const readers = {
  /** Claude Code keeps the time its renewing token ends, which is when a person has to sign in again. */
  async claude(directory: string, read: Read, now: number): Promise<LoginRead> {
    const found = await file(read, join(directory, '.credentials.json'));
    if ('none' in found) return found.none;
    const login = object(found.json.claudeAiOauth);
    if (!filled(login.refreshToken) && !filled(login.accessToken)) return out('no-sign-in');
    const ends = login.refreshTokenExpiresAt;
    // An end that is no time loom can keep (not a number, or past the year 9999) is no known end, and neither
    // is one so early that it was written in another unit (seconds read as milliseconds fall in 1970).
    if (typeof ends !== 'number' || !Number.isFinite(ends) || ends < FIRST_MS || ends > LAST_MS) return { state: 'signed-in' };
    const expiresAt = new Date(ends).toISOString();
    return ends <= now ? out('ended') : { state: 'signed-in', expiresAt };
  },
  /** Codex keeps no end time for a sign-in: it is there or it is not. */
  async codex(directory: string, read: Read): Promise<LoginRead> {
    const found = await file(read, join(directory, 'auth.json'));
    if ('none' in found) return found.none;
    const tokens = object(found.json.tokens);
    return filled(tokens.refresh_token) || filled(tokens.access_token) || filled(found.json.OPENAI_API_KEY) ? { state: 'signed-in' } : out('no-sign-in');
  },
};

/** The harnesses whose sign-in the worker can read: the only ones a sign-in record can name. */
export const LOGIN_HARNESSES = ['claude', 'codex'] as const satisfies readonly (keyof typeof readers)[];
/** Whether this harness's sign-in is one the worker can read. */
export const watchesLogin = (harness: string) => (LOGIN_HARNESSES as readonly string[]).includes(harness);
/** Throws when the file is there and cannot be read or is not whole: that is not knowing, which is not signed out. */
export async function readLogin(harness: string, directory: string, options: { read?: Read; now?: () => number } = {}): Promise<LoginRead> {
  if (!watchesLogin(harness)) throw new Error('Sign-in of this harness is not watched');
  return readers[harness as typeof LOGIN_HARNESSES[number]](directory, options.read ?? ordinaryFile, (options.now ?? Date.now)());
}
