/** Tempo's installation in the fresh shared program. Callers may supply runtime,
 * notification and provenance adapters; none is derived from operation input. */
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import type { DataWrites } from './core/data/writes.js';
import type { Operations } from './core/operations/index.js';
import type { Conversations } from './core/conversations/index.js';
import type { TempoOptions } from './core/tempo/tempo.js';
import type { TempoOperationOptions } from './core/tempo/operations.js';
import type { SweepPart } from './core/tempo/sweep.js';
import { installTempoComposition } from './transport/tempo-composition.js';
import { tempoCommandAllowed } from './shared-tempo-access.js';
import { Jobs } from './runtime/jobs.js';

export interface SharedTempoOptions {
  admit?: TempoOptions['admit'];
  operation?: TempoOptions['operation'];
  instructions?: TempoOptions['instructions'];
  changeRevision?: TempoOptions['changeRevision'];
  settings?: TempoOperationOptions['settings'];
  contributors?: readonly SweepPart[];
}
export function installSharedTempo(db: DataDatabase, clock: Clock, writes: DataWrites, operations: Operations,
  conversations: Conversations, changed: () => void, options: SharedTempoOptions = {}) {
  const jobs = new Jobs(db, () => new Date(clock.now()).toISOString());
  return installTempoComposition({ db, clock, writes, operations,
    contributors: options.contributors,
    delivery: { conversations, changed, instructions: options.instructions, changeRevision: options.changeRevision,
      admit: options.admit ?? ((who, items) => {
        if (who.kind === 'person') { changed(); return true; }
        const ids = [...new Set(items.flatMap(item => item.conversation ? [item.conversation] : []))];
        let admitted = 0;
        for (const id of ids) if (jobs.admit(id)) admitted++;
        if (admitted) changed();
        return admitted > 0 && admitted === ids.length;
      }),
      operation: options.operation ?? (() => { throw new Error('Unknown Tempo operation'); }),
    },
    commands: { authorize: (viewer, access) => tempoCommandAllowed(db, viewer, access),
      settings: options.settings ?? (() => { throw new Error('Settings proposal needs authenticated chat context'); }),
    },
  });
}
