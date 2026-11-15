/** Current credential claims at the outside door. Never derive authority from a
 * caller's Viewer label, job argument, or an installed-module name. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { tokens, sessions, jobs, boxes } from './core/data/schema.js';
import type { Authentication } from './core/live/index.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const active = new Set(['starting', 'running', 'waiting']);
export function sharedCredentials(db: DataDatabase, clock: Clock, admitted: () => boolean = () => true, write: (action: () => void) => void = action => { db.transaction(action); }) {
  const resolve = dataAuthentication(db, () => clock.now());
  const identity = { fingerprint: tokens.fingerprint, kind: tokens.kind, member: tokens.member, agent: tokens.agent, job: tokens.job, box: tokens.box };
  type Token = Pick<typeof tokens.$inferSelect, keyof typeof identity>;
  type Proof = { token: Token; session?: string; bearer: boolean; valid(): boolean; box?: string };
  const proofs = new WeakMap<Viewer, Proof>();
  type BoundJob = Pick<typeof jobs.$inferSelect, 'agent' | 'box' | 'conversation' | 'member' | 'project'>;
  const bodyJob = (token: Token, bound?: BoundJob) => {
    if (token.kind !== 'agent' || !token.job || !token.agent) return;
    const job = db.select({ id: jobs.id, agent: jobs.agent, box: jobs.box, conversation: jobs.conversation, member: jobs.member, project: jobs.project, state: jobs.state }).from(jobs).where(eq(jobs.id, token.job)).get();
    if (!job || job.agent !== token.agent || !active.has(job.state) || !job.box) return;
    if (bound && (['agent', 'box', 'conversation', 'member', 'project'] as const).some(key => job[key] !== bound[key])) return;
    const machine = db.select({ revokedAt: boxes.revokedAt }).from(boxes).where(eq(boxes.id, job.box)).get();
    return machine && !machine.revokedAt ? job : undefined;
  };
  const proof = (viewer: Viewer) => {
    const found = proofs.get(viewer);
    return found?.valid() ? found : undefined;
  };
  return {
    current(viewer: Viewer): boolean { return !!proof(viewer); },
    authenticate(request: Request): Authentication | undefined {
      if (!admitted()) return;
      const auth = resolve(request);
      if (!admitted() || !auth?.valid() || !admitted()) return;
      const authorization = request.headers.get('authorization');
      const bearer = authorization !== null;
      const raw = bearer ? /^Bearer ([^\s]{32,4096})$/i.exec(authorization)?.[1]
        : request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('loom_ui='))?.slice(8);
      if (!raw) return;
      const session = bearer ? undefined : hash(raw);
      const tokenId = bearer ? hash(raw) : db.select({ token: sessions.token }).from(sessions).where(eq(sessions.id, session!)).get()?.token;
      if (!tokenId) return;
      const token = db.select(identity).from(tokens).where(eq(tokens.fingerprint, tokenId)).get();
      if (!token) return;
      const bound = token.job ? bodyJob(token) : undefined;
      if (token.job && !bound) return;
      const valid = () => {
        // Stop before any SQL when the root has closed admission.
        if (!admitted() || !auth.valid() || !admitted()) return false;
        const current = db.select(identity).from(tokens).where(eq(tokens.fingerprint, tokenId)).get();
        if (!current || ['kind', 'member', 'agent', 'job', 'box'].some(key => current[key as keyof Token] !== token[key as keyof Token])) return false;
        if (token.kind === 'runner') {
          const box = token.box && db.select({ revokedAt: boxes.revokedAt }).from(boxes).where(eq(boxes.id, token.box)).get();
          if (!box || box.revokedAt) return false;
        }
        if (token.job && !bodyJob(token, bound)) return false;
        return true;
      };
      if (!valid()) return;
      // Presentation updates metadata, never the fixed issue/proof/expiry times.
      const presented = () => {
        if (!valid()) return;
        const at = new Date(clock.now()).toISOString();
        const last = db.select({ at: tokens.lastUsedAt }).from(tokens).where(eq(tokens.fingerprint, tokenId)).get()?.at;
        const seen = session ? db.select({ at: sessions.seenAt }).from(sessions).where(eq(sessions.id, session)).get()?.at : undefined;
        if ((!last || last < at) || (session && (!seen || seen < at))) write(() => {
          if (!valid()) return;
          if (!last || last < at) db.update(tokens).set({ lastUsedAt: at }).where(eq(tokens.fingerprint, tokenId)).run();
          if (session && (!seen || seen < at)) db.update(sessions).set({ seenAt: at }).where(eq(sessions.id, session)).run();
        });
      };
      presented();
      if (!valid()) return;
      proofs.set(auth.viewer, { token, session, bearer, valid, box: bound?.box ?? undefined });
      return { ...auth, valid, ...(request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? { activity: presented } : {}) };
    },
    browser(viewer: Viewer): Readonly<{ session: string }> | undefined {
      const found = proof(viewer);
      return found?.session && !found.bearer && viewer.kind === 'member'
        ? Object.freeze({ session: found.session }) : undefined;
    },
    runner(viewer: Viewer): Readonly<{ box: string }> | undefined {
      const found = proof(viewer);
      return found?.bearer && viewer.kind === 'runner' && found.token.kind === 'runner' && found.token.box
        ? Object.freeze({ box: found.token.box }) : undefined;
    },
    runnerEnrollment(viewer: Viewer): Readonly<{ box: string; fingerprint: string }> | undefined {
      const found = proof(viewer);
      return found?.bearer && viewer.kind === 'runner' && found.token.kind === 'runner' && found.token.box === viewer.id
        && !found.token.member && !found.token.agent && !found.token.job
        ? Object.freeze({ box: viewer.id, fingerprint: found.token.fingerprint }) : undefined;
    },
    body(viewer: Viewer): Readonly<{ job: string; agent: string; box: string }> | undefined {
      const found = proof(viewer);
      return found?.bearer && viewer.kind === 'agent' && found.token.kind === 'agent' && found.token.job && found.box
        ? Object.freeze({ job: found.token.job, agent: viewer.id, box: found.box }) : undefined;
    },
  };
}
