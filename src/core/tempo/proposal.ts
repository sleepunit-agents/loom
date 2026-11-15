import type { approvalService, ApprovalRequest, Approval } from '../../apps/approvals.js';
import type { DataDatabase } from '../data/database.js';
import type { Clock } from '../clock.js';
import { TEMPO_SETTINGS_OPERATION, tempoSettingsService } from './settings.js';

type Settings = ReturnType<typeof tempoSettingsService>;
type RequestContext = Pick<ApprovalRequest,
  'agent' | 'askedFrom' | 'actingFor' | 'project' | 'member' | 'conversation' | 'why' | 'minutes'>;

/** Trusted chat-to-Approvals composition. Root supplies authenticated request
 * metadata, the shared Approvals instance and the enclosing write/receipt
 * transaction. Install operation in that instance's static operation map before
 * requesting cards. All services must use the same database connection.
 * After a successful outer Allow commit, root calls tempo.changed(); notification
 * errors never justify replaying a committed Allow. This module performs no auth,
 * transport, runtime reload or direct approval decision.
 */
export function tempoSettingsProposals(db: DataDatabase, clock: Clock) {
  const settings = tempoSettingsService(db, clock);
  const operation: readonly [string, (approval: Approval) => void] =
    [TEMPO_SETTINGS_OPERATION, settings.apply];
  return {
    operation,
    request(approvals: Pick<ReturnType<typeof approvalService>, 'request'>,
      who: Parameters<Settings['prepare']>[0], patch: Parameters<Settings['prepare']>[1], context: RequestContext) {
      const card = settings.prepare(who, patch);
      // Prepared fields come last: request metadata cannot replace the operation,
      // recipient or before/after, even at an untyped in-process call site.
      return approvals.request({ ...context, ...card,
        what: card.changeSummary,
        ask: `Change Tempo timings for ${who.kind} ${who.id}?`,
        ifYes: 'Apply the Tempo timings shown on this card.',
        ifNo: 'Keep the current Tempo timings.',
      });
    },
  };
}
