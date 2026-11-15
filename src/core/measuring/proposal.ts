import type { Approval, ApprovalRequest, approvalService } from '../../apps/approvals.js';
import type { DataDatabase } from '../data/database.js';
import type { MeasuringSettings } from './index.js';
import { MEASURING_SETTINGS_OPERATION, measuringSettingsService } from './settings.js';

type RequestContext = Pick<ApprovalRequest,
  'agent' | 'askedFrom' | 'actingFor' | 'project' | 'member' | 'conversation' | 'why' | 'minutes'>;

/** Trusted composition seam. Root supplies authenticated owner intent/context,
 * the existing shared Approvals service and its outer write/receipt transaction.
 * Register operation in that service's map before requesting any cards; all
 * writes use the same database connection. After the OUTER Allow commit, root
 * reloads Measuring even when notifications failed, without replaying Allow.
 * This adapter performs no authentication, transport or runtime side effects.
 */
export function measuringSettingsProposals(db: DataDatabase) {
  const settings = measuringSettingsService(db);
  const operation: readonly [string, (approval: Approval) => void] =
    [MEASURING_SETTINGS_OPERATION, settings.apply];
  return {
    operation,
    request(approvals: Pick<ReturnType<typeof approvalService>, 'request'>,
      after: MeasuringSettings, context: RequestContext) {
      const card = settings.prepare(after);
      // Prepared fields and wording win over unexpected untyped metadata too.
      return approvals.request({ ...context, ...card,
        what: card.changeSummary,
        ask: 'Change Measuring settings?',
        ifYes: 'Apply the Measuring settings shown on this card.',
        ifNo: 'Keep the current Measuring settings.',
      });
    },
  };
}
