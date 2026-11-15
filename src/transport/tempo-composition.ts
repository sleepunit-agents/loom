/** Tempo's shared-program lifecycle. Every writer uses the root's one committed
 * write boundary; no polling legacy stores and no direct trigger-to-body path. */
import type { DataDatabase } from '../core/data/database.js';
import type { DataWrites } from '../core/data/writes.js';
import type { Clock } from '../core/clock.js';
import type { Operations } from '../core/operations/index.js';
import { createTempo, type TempoOptions } from '../core/tempo/tempo.js';
import { registerTempoOperations, type TempoOperationOptions } from '../core/tempo/operations.js';
import { workSweepParts } from '../core/tempo/work-sweep.js';
import type { SweepPart } from '../core/tempo/sweep.js';

export function installTempoComposition(options: {
  db: DataDatabase; clock: Clock; writes: DataWrites; operations: Operations;
  delivery: TempoOptions;
  commands: TempoOperationOptions;
  contributors?: readonly SweepPart[];
}) {
  const { db, clock } = options;
  const tempo = createTempo(db, clock, options.delivery);
  const unregister: (() => void)[] = [];
  let closed = false;
  let stop: (() => void) | undefined;
  try {
    for (const part of [...workSweepParts(db, clock), ...options.contributors ?? []]) unregister.push(tempo.sweep.register(part));
    registerTempoOperations(options.operations, db, tempo, options.commands);
    stop = options.writes.observe(() => tempo.committed());
    tempo.start();
  } catch (error) {
    stop?.(); tempo.close(); unregister.reverse().forEach(remove => remove()); throw error;
  }
  return {
    ...tempo,
    /** Capacity is not a database write; Runtime calls this after freeing it. */
    capacityChanged() { if (!closed) tempo.changed(); },
    close() {
      if (closed) return; closed = true;
      stop?.(); tempo.close(); unregister.reverse().forEach(remove => remove());
    },
  };
}
