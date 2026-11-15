/** Tempo's installation in the fresh shared program. Callers may supply runtime,
 * notification and provenance adapters; none is derived from operation input. */
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import type { DataWrites } from './core/data/writes.js';
import type { Operations } from './core/operations/index.js';
import type { Conversations } from './core/conversations/index.js';
import type { TempoOptions } from './core/tempo/tempo.js';
import type { TempoOperationOptions } from './core/tempo/operations.js';
import type { Viewer } from './policy.js';
import type { Recipient } from './core/tempo/volume.js';
import type { SweepPart } from './core/tempo/sweep.js';
import { installTempoComposition } from './transport/tempo-composition.js';
import { tempoCommandAllowed } from './shared-tempo-access.js';
import { Jobs } from './runtime/jobs.js';
import { repositoryInstructions } from './core/tempo/repository.js';

export interface SharedTempoOptions {
  /** Trusted checkout path, never supplied by a command caller. */
  repository?: string;
  /** Accept one settled person batch. IDs only; delivery reads current policy. */
  notify?(member: string, items: readonly string[]): boolean;
  admit?: TempoOptions['admit'];
  operation?: TempoOptions['operation'];
  instructions?: TempoOptions['instructions'];
  changeRevision?: TempoOptions['changeRevision'];
  settings?: TempoOperationOptions['settings'];
  chatMember?(viewer: Viewer): string | undefined;
  settingsAuthorized?(viewer: Viewer, who: Recipient): boolean;
  beforeStart?:Parameters<typeof installTempoComposition>[0]['beforeStart'];
  contributors?: readonly SweepPart[];
}
export function installSharedTempo(db: DataDatabase, clock: Clock, writes: DataWrites, operations: Operations,
  conversations: Conversations, changed: () => void, options: SharedTempoOptions = {}) {
  const jobs = new Jobs(db, () => new Date(clock.now()).toISOString());
  return installTempoComposition({ db, clock, writes, operations,
    contributors: options.contributors,beforeStart:options.beforeStart,
    delivery: { conversations, changed, instructions: options.instructions ?? (options.repository ? repositoryInstructions(options.repository) : undefined), changeRevision: options.changeRevision,
      admit: options.admit ?? ((who, items) => {
        if (who.kind === 'person') return options.notify?.(who.id, items.map(item => item.id)) ?? false;
        const ids = [...new Set(items.flatMap(item => item.conversation ? [item.conversation] : []))];
        let admitted = 0;
        for (const id of ids) if (jobs.admit(id)) admitted++;
        if (admitted) changed();
        return admitted > 0 && admitted === ids.length;
      }),
      operation: options.operation ?? (() => { throw new Error('Unknown Tempo operation'); }),
    },
    commands: { authorize: (viewer, access) => {
      // Chat is the control surface. A current body may carry out its recorded
      // member's ordinary mailbox preference, without becoming that member.
      const person = (access.action === 'volume' || access.action === 'settings') ? options.chatMember?.(viewer) : undefined;
      const delegated = !!person && (access.action === 'volume' ? access.item.toKind === 'person' && access.item.to === person
        : access.action === 'settings' && access.who.kind === 'person' && access.who.id === person);
      return (tempoCommandAllowed(db, viewer, access) || delegated) &&
        (access.action !== 'settings' || !options.settingsAuthorized || options.settingsAuthorized(viewer, access.who));
    },
      settings: options.settings ?? (() => { throw new Error('Settings proposal needs authenticated chat context'); }),
    },
  });
}
