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
import { tempoCommandAllowed, recordedTrigger } from './shared-tempo-access.js';
import { mayRunPrivateWork, triggerWorksFor } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { Jobs, agentMailAdmission } from './runtime/jobs.js';
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
  mailboxReceiptScope?:TempoOperationOptions['mailboxReceiptScope'];
  chatMember?(viewer: Viewer): string | undefined;
  beforeStart?:Parameters<typeof installTempoComposition>[0]['beforeStart'];
  contributors?: readonly SweepPart[];
}
export function installSharedTempo(db: DataDatabase, clock: Clock, writes: DataWrites, operations: Operations,
  conversations: Conversations, changed: () => void, options: SharedTempoOptions = {}) {
  const admitAgent = agentMailAdmission(new Jobs(db, () => new Date(clock.now()).toISOString()), changed);
  return installTempoComposition({ db, clock, writes, operations,
    contributors: options.contributors,beforeStart:options.beforeStart,
    delivery: { conversations, changed,
      worksFor(trigger) {
        const sharing = sharedSharing(db), member = triggerWorksFor(trigger, sharing);
        if (member !== undefined && !mayRunPrivateWork({ agent: trigger.to!, member, project: trigger.project ?? undefined }, sharing))
          throw new Error('The member this was set for no longer has the agent, or is not in its project');
        return member;
      }, instructions: options.instructions ?? (options.repository ? repositoryInstructions(options.repository) : undefined), changeRevision: options.changeRevision,
      // Mail for a person is a notice to send; mail for an agent is work to admit.
      admit: options.admit ?? ((who, items) => who.kind === 'person'
        ? options.notify?.(who.id, items.map(item => item.id)) ?? false : admitAgent(who, items)),
      operation: options.operation ?? (() => { throw new Error('Unknown Tempo operation'); }),
      // The shipped program runs only the sweep. A composition that adds operations vouches for their names.
      knows: options.operation ? undefined : () => false,
    },
    // Chat is the control surface: a current body may carry out its member's ordinary mailbox preference
    // without becoming that member. When is the volume rule in policy.ts, asked by tempoCommandAllowed;
    // chatMember is this door's proof that the caller is the current body of that member's chat.
    commands: { mailboxReceiptScope:options.mailboxReceiptScope, recorded: (viewer, trigger) => recordedTrigger(db, viewer, trigger), authorize: (viewer, access) => tempoCommandAllowed(db, viewer, access, options.chatMember) },
  });
}
