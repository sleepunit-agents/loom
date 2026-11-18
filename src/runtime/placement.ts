import { currentAccountCapacity } from './account-windows.js';
import { SILENCE_MS } from './silence.js';
import { asc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentBoxes, agentModels, boxes, boxAgents, boxFacts, modelAccounts, modelAccountBoxes } from '../core/data/schema.js';
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

/** Trusted control-plane selection. Never runs a build or assumes loom is a worker.
 * Roles come from configuration; model names do not imply provider or harness.
 * No viable combination means leave the work queued, rather than run elsewhere.
 */
export function selectPlacement(db: DataDatabase, input: {
  agent: string; now: string; roles: readonly ModelRole[]; needs?: readonly string[];
  /** What the work asked to run on: a tag or one model's name. Only the agent's allowed models that match are tried. */
  wants?: string | null;
  /** Whether a harness would refuse this job (see harnessCannotRun). A model whose harness would is passed
   * over for the agent's next allowed model, so the job is not sent where it can only fail. */
  cannotRun?: (harness: string) => boolean;
}): Placement | undefined {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('Invalid placement time');
  // Whether a machine may be handed this agent's work is policy.ts's (machineMayHost), on the household as it is now.
  const sharing = sharedSharing(db);
  const listed = new Map(db.select().from(boxAgents).where(eq(boxAgents.agent, input.agent)).all().map(row => [row.box, row]));
  const preferences = db.select().from(agentBoxes).where(eq(agentBoxes.agent, input.agent)).orderBy(asc(agentBoxes.position), asc(agentBoxes.box)).all();
  const models = db.select().from(agentModels).where(eq(agentModels.agent, input.agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).all()
    .filter(row => !input.wants || row.model === input.wants || input.roles.some(role => role.model === row.model && role.tag === input.wants));
  // A removed member's account pays for nothing, like their machine runs nothing.
  const accounts = db.select().from(modelAccounts).orderBy(asc(modelAccounts.id)).all()
    .filter(account => namesCurrent('member', account.owner, sharing) && currentAccountCapacity(db, account.id, input.now).hasRoom);
  const signedIn = db.select().from(modelAccountBoxes).all();
  for (const preference of preferences) {
    const box = db.select().from(boxes).where(eq(boxes.id, preference.box)).get();
    if (!box || box.revokedAt || box.reportOnly || !box.lastSeenAt) continue;
    const silence = now - Date.parse(box.lastSeenAt);
    if (!Number.isFinite(silence) || silence < 0 || silence > SILENCE_MS) continue;
    if (!machineMayHost(box, listed.get(box.id), input.agent, sharing)) continue;
    const facts = db.select().from(boxFacts).where(eq(boxFacts.box, box.id)).all()
      .filter(row => !row.fromOwner || !row.fact.startsWith('loom:'))
      .map(row => row.fact);
    if (!(input.needs ?? []).every(need => meetsNeed(facts, need))) continue;
    for (const model of models) {
      const role = input.roles.find(role => role.model === model.model);
      if (!role || input.cannotRun?.(role.harness)) continue;
      const account = accounts.find(account => account.provider === role.provider
        && signedIn.some(binding => binding.account === account.id && binding.box === box.id));
      if (account) return { box: box.id, model: model.model, account: account.id, harness: role.harness };
    }
  }
}
