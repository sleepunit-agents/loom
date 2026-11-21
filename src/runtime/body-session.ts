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
 * the body checks that its harness really keeps its sessions there, and that the place and every step
 * from the home down to it is a real directory: a `.claude` that is a link (into a mount, into the
 * sign-in) is somebody else's place whatever it is called. A body run as a plain process is never
 * told so: its harness's directory is the machine's, where another conversation's body could read what is
 * left. There no session is kept or restored at all, and the body starts fresh with the conversation's
 * kept history. Nor is the directory ever made here: a harness that has none keeps no session.
 *
 * Everything here is best effort. No session handed over, files that cannot be put back, a session too
 * large to pack: each ends in the body starting fresh with the conversation's kept history, never in a
 * failed job. A packed session is its files as JSON, gzipped; the limits are session-limit.ts.
 */
import { accessSync, constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { bodyCommandClient } from './body-command-client.js';
import { harnessSessions } from './body-harnesses.js';
import { BODY_OWN_HARNESS, type Harness } from './body-harness.js';
import { HOUSE_HOME, houseSessions } from './house-layout.js';
import { directoriesUnfollowed, readUnfollowed, removeUnfollowed, unmake, writeUnfollowed } from './unfollowed.js';
import { SESSION_BYTES, SESSION_FILES, SESSION_HISTORY_KEYS, SESSION_ID, SESSION_UNPACKED_BYTES as UNPACKED_BYTES } from '../core/conversations/session-limit.js';

const packed = z.array(z.object({ rel: z.string().min(1).max(1024), data: z.base64() }).strict()).min(1).max(SESSION_FILES);
type Env = Readonly<Record<string, string | undefined>>;
type Client = Pick<ReturnType<typeof bodyCommandClient>, 'command'>;
/** How one harness keeps sessions (body-harness.ts). Which paths are a session's is the harness's to say. */
type Layout = NonNullable<Harness['sessions']>;

/** Packs a session's files, each read through one open file that is checked to be that file, with no link
 * followed at any step (unfollowed.ts). Nothing, when there is no file, too many, or the pack is too large. */
export function packSession(layout: Layout, root: string, session: string): string | undefined {
  const kept = layout.files(root, session).filter(rel => layout.owns(rel, session));
  if (!kept.length || kept.length > SESSION_FILES) return undefined;
  let size = 0;
  const entries = kept.map(rel => { const bytes = readUnfollowed(root, rel, UNPACKED_BYTES - size); size += bytes.byteLength; return { rel, data: bytes.toString('base64') }; });
  const pack = gzipSync(Buffer.from(JSON.stringify(entries)));
  return pack.byteLength <= SESSION_BYTES ? pack.toString('base64') : undefined;
}

/** Writes a pack's files under `root`, following no link at any step and writing over nothing
 * (unfollowed.ts). Throws on anything that is not this session's own, or whose path meets a link or an
 * existing file, and then takes away every file and directory it had made: a refused pack leaves nothing. */
export function unpackSession(layout: Layout, root: string, pack: string, session: string): string[] {
  const entries = packed.parse(JSON.parse(gunzipSync(Buffer.from(pack, 'base64'), { maxOutputLength: UNPACKED_BYTES }).toString('utf8')));
  if (entries.some(entry => !layout.owns(entry.rel, session)) || new Set(entries.map(entry => entry.rel)).size !== entries.length) throw Error('Not this session');
  const made = { directories: [] as string[], files: [] as string[] };
  try {
    for (const entry of entries) writeUnfollowed(root, entry.rel, Buffer.from(entry.data, 'base64'), made);
    return entries.map(entry => entry.rel);
  } catch (error) { unmake(made); throw error; }
}

export interface BodySessions {
  /** Puts the kept session back and answers its id, or nothing: the body then starts fresh. */
  take(now?: () => number): Promise<string | undefined>;
  /** Absolute deadline of the files put back by take. */
  readonly keepUntil?: string;
  /** A coordinator predating keyed history accepts the original take and save shapes only. */
  historyKeys?: boolean;
  /** Hashes of the bridge records already represented in the restored harness session. */
  covered?: readonly string[];
  /** Pack and remove the session files. Count retention from the oldest erasable input. */
  save(session: string | undefined, since?: string, covered?: string[], keepUntil?: string): Promise<void>;
  /** Removes from this machine the session `take` put back, telling loom nothing: for a run that did not answer. */
  discard(): void;
}
/** The keeper for one body, or nothing: its harness keeps no sessions; the worker has not said the place
 * is this body's alone; the harness keeps them somewhere other than the place the worker vouched for
 * (`place`: the layout's, for this harness); the place, or a step from the home (`home`) down to it, is not
 * a real directory; or it cannot be written. */
export function bodySessions(client: Client, harness: string, env: Env, place: string | undefined = houseSessions(harness), home: string = HOUSE_HOME): BodySessions | undefined {
  const layout = harnessSessions(harness);
  if (!layout || env[BODY_OWN_HARNESS] !== '1' || place === undefined || resolve(layout.root(env)) !== place) return undefined;
  // The place as it stands, never made here, and reached through no link from the home down.
  if (place !== home && !place.startsWith(home + sep)) return undefined;
  if (!directoriesUnfollowed(home, place === home ? '' : place.slice(home.length + 1))) return undefined;
  try { accessSync(place, constants.W_OK); } catch { return undefined; }
  const root = place;
  const remove = (session: string) => { for (const rel of layout.files(root, session).filter(file => layout.owns(file, session)).reverse()) removeUnfollowed(root, rel); };
  let restored: string | undefined, covered: string[] | undefined, historyKeys=true, retention=true;
  let inheritedStart:string|undefined, inheritedEnd:string|undefined;
  return {
    get historyKeys(){return historyKeys;},
    get covered(){return covered;},
    get keepUntil(){return inheritedEnd;},
    async take(now = Date.now) {
      let reply;
      try {
        reply = await client.command('conversation.session', {historyKeys:true,retention:true}, randomUUID());
        if (!reply.ok && reply.code==='invalid') {
          retention=false;
          reply=await client.command('conversation.session', {historyKeys:true}, randomUUID());
        }
        if(!reply.ok && reply.code==='invalid'){
          historyKeys=false;
          reply=await client.command('conversation.session', {}, randomUUID());
        }
      } catch { return undefined; } // A lost response tells us nothing about the stored session.
      if (!reply.ok) return undefined;
      try {
        const kept = z.object({ session: z.object({ session: z.string().regex(SESSION_ID), files: z.string(), since:z.iso.datetime({offset:true}).optional(), keepUntil:z.iso.datetime({offset:true}).optional(), covered:z.array(z.hash('sha256')).max(SESSION_HISTORY_KEYS).optional() }).strict().nullable() }).strict().parse(reply.value).session;
        if (kept && (!kept.keepUntil || now() < Date.parse(kept.keepUntil))) { unpackSession(layout, root, kept.files, kept.session); covered=kept.covered;inheritedStart=kept.since;inheritedEnd=kept.keepUntil;return restored = kept.session; }
      } catch { /* handed something this body cannot use */ }
      // Handed nothing it can continue: whatever loom keeps is of no use to this body and will be behind the
      // conversation once it answers. Say so now, so that it is removed (core/conversations/sessions.ts).
      try { await client.command('conversation.sessionSave', { session: null }, randomUUID()); } catch { /* the sweep and the next save see to it */ }
      return undefined;
    },
    discard() { if (restored) remove(restored); },
    async save(session, since, knownKeys, keepUntil) {
      if (inheritedStart && (!since || Date.parse(inheritedStart)<Date.parse(since))) since=inheritedStart;
      if (inheritedEnd && (!keepUntil || Date.parse(inheritedEnd)<Date.parse(keepUntil))) keepUntil=inheritedEnd;
      let pack: string | undefined;
      try { if (session && SESSION_ID.test(session) && (retention || !keepUntil)) pack = packSession(layout, root, session); } catch { pack = undefined; }
      try {
        const sent = pack ? await client.command('conversation.sessionSave', { session: session!, files: pack, ...(historyKeys && knownKeys ? {covered:knownKeys} : {}), ...(since ? { since } : {}), ...(keepUntil ? {keepUntil} : {}) }, randomUUID()) : undefined;
        // Nothing to hand on, or loom did not take it: what loom keeps is then behind this run, and it is told so.
        if (!sent?.ok) await client.command('conversation.sessionSave', { session: null }, randomUUID());
      } catch { /* A save may have committed. Leave the row for the next body's freshness check. */ }
      // The one this run left, and the one it was handed if it went on without it.
      finally { for (const id of new Set([session, restored])) if (id && SESSION_ID.test(id)) remove(id); }
    },
  };
}
