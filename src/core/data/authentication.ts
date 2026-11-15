import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Authentication } from '../live/index.js';
import type { DataDatabase } from './database.js';
import { tokens, sessions, members, agents, boxes } from './schema.js';

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
/** Shared-schema token/session authentication. Only fingerprints are looked up;
 * a database fingerprint is never accepted as the credential itself. Bearer wins
 * over cookies, including malformed bearer input. This issues no credentials.
 */
export function dataAuthentication(db: DataDatabase, now: () => number = Date.now) {
  return (request: Request): (Authentication & { readonly job?: string }) | undefined => {
    const authorization = request.headers.get('authorization');
    const bearer = authorization === null ? undefined : /^Bearer ([^\s]{32,4096})$/i.exec(authorization)?.[1];
    if (authorization !== null && !bearer) return;
    const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('loom_ui='))?.slice(8);
    if (!bearer && (!cookie || !/^[a-zA-Z0-9_-]{32,4096}$/.test(cookie))) return;
    const sessionId = bearer ? undefined : fingerprint(cookie!);
    const tokenId = bearer ? fingerprint(bearer) : db.select({ token: sessions.token }).from(sessions).where(eq(sessions.id, sessionId!)).get()?.token;
    if (!tokenId) return;
    const current = () => {
      const token = db.select().from(tokens).where(eq(tokens.fingerprint, tokenId)).get();
      const time = now();
      if (!token || token.revokedAt || (token.expiresAt !== null && Date.parse(token.expiresAt) <= time)) return;
      let expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : undefined;
      if (sessionId) {
        const session = db.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.token, tokenId))).get();
        if (!session) return;
        const sessionEnd = Date.parse(session.issuedAt) + (session.isAgent ? 6 * 3600000 : 30 * 86400000);
        if (sessionEnd <= time) return;
        expiresAt = Math.min(expiresAt ?? Infinity, sessionEnd);
      }
      const viewer = token.kind === 'owner' && token.member && db.select({ id: members.id }).from(members).where(eq(members.id, token.member)).get()
        ? { kind: 'member' as const, id: token.member }
        : token.kind === 'agent' && token.agent && db.select({ id: agents.id }).from(agents).where(eq(agents.id, token.agent)).get()
          ? { kind: 'agent' as const, id: token.agent }
          : token.kind === 'runner' && token.box && db.select({ id: boxes.id }).from(boxes).where(eq(boxes.id, token.box)).get()
            ? { kind: 'runner' as const, id: token.box } : undefined;
      return viewer ? { viewer, expiresAt, job: token.kind === 'agent' ? token.job ?? undefined : undefined } : undefined;
    };
    const admitted = current();
    if (!admitted) return;
    return { ...admitted, window: !!sessionId, valid() {
      const live = current();
      return !!live && live.viewer.kind === admitted.viewer.kind && live.viewer.id === admitted.viewer.id && live.job === admitted.job;
    } };
  };
}
