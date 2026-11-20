/** Shared-program composition: call after installing Mind and before starting
 * Tempo. The checking agent is an explicit household choice, never a default
 * inferred from a memory path or the current caller. */
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { triggers } from '../core/data/schema.js';
import type { createTempo } from '../core/tempo/tempo.js';
import { INDEPENDENT_KNOWLEDGE_CHECKS, type SweepPart } from '../core/tempo/sweep.js';

export function installMemoryTempo(db: DataDatabase, tempo: ReturnType<typeof createTempo>,
  knowledge: { sweep(checkingAgent: string, alternate?: string): SweepPart }, checkingAgent: string, alternate?: string) {
  if (!checkingAgent.trim()) throw new Error('Knowledge sweep needs an explicit checking agent');
  if (alternate !== undefined && (!alternate.trim() || alternate === checkingAgent)) throw new Error('Choose a different alternate checking agent');
  const idFor = (agent: string) => (agent === alternate ? 'knowledge-second-check:' : 'knowledge-sweep:') + agent;
  const targetFor = (agent: string) => agent === alternate ? 'tempo.knowledgeSweep' : 'tempo.sweep';
  const missing = (alternate ? [checkingAgent, alternate] : [checkingAgent]).filter(agent => {
    const id = idFor(agent);
    const existing = db.select().from(triggers).where(eq(triggers.id, id)).get();
    // Never silently take over an unrelated trigger with the same stable id.
    if (existing && (existing.ownerKind !== 'agent' || existing.owner !== agent ||
      existing.sourceKind !== 'time' || existing.times !== '07:17' || existing.days !== 'daily' ||
      existing.lifespan !== 'until-stopped' || existing.targetKind !== 'operation' ||
      existing.target !== targetFor(agent) || existing.toKind !== 'agent' || existing.to !== agent)) {
      throw new Error('Knowledge sweep trigger conflicts with existing configuration');
    }
    return !existing;
  });
  const part = knowledge.sweep(checkingAgent, alternate);
  const unregister = [tempo.sweep.register({
    name: part.name, open: who => who.kind === 'agent' && who.id === checkingAgent ? part.open(who) : [],
  })];
  const close = () => { for (const release of unregister) release(); };
  try {
    if (alternate) unregister.push(tempo.sweep.register({
      name: INDEPENDENT_KNOWLEDGE_CHECKS, open: who => who.kind === 'agent' && who.id === alternate ? part.open(who) : [],
    }));
    db.transaction(() => {
      for (const agent of missing) {
        tempo.triggers.set({ id: idFor(agent), ownerKind: 'agent', owner: agent,
          sourceKind: 'time', times: '07:17', days: 'daily', lifespan: 'until-stopped',
          targetKind: 'operation', target: targetFor(agent), toKind: 'agent', to: agent,
          note: agent === alternate ? 'Independently check due knowledge pages' : 'Re-check due knowledge pages' });
      }
    });
  } catch (error) { close(); throw error; }
  // Preserve household pauses across restarts. A former alternate's restricted
  // schedule contributes nothing once that identity leaves the configuration.
  return close;
}
