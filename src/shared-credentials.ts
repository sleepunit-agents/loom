/** Current credential claims at the outside door. Never derive authority from a
 * caller's Viewer label, job argument, or an installed-module name. */
import {isReservedProgramOperation,programSnapshot,sameProgramGrants,type ProgramGrantReader,type ProgramGrants} from './shared-program-access.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { credentialFingerprint, dataAuthentication, presentedCredential } from './core/data/authentication.js';
import { tokens, sessions, jobs, terminalCredentials, boxes, members } from './core/data/schema.js';
import { jobClaimed } from './core/data/job-states.js';
import type { Authentication } from './core/live/index.js';

export function sharedCredentials(db: DataDatabase, clock: Clock, admitted: () => boolean, write: (action: () => boolean) => void, programs: ProgramGrantReader = () => undefined) {
  const resolve = dataAuthentication(db, () => clock.now(), { programs: 'admit' });
  const identity = { fingerprint: tokens.fingerprint, kind: tokens.kind, member: tokens.member, agent: tokens.agent, job: tokens.job, box: tokens.box };
  type Token = Pick<typeof tokens.$inferSelect, keyof typeof identity>;
  type Proof = { token: Token; session?: string; bearer: boolean; grants?:Readonly<ProgramGrants>; valid(): boolean; box?: string };
  const proofs = new WeakMap<Viewer, Proof>();
  type BoundJob = Pick<typeof jobs.$inferSelect, 'agent' | 'box' | 'conversation' | 'member' | 'project'>;
  // dataAuthentication has already refused a job that is not this agent's current work on a machine that is
  // not revoked. What is added here is that the work stays the same work: a job moved to another machine,
  // conversation, member or project is no longer what this credential was admitted for.
  const bodyJob = (token: Token, bound?: BoundJob) => {
    if (token.kind !== 'agent' || !token.job || !token.agent) return;
    const job = db.select({ id: jobs.id, agent: jobs.agent, box: jobs.box, conversation: jobs.conversation, member: jobs.member, project: jobs.project, state: jobs.state }).from(jobs).where(eq(jobs.id, token.job)).get();
    if (!job || job.agent !== token.agent || !jobClaimed(job.state) || !job.box) return;
    if (bound && (['agent', 'box', 'conversation', 'member', 'project'] as const).some(key => job[key] !== bound[key])) return;
    return job;
  };
  const proof = (viewer: Viewer) => {
    const found = proofs.get(viewer);
    return found?.valid() ? found : undefined;
  };
  return {
    /** Pure routing hint only; authority still requires authenticate(). */
    isProgramRequest(request:Request):boolean {
      if(!admitted())return false;
      const raw=presentedCredential(request)?.bearer;
      return !!raw&&!!programSnapshot(programs,credentialFingerprint(raw));
    },
    current(viewer: Viewer): boolean { return !!proof(viewer); },
    authenticate(request: Request, options: { recordUse?: boolean; programs?: 'deny' } = {}): Authentication | undefined {
      if (!admitted()) return;
      const auth = resolve(request);
      if (!admitted() || !auth?.valid() || !admitted()) return;
      // Which token and session this is comes from the same resolution that named the viewer, so the
      // proof kept here can never be about a different credential than the one that was admitted.
      const { token: tokenId, session } = auth.credential, bearer = session === undefined;
      const token = db.select(identity).from(tokens).where(eq(tokens.fingerprint, tokenId)).get();
      if (!token) return;
      const grants=programSnapshot(programs,tokenId);
      // Program tokens stay outside callers; they cannot mint browser/body authority.
      if(grants&&(options.programs==='deny'||session||token.kind!=='owner'||!token.member))return;
      const bound = token.job ? bodyJob(token) : undefined;
      if (token.job && !bound) return;
      const valid = () => {
        // Stop before any SQL when the root has closed admission.
        if (!admitted() || !auth.valid() || !admitted()) return false;
        if(!sameProgramGrants(grants,programSnapshot(programs,tokenId)))return false;
        const current = db.select(identity).from(tokens).where(eq(tokens.fingerprint, tokenId)).get();
        if (!current || ['kind', 'member', 'agent', 'job', 'box'].some(key => current[key as keyof Token] !== token[key as keyof Token])) return false;
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
          if (!valid()) return false;
          if (!last || last < at) db.update(tokens).set({ lastUsedAt: at }).where(eq(tokens.fingerprint, tokenId)).run();
          if (session && (!seen || seen < at)) db.update(sessions).set({ seenAt: at }).where(eq(sessions.id, session)).run();
          return true;
        });
      };
      if(options.recordUse!==false)presented();
      if (!valid()) return;
      proofs.set(auth.viewer, { token, session, bearer, valid, grants, box: bound?.box ?? undefined });
      const { credential: _credential, ...resolved } = auth;
      return { ...resolved, valid, ...(request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? { activity: presented } : {}) };
    },
    program(viewer:Viewer):Readonly<ProgramGrants>|undefined{return proofs.get(viewer)?.grants;},
    allows(viewer:Viewer,operation:string):boolean{const found=proof(viewer);return !!found&&(!found.grants||(!isReservedProgramOperation(operation)&&found.grants.operations.includes(operation)));},
    receiptScope(viewer:Viewer):string|undefined{const found=proofs.get(viewer);return found?.grants?found.token.fingerprint:undefined;},
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
    /** A terminal credential names its own agent without claiming a worker job. */
    agentSession(viewer: Viewer): Readonly<{agent:string}> | undefined {
      const found=proof(viewer);
      return found?.bearer && viewer.kind==='agent' && found.token.kind==='agent' && !found.token.job && !found.token.box
        ? Object.freeze({agent:viewer.id}) : undefined;
    },
    terminalMachine(viewer: Viewer) {
      const found = proof(viewer);
      if (!found?.bearer || viewer.kind !== 'agent' || found.token.kind !== 'agent' || found.token.job || found.token.box) return;
      const binding = db.select({machine: boxes.id, member: terminalCredentials.member}).from(terminalCredentials)
        .innerJoin(boxes, and(eq(boxes.id, terminalCredentials.machine), eq(boxes.owner, terminalCredentials.member)))
        .innerJoin(members, and(eq(members.id, terminalCredentials.member), isNull(members.removedAt)))
        .where(and(eq(terminalCredentials.fingerprint, found.token.fingerprint), isNull(boxes.revokedAt))).get();
      return binding && {agent: viewer.id, ...binding};
    },
    body(viewer: Viewer): Readonly<{ job: string; agent: string; box: string }> | undefined {
      const found = proof(viewer);
      return found?.bearer && viewer.kind === 'agent' && found.token.kind === 'agent' && found.token.job && found.box
        ? Object.freeze({ job: found.token.job, agent: viewer.id, box: found.box }) : undefined;
    },
  };
}
