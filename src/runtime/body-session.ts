/** A body's side of keeping its conversation's harness session (core/conversations/sessions.ts).
 *
 * When the body starts it asks loom for the session the last body of this conversation left, puts its
 * files back where the harness keeps them, and tells the harness to continue it. When it has answered it
 * packs the session's files, hands them to loom and removes them, so that nothing of the conversation is
 * left on the machine the body ran on. The container a body runs in is thrown away, and the next body may
 * run anywhere: loom is the one place a session waits.
 *
 * Everything here is best effort. No session handed over, files that cannot be put back, a session too
 * large to pack: each ends in the body starting fresh with the conversation's kept history, never in a
 * failed job. A packed session is its files as JSON, gzipped; the limits are session-limit.ts.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { bodyCommandClient } from './body-command-client.js';
import { harnessSessionFiles } from './body-harnesses.js';
import { SESSION_BYTES, SESSION_FILES, SESSION_ID } from '../core/conversations/session-limit.js';

/** The most a packed session may unpack to: a bound on what loom's answer can make this process hold. */
const UNPACKED_BYTES = 64 * 1024 * 1024;
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

/** Writes a pack's files under `root`. Throws, having written nothing it leaves behind, on anything that
 * is not this session's own. */
export function unpackSession(root: string, pack: string, session: string): string[] {
  const entries = packed.parse(JSON.parse(gunzipSync(Buffer.from(pack, 'base64'), { maxOutputLength: UNPACKED_BYTES }).toString('utf8')));
  if (entries.some(entry => !sessionPath(entry.rel, session)) || new Set(entries.map(entry => entry.rel)).size !== entries.length) throw Error('Not this session');
  const written: string[] = [];
  try {
    for (const entry of entries) {
      mkdirSync(dirname(join(root, entry.rel)), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, entry.rel), Buffer.from(entry.data, 'base64'), { mode: 0o600 });
      written.push(entry.rel);
    }
    return written;
  } catch (error) { for (const rel of written) rmSync(join(root, rel), { force: true }); throw error; }
}

export interface BodySessions {
  /** Puts the kept session back and answers its id, or nothing: the body then starts fresh. */
  take(): Promise<string | undefined>;
  /** Hands loom the session this run left (or says it left none) and removes its files from this machine. */
  save(session: string | undefined): Promise<void>;
  /** Removes from this machine the session `take` put back, telling loom nothing: for a run that did not answer. */
  discard(): void;
}
/** The keeper for one body, or nothing when its harness keeps no sessions or cannot write where it keeps them. */
export function bodySessions(client: Client, harness: string, env: Env): BodySessions | undefined {
  const where = (session: string) => harnessSessionFiles(harness, env, session);
  const root = where('probe-session')?.root;
  if (!root) return undefined;
  // The harness's own directory, made if only it is missing; never a path built up from nothing.
  try { if (!existsSync(root)) mkdirSync(root, { mode: 0o700 }); accessSync(root, constants.W_OK); } catch { return undefined; }
  const remove = (session: string) => { for (const rel of where(session)?.files ?? []) { try { rmSync(join(root, rel), { force: true }); } catch { /* the container goes with it */ } } };
  let restored: string | undefined;
  return {
    async take() {
      try {
        const reply = await client.command('conversation.session', {}, randomUUID());
        if (!reply.ok) return undefined;
        const kept = z.object({ session: z.object({ session: z.string().regex(SESSION_ID), files: z.string() }).strict().nullable() }).strict().parse(reply.value).session;
        if (!kept) return undefined;
        unpackSession(root, kept.files, kept.session);
        return restored = kept.session;
      } catch { return undefined; }
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
