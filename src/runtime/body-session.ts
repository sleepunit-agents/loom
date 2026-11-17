/** A body's side of keeping its conversation's harness session (core/conversations/sessions.ts).
 *
 * When the body starts it asks loom for the session the last body of this conversation left, puts its
 * files back where the harness keeps them, and tells the harness to continue it. When it has answered it
 * packs the session's files, hands them to loom and removes them, so that nothing of the conversation is
 * left on the machine the body ran on. The container a body runs in is thrown away, and the next body may
 * run anywhere: loom is the one place a session waits.
 *
 * Where: only where the place the harness keeps its sessions is this body's alone for this one job. A
 * restored session is the conversation's words in plain files. In a house that place is the container's
 * own home (house-layout.ts, houseSessions), thrown away with the body; the account's sign-in is mounted
 * elsewhere. The worker says so (BODY_OWN_HARNESS) unless a mount is, holds, or is inside that place, and
 * the body checks that its harness really keeps its sessions there. A body run as a plain process is never
 * told so: its harness's directory is the machine's, where another conversation's body could read what is
 * left. There no session is kept or restored at all, and the body starts fresh with the conversation's
 * kept history. Nor is the directory ever made here: a harness that has none keeps no session.
 *
 * Everything here is best effort. No session handed over, files that cannot be put back, a session too
 * large to pack: each ends in the body starting fresh with the conversation's kept history, never in a
 * failed job. A packed session is its files as JSON, gzipped; the limits are session-limit.ts.
 */
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { houseSessions } from './house-layout.js';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { bodyCommandClient } from './body-command-client.js';
import { harnessSessionFiles } from './body-harnesses.js';
import { BODY_OWN_HARNESS } from './body-harness.js';
import { SESSION_BYTES, SESSION_FILES, SESSION_ID, SESSION_UNPACKED_BYTES as UNPACKED_BYTES } from '../core/conversations/session-limit.js';

const packed = z.array(z.object({ rel: z.string().min(1).max(1024), data: z.base64() }).strict()).min(1).max(SESSION_FILES);
type Env = Readonly<Record<string, string | undefined>>;
type Client = Pick<ReturnType<typeof bodyCommandClient>, 'command'>;

/** A path of this session's, under the harness's root: `projects/<one directory>/<session>.jsonl`, or
 * anything inside `projects/<one directory>/<session>/`. Nothing else is read from a pack or written. */
export function sessionPath(rel: string, session: string): boolean {
  if (!SESSION_ID.test(session) || normalize(rel) !== rel || rel.includes('\0')) return false;
  const parts = rel.split(sep);
  return parts.length >= 3 && parts[0] === 'projects' && !parts.includes('..') && !parts.includes('.') && !parts.includes('')
    && (parts.length === 3 ? parts[2] === `${session}.jsonl` : parts[2] === session);
}

export function packSession(root: string, files: readonly string[], session: string): string | undefined {
  const kept = files.filter(rel => sessionPath(rel, session));
  if (!kept.length || kept.length > SESSION_FILES) return undefined;
  let size = 0;
  const entries = kept.map(rel => { const bytes = readFileSync(join(root, rel)); size += bytes.byteLength; if (size > UNPACKED_BYTES) throw Error('Session too large'); return { rel, data: bytes.toString('base64') }; });
  const pack = gzipSync(Buffer.from(JSON.stringify(entries)));
  return pack.byteLength <= SESSION_BYTES ? pack.toString('base64') : undefined;
}

/** Writes one file of a pack under `root` without following a link at any step. Each directory on the way
 * is looked at as it is (`lstat`): one that is there must be a real directory, one that is not is made, one
 * level at a time. The file itself is made new, and never through a link (`O_EXCL`, `O_NOFOLLOW`): a file
 * or link already at its place refuses the whole pack. So a link an earlier body left anywhere under the
 * session's path cannot send what is written somewhere else. */
function writeUnfollowed(root: string, rel: string, bytes: Buffer): void {
  const parts = rel.split(sep); let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    let found; try { found = lstatSync(at); } catch { found = undefined; }
    if (!found) { mkdirSync(at, { mode: 0o700 }); found = lstatSync(at); }
    if (!found.isDirectory() || found.isSymbolicLink()) throw Error('Not a directory of the session');
  }
  const handle = openSync(join(at, parts.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { let written = 0; while (written < bytes.byteLength) written += writeSync(handle, bytes, written, bytes.byteLength - written); }
  finally { closeSync(handle); }
}

/** Writes a pack's files under `root`. Throws, leaving behind none of the files it wrote, on anything that
 * is not this session's own, or whose path meets a link or an existing file. `root` is taken as it really
 * is (links in the way to it are the machine's own layout, not a body's doing). */
export function unpackSession(root: string, pack: string, session: string): string[] {
  const entries = packed.parse(JSON.parse(gunzipSync(Buffer.from(pack, 'base64'), { maxOutputLength: UNPACKED_BYTES }).toString('utf8')));
  if (entries.some(entry => !sessionPath(entry.rel, session)) || new Set(entries.map(entry => entry.rel)).size !== entries.length) throw Error('Not this session');
  const real = realpathSync(root), written: string[] = [];
  try {
    for (const entry of entries) { writeUnfollowed(real, entry.rel, Buffer.from(entry.data, 'base64')); written.push(entry.rel); }
    return written;
  } catch (error) { for (const rel of written) rmSync(join(real, rel), { force: true }); throw error; }
}

export interface BodySessions {
  /** Puts the kept session back and answers its id, or nothing: the body then starts fresh. */
  take(): Promise<string | undefined>;
  /** Hands loom the session this run left (or says it left none) and removes its files from this machine. */
  save(session: string | undefined): Promise<void>;
  /** Removes from this machine the session `take` put back, telling loom nothing: for a run that did not answer. */
  discard(): void;
}
/** The keeper for one body, or nothing: its harness keeps no sessions, the worker has not said the place
 * is this body's alone, the harness keeps them somewhere other than the place the worker vouched for
 * (`place`: the layout's, for this harness), or that directory is not there or cannot be written. */
export function bodySessions(client: Client, harness: string, env: Env, place: string | undefined = houseSessions(harness)): BodySessions | undefined {
  const where = (session: string) => harnessSessionFiles(harness, env, session);
  const root = where('probe-session')?.root;
  if (!root || env[BODY_OWN_HARNESS] !== '1' || place === undefined || resolve(root) !== place) return undefined;
  // The harness's own directory as it stands. It is never made here.
  try { if (!lstatSync(realpathSync(root)).isDirectory()) return undefined; accessSync(root, constants.W_OK); } catch { return undefined; }
  const remove = (session: string) => { for (const rel of where(session)?.files ?? []) { try { rmSync(join(root, rel), { force: true }); } catch { /* the container goes with it */ } } };
  let restored: string | undefined;
  return {
    async take() {
      try {
        const reply = await client.command('conversation.session', {}, randomUUID());
        if (!reply.ok) return undefined;
        const kept = z.object({ session: z.object({ session: z.string().regex(SESSION_ID), files: z.string() }).strict().nullable() }).strict().parse(reply.value).session;
        if (kept) { unpackSession(root, kept.files, kept.session); return restored = kept.session; }
      } catch { /* handed something this body cannot use */ }
      // Handed nothing it can continue: whatever loom keeps is of no use to this body and will be behind the
      // conversation once it answers. Say so now, so that it is removed (core/conversations/sessions.ts).
      try { await client.command('conversation.sessionSave', { session: null }, randomUUID()); } catch { /* the sweep and the next save see to it */ }
      return undefined;
    },
    discard() { if (restored) remove(restored); },
    async save(session) {
      let pack: string | undefined;
      try { if (session && SESSION_ID.test(session)) pack = packSession(root, where(session)?.files ?? [], session); } catch { pack = undefined; }
      try {
        const sent = pack ? await client.command('conversation.sessionSave', { session: session!, files: pack }, randomUUID()).catch(() => undefined) : undefined;
        // Nothing to hand on, or loom did not take it: what loom keeps is then behind this run, and it is told so.
        if (!sent?.ok) await client.command('conversation.sessionSave', { session: null }, randomUUID());
      } catch { /* loom will see the session is behind the conversation's last answer */ }
      // The one this run left, and the one it was handed if it went on without it.
      finally { for (const id of new Set([session, restored])) if (id && SESSION_ID.test(id)) remove(id); }
    },
  };
}
