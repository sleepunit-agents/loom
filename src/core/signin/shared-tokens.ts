/** Every token row is made and revoked here. Only fingerprints persist.
 * Trusted modules call this service; the HTTP identity door checks ownership.
 * Issuance is deliberately not retryable: a lost response requires a new label.
 */
import { SHA256_HEX } from '../sha256-hex.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { credentialFingerprint, currentToken, tokenLive } from '../data/authentication.js';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { jobClaimed } from '../data/job-states.js';
import type { Viewer } from '../../policy.js';
import { householdOwner } from '../../shared-sharing.js';
import type { Clock } from '../clock.js';
import { agents, boxes, jobs, members, terminalCredentials, tokens } from '../data/schema.js';
import { OperationError, type Operations } from '../operations/index.js';
const id = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
const common = { label, expiresAt: z.iso.datetime().optional() };
const forMember = z.object({ ...common, kind: z.literal('owner'), member: id }).strict();
const forRunner = z.object({ ...common, kind: z.literal('runner'), box: id }).strict();
export const sharedTokenInput = z.discriminatedUnion('kind', [
  forMember, z.object({ ...common, kind: z.literal('agent'), agent: id, terminalMachine: id.optional(), job: id.optional() }).strict(), forRunner,
]);
/** What a household owner may ask for at the sign-in door: a member's, an agent's terminal or a machine's
 * token. Not one bound to a job. A token bound to a job is that job's body, and a job has one body: its
 * worker enrols it (enrolBody), where loom never holds the bearer. A bearer for a running job handed to an
 * owner would be a second body, in a thread that may be another member's private one. */
export const ownerTokenInput = z.discriminatedUnion('kind', [
  forMember, z.object({ ...common, kind: z.literal('agent'), agent: id, terminalMachine: id.optional() }).strict(), forRunner,
]);
/** Tokens are made and revoked by a current household owner: the one owner check, under this door's name. */
export const sharedTokenOwner = (db: DataDatabase, viewer: Viewer) => householdOwner(db, viewer);
/** A current token that stands for a member: the kind a browser session or a passkey may ride on. */
export function currentMemberToken(db: DataDatabase, clock: Clock, id: string) {
  const found=currentToken(db,id,clock.now());
  return found?.viewer.kind==='member'?found.token:undefined;
}
export function activeMemberToken(db:DataDatabase,clock:Clock,id:string){
 const token=currentMemberToken(db,clock,id);if(!token)throw Error('Sign-in refused');return token;
}
export function sharedTokens(db: DataDatabase, clock: Pick<Clock, 'now'>) {
  /** The checks every new row passes, whoever made its secret, and the one insert. */
  const add = (value: z.infer<typeof sharedTokenInput>, fingerprint: string, madeFrom?: string, by?: string) => {
    const now = clock.now();
    if (value.expiresAt && Date.parse(value.expiresAt) <= now) throw new OperationError('invalid', 'Expiry must be in the future');
    if (db.select().from(tokens).where(eq(tokens.label, value.label)).all().some(row => tokenLive(row, now))) throw new OperationError('conflict', 'A live token already has that label');
    if (value.kind === 'owner' && !db.select().from(members).where(eq(members.id, value.member)).get()) throw new OperationError('invalid', 'Choose an existing member');
    if (value.kind === 'agent') {
      if (!db.select().from(agents).where(eq(agents.id, value.agent)).get()) throw new OperationError('invalid', 'Choose an existing agent');
      if (value.job) {
        const job = db.select().from(jobs).where(eq(jobs.id, value.job)).get();
        if (!job || job.startedByKind === 'terminal' || job.agent !== value.agent || !job.box || !jobClaimed(job.state)) throw new OperationError('invalid', 'Choose current work for this agent');
      }
    }
    if (value.kind === 'runner' && !db.select().from(boxes).where(and(eq(boxes.id, value.box), isNull(boxes.revokedAt))).get()) throw new OperationError('invalid', 'Choose an active machine');
    // A job has one live body token: a new one ends any other. (The worker's door refuses a second while one
    // is live, shared-body-enrollment.ts; this holds the same for every other caller.)
    if (value.kind === 'agent' && value.job) db.update(tokens).set({ revokedAt: new Date(now).toISOString() })
      .where(and(eq(tokens.kind, 'agent'), eq(tokens.job, value.job), ne(tokens.fingerprint, fingerprint), isNull(tokens.revokedAt))).run();
    if (value.kind === 'agent' && value.terminalMachine && value.job) throw new OperationError('invalid', 'Choose either a machine terminal or a job');
    db.insert(tokens).values({ ...value, fingerprint, ...(madeFrom === undefined ? {} : { madeFrom }), createdAt: new Date(now).toISOString() }).run();
    if (value.kind === 'agent' && value.terminalMachine) {
      const machine = db.select({owner:boxes.owner}).from(boxes)
        .where(and(eq(boxes.id, value.terminalMachine), isNull(boxes.revokedAt))).get();
      if (!machine?.owner) throw new OperationError('invalid', 'Choose an active machine with a signed-in owner');
      // Who made it is kept. A binding its own member made is the agent at their terminal: it reads that
      // member's private talk with the agent and can answer for them there (policy.ts, Viewer.atTerminalOf).
      // One made for them by another household owner reports that machine's sessions, as before, and no more.
      db.insert(terminalCredentials).values({fingerprint, machine:value.terminalMachine, member:machine.owner, issuedBy:by ?? null}).run();
    }
  };
  return {
    /** Makes the bearer here and hands it back. For trusted callers; the sign-in door narrows what an owner
     * may ask for to ownerTokenInput. */
    issue(input: z.input<typeof sharedTokenInput>, by?: string) {
      const value = sharedTokenInput.parse(input);
      return db.transaction(() => {
        const token = `loom_${randomBytes(32).toString('base64url')}`, fingerprint = credentialFingerprint(token);
        add(value, fingerprint, undefined, by);
        return { token, fingerprint };
      });
    },
    /** The worker keeps its bearer. Called inside the owner decision's machine-creation transaction. */
    enrolRunner(box:string, fingerprint:string) {
      if (!db.$client.inTransaction) throw Error('Runner enrollment requires a transaction');
      if (!SHA256_HEX.test(fingerprint)) throw new OperationError('invalid', 'Invalid fingerprint');
      add({kind:'runner',box,label:'Worker '+box},fingerprint);
    },
    /** A job body's token. Its worker made the secret and sends the fingerprint alone, so there is no
     * bearer to hand back and loom never holds one. A job has one live body token: enrolling ends any
     * other (add). `madeFrom` is the machine token that enrolled it; the body's token is current only while
     * that one is (currentToken). The caller has already proved who is enrolling. */
    enrolBody(input: { fingerprint: string; agent: string; job: string; madeFrom: string }) {
      if (!SHA256_HEX.test(input.fingerprint)) throw new OperationError('invalid', 'Invalid fingerprint');
      return db.transaction(() => {
        // Labels are unique while live; each job's token gets its own. The job column is what binds it.
        add(sharedTokenInput.parse({ kind: 'agent', agent: input.agent, job: input.job, label: `Job body [${randomUUID()}]` }), input.fingerprint, input.madeFrom);
        return { fingerprint: input.fingerprint };
      });
    },
    revoke(fingerprint: string) {
      const row = db.select().from(tokens).where(eq(tokens.fingerprint, fingerprint)).get();
      if (!row) throw new OperationError('not-found', 'Token not found');
      if (!row.revokedAt) db.update(tokens).set({ revokedAt: new Date(clock.now()).toISOString() }).where(eq(tokens.fingerprint, fingerprint)).run();
      return { revoked: true as const };
    },
  };
}
export function registerSharedTokenAdmin(operations: Operations, db: DataDatabase, service: ReturnType<typeof sharedTokens>) {
  operations.register({ name: 'token.revoke', write: true, recheckPolicy: true,
    input: z.object({ fingerprint: z.string().regex(SHA256_HEX) }).strict(), output: z.object({ revoked: z.literal(true) }).strict(),
    may: viewer => sharedTokenOwner(db, viewer),
    run(ctx, input) { const result = service.revoke(input.fingerprint); ctx.changed('core.access', 'household'); return result; },
  });
}
