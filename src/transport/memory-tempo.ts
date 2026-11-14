/** Shared-program composition: call after installing Mind and before starting
 * Tempo. The checking agent is an explicit household choice, never a default
 * inferred from a memory path or the current caller. */
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { triggers } from '../core/data/schema.js';
import type { createTempo } from '../core/tempo/tempo.js';
import type { SweepPart } from '../core/tempo/sweep.js';

export function installMemoryTempo(db: DataDatabase, tempo: ReturnType<typeof createTempo>,
  knowledge: { sweep(checkingAgent: string): SweepPart }, checkingAgent: string) {
  if (!checkingAgent.trim()) throw new Error('Knowledge sweep needs an explicit checking agent');
  const id = `knowledge-sweep:${checkingAgent}`;
  const existing = db.select().from(triggers).where(eq(triggers.id, id)).get();
  // Never silently take over an unrelated trigger with the same stable id.
  if (existing && (existing.ownerKind !== 'agent' || existing.owner !== checkingAgent ||
    existing.sourceKind !== 'time' || existing.times !== '07:17' || existing.days !== 'daily' ||
    existing.lifespan !== 'until-stopped' || existing.targetKind !== 'operation' ||
    existing.target !== 'tempo.sweep' || existing.toKind !== 'agent' || existing.to !== checkingAgent)) {
    throw new Error('Knowledge sweep trigger conflicts with existing configuration');
  }
  const unregister = tempo.sweep.register(knowledge.sweep(checkingAgent));
  try {
    if (!existing) tempo.triggers.set({ id, ownerKind: 'agent', owner: checkingAgent,
      sourceKind: 'time', times: '07:17', days: 'daily', lifespan: 'until-stopped',
      targetKind: 'operation', target: 'tempo.sweep', toKind: 'agent', to: checkingAgent,
      note: 'Re-check due knowledge pages' });
  } catch (error) { unregister(); throw error; }
  // Teardown removes only the in-process contributor. Persisted schedule state,
  // including a household stop/pause, survives restart unchanged.
  return unregister;
}
