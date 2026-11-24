import { readPlacementAccounts } from '../core/data/model-account-read.js';
import { reportedAccountCapacity } from './account-windows.js';
import { SILENCE_MS } from './silence.js';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentBoxes, agentModels, boxes, boxAgents, boxFacts, jobs, modelAccountBoxes, modelAccountLogins } from '../core/data/schema.js';
import { claimedJobStates } from '../core/data/job-states.js';
import { machineMayHost, namesCurrent } from '../policy.js';
import { sharedSharing } from '../shared-sharing.js';

/** `tag` is the operator's word for what kind of model this is within its family, such as best, normal or low.
 * Work that wants a tag runs on any allowed model carrying it, whichever family has room. */
export interface ModelRole { model: string; provider: string; harness: string; series: string; tag?: string }
export interface Placement { box: string; model: string; account: string; harness: string }

/** Both reported and owner-labelled capabilities describe the worker. */
export function meetsNeed(facts: readonly string[], need: string): boolean {
  const [key, ...value] = need.split(':');
  return facts.some(fact => {
    const [candidate, ...actual] = fact.split(':');
    return candidate === key && (!value.length || actual.join(':').toLowerCase() === value.join(':').toLowerCase());
  });
}

interface PlacementInput {
  agent: string; now: string; roles: readonly ModelRole[]; needs?: readonly string[]; prefers?: readonly string[];
  /** A model name or a tag carried by an allowed model. */
  eligibleBoxes?: ReadonlySet<string>;
  wants?: string | null;
  /** Machines that advertised the clock-program protocol on their most recent poll. */
  programBoxes?: ReadonlySet<string>;
  cannotRun?: (harness: string) => boolean;
}

export const QUOTA_WAIT_REASON='An eligible worker reported a signed-in account. Its quota window leaves too little room to start this job.';

export const QUOTA_REFRESH_REASON = 'An eligible worker reported a signed-in account. Loom needs a current quota reading before it can start this job.';

const expiredLoginReason = 'A sign-in for an allowed model has expired on this machine.';
const signedOutReason = 'An account for an allowed model is signed out on this machine.';

type Candidate = { box: string; reason: string; signInBlocked?: boolean } | { box: string; placement: Placement; missingPreferred: string[] };
type Decision = { box: string; outcome: 'taken' | 'passed'; reason: string };

/** Keep a claim explanation bounded even if every configured machine lacks a long list of facts. */
function describeFacts(facts: readonly string[]): string {
  return facts.length === 1 ? facts[0] : `${facts[0]} and ${facts.length - 1} more`;
}

/** Decide once from the household as it stands. Agent order breaks ties in both preference groups. */
export function decidePlacement(db: DataDatabase, input: PlacementInput): { placement?: Placement; decision: Decision[]; signInBlocked: boolean; quotaLimited: boolean; quotaWaitReason?: string } {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('Invalid placement time');
  // Whether a machine may be handed this agent's work is policy.ts's (machineMayHost), on the household as it is now.
  const sharing = sharedSharing(db);
  const listed = new Map(db.select().from(boxAgents).where(eq(boxAgents.agent, input.agent)).all().map(row => [row.box, row]));
  const preferences = db.select({ id: agentBoxes.box, box: boxes }).from(agentBoxes)
    .leftJoin(boxes, eq(boxes.id, agentBoxes.box)).where(eq(agentBoxes.agent, input.agent))
    .orderBy(asc(agentBoxes.position), asc(agentBoxes.box)).all();
  const factsByBox = new Map<string, string[]>();
  if (input.needs?.length || input.prefers?.length) {
    const facts = db.select({ box: boxFacts.box, fact: boxFacts.fact }).from(agentBoxes)
      .innerJoin(boxFacts, eq(boxFacts.box, agentBoxes.box)).where(eq(agentBoxes.agent, input.agent)).all();
    for (const { box, fact } of facts) {
      const existing = factsByBox.get(box);
      if (existing) existing.push(fact);
      else factsByBox.set(box, [fact]);
    }
  }
  const occupiedByBox = new Map<string, number>();
  if (preferences.some(({ box }) => box?.slots != null)) {
    const counts = db.select({ box: agentBoxes.box, occupied: count() }).from(agentBoxes)
      .innerJoin(jobs, eq(jobs.box, agentBoxes.box)).where(and(eq(agentBoxes.agent, input.agent),
        ne(jobs.startedByKind, 'terminal'), inArray(jobs.state, claimedJobStates))).groupBy(agentBoxes.box).all();
    for (const row of counts) occupiedByBox.set(row.box, row.occupied);
  }
  const models = input.programBoxes ? [] : db.select().from(agentModels).where(eq(agentModels.agent, input.agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).all()
    .filter(row => !input.wants || row.model === input.wants || input.roles.some(role => role.model === row.model && role.tag === input.wants));
  // A removed member's account pays for nothing, like their machine runs nothing.
  const accounts = input.programBoxes ? [] : readPlacementAccounts(db)
    .filter(account => namesCurrent('member', account.owner, sharing))
    .map(account => ({ ...account, capacity: reportedAccountCapacity(account.hasRoom, account.modelAccountWindowsByAccount, input.now) }));
  const bindings = input.programBoxes ? [] : db.select().from(modelAccountBoxes).all();
  // Host and container logins can differ. Placement uses only reports from the houses.
  const logins = input.programBoxes ? [] : db.select().from(modelAccountLogins).where(eq(modelAccountLogins.place, 'containers')).all();
  const roles = models.flatMap(model => {
    const role = input.roles.find(role => role.model === model.model);
    return role && !input.cannotRun?.(role.harness) ? [role] : [];
  });
  const candidates = preferences.map(({ id, box }): Candidate => {
    const silence = box?.lastSeenAt ? now - Date.parse(box.lastSeenAt) : NaN;
    if (!box || box.revokedAt || !Number.isFinite(silence) || silence < 0 || silence > SILENCE_MS)
      return { box: id, reason: 'Machine is not live.' };
    if (input.eligibleBoxes && !input.eligibleBoxes.has(id)) return {box:id,reason:'Worker has not advertised delegated result delivery.'};
    if (box.reportOnly || !machineMayHost(box, listed.get(id), input.agent, sharing))
      return { box: id, reason: `Machine does not host ${input.agent}.` };
    const facts = factsByBox.get(id) ?? [];
    const missing = (input.needs ?? []).filter(need => !meetsNeed(facts, need));
    if (missing.length) return { box: id, reason: `Missing required facts: ${describeFacts(missing)}.` };
    if (box.slots != null) {
      const occupied = occupiedByBox.get(id) ?? 0;
      if (occupied >= box.slots) return { box: id, reason: `No free worker slot (${occupied}/${box.slots} in use).` };
    }
    if (input.programBoxes && !input.programBoxes.has(id)) return { box: id, reason: 'Worker has not advertised house programs.' };
    if (input.programBoxes) return { box: id, placement: { box: id, model: '', account: '', harness: 'house-program' },
      missingPreferred: (input.prefers ?? []).filter(fact => !meetsNeed(facts, fact)) };
    if (!roles.length) return { box: id, reason: 'No allowed model and harness can run this job.' };
    let signInReason: string | undefined;
    let quotaReason: string | undefined;
    for (const role of roles) {
      const enabled = accounts.filter(account => account.provider === role.provider && bindings.some(binding => binding.account === account.id && binding.box === id));
      for (const account of enabled) {
        const login = logins.find(row => row.account === account.id && row.box === id && row.harness === role.harness);
        // The reported end remains binding between worker checks.
        const expired = login?.expiresAt != null && Date.parse(login.expiresAt) <= now;
        if (!account.capacity.hasRoom) {
          if (account.usageReadSucceeded && login?.state === 'signed-in' && Date.parse(login.checkedAt) <= now && !expired) {
            const windows = account.capacity.windows;
            if (windows.some(window => window.estimatedUsage !== null && !window.hasRoom)) quotaReason = QUOTA_WAIT_REASON;
            else if (windows.some(window => window.estimatedUsage === null)) quotaReason ??= QUOTA_REFRESH_REASON;
          }
          continue;
        }
        if (login?.state === 'signed-out' || expired) {
          signInReason ??= expired ? expiredLoginReason : signedOutReason;
          continue;
        }
        return { box: id, placement: { box: id, model: role.model, account: account.id, harness: role.harness },
          missingPreferred: (input.prefers ?? []).filter(fact => !meetsNeed(facts, fact)) };
      }
    }
    return { box: id, signInBlocked: !!signInReason, reason: quotaReason ?? signInReason ?? 'No signed-in account with room for an allowed model.' };
  });
  const eligible = candidates.filter(candidate => 'placement' in candidate);
  const winner = eligible.find(candidate => !candidate.missingPreferred.length) ?? eligible[0];
  const decision = candidates.map((candidate): Decision => {
    const { box } = candidate;
    if ('reason' in candidate) return { box, outcome: 'passed', reason: candidate.reason };
    let facts = '';
    if (candidate.missingPreferred.length) facts = `Missing preferred facts: ${describeFacts(candidate.missingPreferred)}. `;
    else if (input.prefers?.length) facts = `Matches preferred facts: ${describeFacts(input.prefers)}. `;
    if (candidate === winner) return { box, outcome: 'taken', reason: facts + "First in the agent's order among equally preferred eligible machines." };
    const order = candidate.missingPreferred.length && !winner.missingPreferred.length
      ? 'Another eligible machine meets every preference.' : "Another eligible machine comes first in the agent's order.";
    return { box, outcome: 'passed', reason: facts + order };
  });
  if (winner) return { placement: winner.placement, decision, signInBlocked:false, quotaLimited: false };
  const quotaWaitReason = [QUOTA_WAIT_REASON, QUOTA_REFRESH_REASON].find(reason => decision.some(row => row.reason === reason));
  const signInBlocked = candidates.some(candidate => 'reason' in candidate && candidate.signInBlocked);
  return { decision, signInBlocked, quotaLimited: quotaWaitReason === QUOTA_WAIT_REASON, quotaWaitReason };
}

export function selectPlacement(db: DataDatabase, input: PlacementInput): Placement | undefined {
  return decidePlacement(db, input).placement;
}
