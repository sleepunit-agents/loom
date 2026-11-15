import { currentAccountCapacity } from './account-windows.js';
import { asc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentBoxes, agentModels, boxes, boxAgents, boxFacts, memberAgents, modelAccounts, modelAccountBoxes } from '../core/data/schema.js';

export interface ModelRole { model: string; provider: string; harness: string; series: string }
export interface Placement { box: string; model: string; account: string; harness: string }
export const WORKER_SILENCE_MS = 120_000;

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
  agent: string; now: string; roles: readonly ModelRole[]; model?: string; needs?: readonly string[];
}): Placement | undefined {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('Invalid placement time');
  const owners = new Set(db.select().from(memberAgents).where(eq(memberAgents.agent, input.agent)).all().map(row => row.member));
  const allowed = new Map(db.select().from(boxAgents).where(eq(boxAgents.agent, input.agent)).all().map(row => [row.box,row.lent]));
  const preferences = db.select().from(agentBoxes).where(eq(agentBoxes.agent, input.agent)).orderBy(asc(agentBoxes.position), asc(agentBoxes.box)).all();
  const models = db.select().from(agentModels).where(eq(agentModels.agent, input.agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).all()
    .filter(row => input.model === undefined || row.model === input.model);
  const accounts = db.select().from(modelAccounts).orderBy(asc(modelAccounts.id)).all().filter(account => currentAccountCapacity(db, account.id, input.now).hasRoom);
  const signedIn = db.select().from(modelAccountBoxes).all();
  for (const preference of preferences) {
    const box = db.select().from(boxes).where(eq(boxes.id, preference.box)).get();
    if (!box || box.revokedAt || box.reportOnly || !box.lastSeenAt) continue;
    const silence = now - Date.parse(box.lastSeenAt);
    if (!Number.isFinite(silence) || silence < 0 || silence > WORKER_SILENCE_MS) continue;
    if (!(allowed.has(box.id) && (owners.has(box.owner) || allowed.get(box.id))) && !(box.hostsAny && owners.has(box.owner))) continue;
    const facts = db.select().from(boxFacts).where(eq(boxFacts.box, box.id)).all().map(row => row.fact);
    if (!(input.needs ?? []).every(need => meetsNeed(facts, need))) continue;
    for (const model of models) {
      const role = input.roles.find(role => role.model === model.model);
      if (!role) continue;
      const account = accounts.find(account => account.provider === role.provider
        && signedIn.some(binding => binding.account === account.id && binding.box === box.id));
      if (account) return { box: box.id, model: model.model, account: account.id, harness: role.harness };
    }
  }
}
