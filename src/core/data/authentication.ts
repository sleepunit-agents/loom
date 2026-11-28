/** The one home for what a credential is and whether it is current.
 *
 * Three things are decided here and nowhere else: which credential a request presents (its bearer token or
 * its browser cookie), whether a token is current, and whether a browser's session is current. Every door,
 * sign-in route and Setup listing asks these functions, so they cannot disagree about who a request is.
 * Only fingerprints are looked up; a database fingerprint is never accepted as the credential itself.
 * This issues no credentials.
 */
import { DAY_MS } from '../day.js';
import { createHash } from 'node:crypto';
import { and, eq, isNull, placeholder } from 'drizzle-orm';
import type { Authentication } from '../live/index.js';
import type { DataDatabase } from './database.js';
import { tokens, sessions, members, agents, boxes, jobs, programTokens, terminalCredentials } from './schema.js';
import { jobClaimed } from './job-states.js';
import type { Viewer } from '../../policy.js';

/** What is stored and looked up for a token, a cookie or a sign-in code: its SHA-256. The secrets are 256
 * random bits, so finding a row by this digest tells a caller nothing through timing. This is the only
 * statement of the rule: a worker that makes a body's token itself and sends loom the fingerprint alone
 * computes it with this function too, from the bytes it will erase. */
export const credentialFingerprint = (secret: string | Uint8Array) => createHash('sha256').update(secret).digest('hex');

/** How long a browser stays signed in, counted from when it signed in. An agent's browser gets hours. */
export const PERSON_SESSION_MS = 30 * DAY_MS, AGENT_SESSION_MS = 6 * 3600_000;
/** How long after a browser proved who it is it may still make a sign-in link or add a passkey. */
export const FRESH_PROOF_MS = 10 * 60_000;
/** A person's own browser that proved who it is a short while ago. A cookie alone is not a new proof. */
export const freshProof = (session: Pick<typeof sessions.$inferSelect, 'isAgent' | 'provedAt'>, now: number) => {
  const proved = Date.parse(session.provedAt);
  return !session.isAgent && Number.isFinite(proved) && proved <= now && proved + FRESH_PROOF_MS > now;
};
/** An automated browser, by its own name for itself. This catches only automation that does not hide; the
 * limit that holds is the one a link's maker sets (startBrowser's `agent`; docs/accepted-tradeoffs.md). */
export {isAgentBrowser} from '../signin/browser-device.js';
/** The moment a session stops being accepted, whatever its token allows. */
export const sessionEnds = (session: Pick<typeof sessions.$inferSelect, 'issuedAt' | 'isAgent'>) =>
  Date.parse(session.issuedAt) + (session.isAgent ? AGENT_SESSION_MS : PERSON_SESSION_MS);
/** A token row that is neither revoked nor expired. Whether its holder is still current is currentToken's. */
export const tokenLive = (token: Pick<typeof tokens.$inferSelect, 'revokedAt' | 'expiresAt'>, now: number) =>
  !token.revokedAt && (token.expiresAt === null || Date.parse(token.expiresAt) > now);

/** The browser cookie alone, whatever else the request carries. */
export function presentedCookie(request: Request): string | undefined {
  const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('loom_ui='))?.slice(8);
  return cookie && /^[a-zA-Z0-9_-]{32,4096}$/.test(cookie) ? cookie : undefined;
}
/** The one credential a request presents. A bearer wins over a cookie, and a malformed bearer is no
 * credential at all: it never falls back to the cookie beside it. */
export function presentedCredential(request: Request): { bearer: string; cookie?: undefined } | { cookie: string; bearer?: undefined } | undefined {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const bearer = /^Bearer ([^\s]{32,4096})$/i.exec(authorization)?.[1];
    return bearer ? { bearer } : undefined;
  }
  const cookie = presentedCookie(request);
  return cookie ? { cookie } : undefined;
}

/** Reuse only the SQL program. Each call binds its own key and reads the current transaction. */
function prepareCredentialReads(db: DataDatabase) {
  const key = placeholder('key');
  const holder = { token: tokens, member: members.id, agent: agents.id };
  const activeMember = and(eq(tokens.kind, 'owner'), eq(members.id, tokens.member), isNull(members.removedAt));
  const activeAgent = and(eq(tokens.kind, 'agent'), eq(agents.id, tokens.agent), isNull(agents.removedAt));
  return {
    token: db.select(holder).from(tokens).leftJoin(members, activeMember).leftJoin(agents, activeAgent)
      .where(eq(tokens.fingerprint, key)).prepare(),
    session: db.select({ session: sessions, ...holder }).from(sessions).innerJoin(tokens, eq(tokens.fingerprint, sessions.token))
      .leftJoin(members, activeMember).leftJoin(agents, activeAgent).where(eq(sessions.id, key)).prepare(),
    machine: db.select({ id: boxes.id }).from(boxes).innerJoin(members, eq(members.id, boxes.owner))
      .where(and(eq(boxes.id, key), isNull(boxes.revokedAt), isNull(members.removedAt))).prepare(),
  };
}
const credentialReads = new WeakMap<DataDatabase, ReturnType<typeof prepareCredentialReads>>();
function credentialReadsFor(db: DataDatabase) {
  let prepared = credentialReads.get(db);
  if (!prepared) { prepared = prepareCredentialReads(db); credentialReads.set(db, prepared); }
  return prepared;
}

/** A machine that has not been revoked and whose owner is in the household now. A removed member is nobody
 * (policy.ts), so their machine's token, and a body running there, stop being current when they are
 * removed, and are current again if they are restored. */
export function machineCurrent(db: DataDatabase, box: string): boolean {
  return !!credentialReadsFor(db).machine.get({ key: box });
}
/** A token that is live and whose holder is current: a member who has not been removed, an agent that has
 * not been removed, or a machine that is current (machineCurrent). A token bound to a job is current only
 * while that job is this agent's current work on a machine that is current. A token enrolled from
 * another (a body's, from its machine's) is current only while that one is: revoking a machine's token
 * ends the bodies it started. */
export function currentToken(db: DataDatabase, id: string, now: number) {
  const found = credentialReadsFor(db).token.get({ key: id });
  return found && currentHolder(db, found, now);
}

function currentHolder(db: DataDatabase, found: { token: typeof tokens.$inferSelect; member: string | null; agent: string | null }, now: number): { token: typeof tokens.$inferSelect; viewer: Exclude<Viewer, { kind: 'service' }>; job?: string } | undefined {
  const { token } = found;
  if (!tokenLive(token, now)) return;
  // One step, never a chain: only a machine's own token enrols another (shared-body-enrollment.ts).
  if (token.madeFrom !== null && !tokenLive(credentialReadsFor(db).token.get({ key: token.madeFrom })?.token ?? { revokedAt: 'gone', expiresAt: null }, now)) return;
  if (token.kind === 'owner' && token.member) {
    if (!found.member) return;
    return { token, viewer: { kind: 'member' as const, id: token.member } };
  }
  if (token.kind === 'agent' && token.agent) {
    if (!found.agent) return;
    if (token.job) {
      const job = db.select({ ...tokenJobColumns, member: jobs.member }).from(jobs).where(eq(jobs.id, token.job)).get();
      if (!job || !jobTokenCurrent(token, job)) return;
      if (!machineCurrent(db, job.box)) return;
      // A body is its agent narrowed to the member its job is for (policy.ts, Viewer.workingFor). It is said
      // here, where the job row is read, so no door can meet a body's token as the whole agent.
      if (job.member) return { token, viewer: { kind: 'agent' as const, id: token.agent, workingFor: job.member }, job: token.job };
    }
    // A terminal credential bound to a machine by that machine's own owner is the agent at their terminal
    // (policy.ts, Viewer.atTerminalOf): only while the machine is that member's, is not revoked, and they are
    // in the household. A binding somebody else made, or one made before the maker was recorded, is not.
    const terminal = token.job || token.box ? undefined : db.select({ member: terminalCredentials.member }).from(terminalCredentials)
      .innerJoin(boxes, and(eq(boxes.id, terminalCredentials.machine), eq(boxes.owner, terminalCredentials.member), isNull(boxes.revokedAt)))
      .innerJoin(members, and(eq(members.id, terminalCredentials.member), isNull(members.removedAt)))
      .where(and(eq(terminalCredentials.fingerprint, token.fingerprint), eq(terminalCredentials.issuedBy, terminalCredentials.member))).get();
    return { token, viewer: { kind: 'agent' as const, id: token.agent, ...(terminal && { atTerminalOf: terminal.member }) }, job: token.job ?? undefined };
  }
  if (token.kind === 'runner' && token.box) {
    if (!machineCurrent(db, token.box)) return;
    return { token, viewer: { kind: 'runner' as const, id: token.box } };
  }
}
/** What of a job decides whether the token bound to it is still good: the columns jobTokenCurrent reads. */
export const tokenJobColumns = { agent: jobs.agent, box: jobs.box, state: jobs.state, source: jobs.startedByKind };
export type TokenJob = { agent: string; box: string | null; state: typeof jobs.$inferSelect.state; source: string };
/** Is the job a body's token is bound to still that token's to work under? Only while the job is this agent's,
 * was not started at a terminal, is on a machine and is claimed (jobClaimed). When its job has ended, a body's token
 * is never good again, whatever its own row says. This is the one statement of it: currentHolder (every sign-in
 * and every door) asks it, and Setup's listing (household-read.ts) asks it to say a token ended with its job. */
export const jobTokenCurrent = (token: { agent: string | null }, job: TokenJob | undefined): job is TokenJob & { box: string } =>
  !!job && job.source !== 'terminal' && job.agent === token.agent && !!job.box && jobClaimed(job.state);
/** A browser session that has not run out, on a token that is current. `ends` is when it stops. */
export function currentSession(db: DataDatabase, id: string, now: number) {
  const found = credentialReadsFor(db).session.get({ key: id });
  if (!found || sessionEnds(found.session) <= now) return;
  const { session } = found;
  const held = currentHolder(db, found, now);
  if (!held) return;
  return { ...held, session, ends: Math.min(sessionEnds(session), held.token.expiresAt ? Date.parse(held.token.expiresAt) : Infinity) };
}

/** The new proof of identity a sign-in door asks for before it hands out a credential: a lasting token, a
 * sign-in link or a passkey. A bearer token is one. A browser cookie is one only while it is a person's own
 * browser that proved who it is a short while ago (freshProof): an aged session and an automated browser
 * are not, however validly they are signed in. This is the one gate for all of those doors.
 *
 * It answers with the fingerprints the request rides on, and with nothing when there is no new proof. It
 * does not say whose the bearer is or whether it is live: that is authentication's, asked beside it. */
export function newProof(db: DataDatabase, presented: ReturnType<typeof presentedCredential>, now: number): { token: string; session?: string } | undefined {
  if (!presented) return;
  if (presented.bearer !== undefined) return { token: credentialFingerprint(presented.bearer) };
  const session = credentialFingerprint(presented.cookie), found = currentSession(db, session, now);
  return found && freshProof(found.session, now) ? { token: found.token.fingerprint, session } : undefined;
}

/** What a door learns about a request beyond who it is: the fingerprints of the token it rides on and,
 * for a browser, of its session. A door that keeps its own proof reads these; it never parses the request. */
export type DataAuthentication = Authentication & { readonly job?: string; readonly credential: Readonly<{ token: string; session?: string }> };
/** A program token is a member's token cut down to the records and operations it was granted. Applying
 * those grants is the outside door's work (sharedCredentials), which says `programs: 'admit'`. Everyone
 * else gets the safe answer: a marked program token is no credential here, never a whole member. */
export function dataAuthentication(db: DataDatabase, now: () => number = Date.now, options: { programs?: 'admit' } = {}) {
  const restricted = (token: string) => options.programs !== 'admit' && !!db.select({ token: programTokens.token }).from(programTokens).where(eq(programTokens.token, token)).get();
  return (request: Request): DataAuthentication | undefined => {
    const presented = presentedCredential(request);
    if (!presented) return;
    const sessionId = presented.cookie === undefined ? undefined : credentialFingerprint(presented.cookie);
    const bearerId = presented.bearer === undefined ? undefined : credentialFingerprint(presented.bearer);
    const current = () => {
      const time = now();
      if (sessionId !== undefined) {
        const found = currentSession(db, sessionId, time);
        return found && { token: found.token.fingerprint, viewer: found.viewer, job: found.job, expiresAt: found.ends };
      }
      const found = currentToken(db, bearerId!, time);
      return found && { token: found.token.fingerprint, viewer: found.viewer, job: found.job, expiresAt: found.token.expiresAt ? Date.parse(found.token.expiresAt) : undefined };
    };
    const admitted = current();
    if (!admitted || restricted(admitted.token)) return;
    const { token, ...identity } = admitted;
    return { ...identity, window: !!sessionId, credential: Object.freeze({ token, session: sessionId }), valid() {
      const live = current();
      return !!live && live.token === token && !restricted(token) && live.viewer.kind === admitted.viewer.kind && live.viewer.id === admitted.viewer.id && live.job === admitted.job
        && (live.viewer.kind === 'agent' ? live.viewer.workingFor : undefined) === (admitted.viewer.kind === 'agent' ? admitted.viewer.workingFor : undefined)
        && (live.viewer.kind === 'agent' ? live.viewer.atTerminalOf : undefined) === (admitted.viewer.kind === 'agent' ? admitted.viewer.atTerminalOf : undefined);
    } };
  };
}
