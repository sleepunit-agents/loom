/** What a harness's own sign-in files on this machine say: signed in or not, and when the sign-in ends where
 * the files say. A read of one local file. Nothing is asked of the provider, nothing is spent, and no token
 * leaves this function: only the state, an end time and a fixed reason are returned.
 *
 * This is the worker's own knowledge of the harnesses loom runs, so that a household needs no program of
 * its own to know its sign-ins. A harness not listed here is not watched.
 *
 * The files cannot say that a provider has withdrawn a sign-in early. A job that got a model reply is the
 * evidence that one works (AccountLogins.replied); this is the evidence that one is missing or ending. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LoginRead { state: 'signed-in' | 'signed-out'; expiresAt?: string; why?: string }
type Read = (path: string) => Promise<string>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const out = (why: string): LoginRead => ({ state: 'signed-out', why });

/** The file as written, or why there is no sign-in to read from it. */
async function file(read: Read, path: string): Promise<{ json: Record<string, unknown> } | { none: LoginRead }> {
  let text: string;
  try { text = await read(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { none: out('There is no sign-in file.') };
    // Unreadable is not signed out: the caller leaves what was last learned as it is.
    throw new Error('Sign-in file unreadable');
  }
  try { return { json: object(JSON.parse(text)) }; } catch { return { none: out('The sign-in file cannot be read as written.') }; }
}

const readers: Record<string, (directory: string, read: Read, now: number) => Promise<LoginRead>> = {
  /** Claude Code keeps the time its renewing token ends, which is when a person has to sign in again. */
  async claude(directory, read, now) {
    const found = await file(read, join(directory, '.credentials.json'));
    if ('none' in found) return found.none;
    const login = object(found.json.claudeAiOauth);
    if (!filled(login.refreshToken)) return out('The sign-in file holds no sign-in.');
    const ends = login.refreshTokenExpiresAt;
    if (typeof ends !== 'number' || !Number.isFinite(ends) || ends <= 0 || ends > 8.64e15) return { state: 'signed-in' };
    const expiresAt = new Date(ends).toISOString();
    return ends <= now ? out(`The sign-in ended on ${expiresAt.slice(0, 10)}.`) : { state: 'signed-in', expiresAt };
  },
  /** Codex keeps no end time for a sign-in: it is there or it is not. */
  async codex(directory, read) {
    const found = await file(read, join(directory, 'auth.json'));
    if ('none' in found) return found.none;
    return filled(object(found.json.tokens).refresh_token) || filled(found.json.OPENAI_API_KEY) ? { state: 'signed-in' } : out('The sign-in file holds no sign-in.');
  },
};

/** Whether this harness's sign-in is one the worker can read. */
export const watchesLogin = (harness: string) => Object.hasOwn(readers, harness);
/** Throws when the file is there and cannot be read: that is not knowing, which is not signed out. */
export function readLogin(harness: string, directory: string, options: { read?: Read; now?: () => number } = {}): Promise<LoginRead> {
  if (!watchesLogin(harness)) throw new Error('Sign-in of this harness is not watched');
  return readers[harness](directory, options.read ?? (path => readFile(path, 'utf8')), (options.now ?? Date.now)());
}
