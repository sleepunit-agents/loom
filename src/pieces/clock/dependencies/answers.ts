import type { Db, Live, Operations, Sharing } from '../../../core/index.js';
import { approvalAnswers } from '../../approvals/role.js';
import { secretAnswers } from '../../secrets/role.js';
import type { Approvals } from './approvals.js';

/** Compose owning read roles only. Missing pieces and invisible requests stay unreadable. */
export function clockAnswers(db: Db, operations: Operations, live: Live, sharing: () => Sharing): Approvals {
  const approvals = approvalAnswers(db, sharing, () => operations.clock.now());
  const secrets = secretAnswers(db, sharing);
  return {
    check(id, viewer) {
      if (id.startsWith('a-') && operations.has('approvals.state')) return approvals.check(id, viewer);
      if (id.startsWith('q-') && operations.has('secrets.request')) {
        const answer = secrets.check(id, viewer);
        return answer && { ...answer, state: answer.state === 'revoked' ? 'cancelled' : answer.state };
      }
    },
    subscribe(changed) {
      return live.observe(changes => {
        if (changes.some(change => ['approval', 'secret.request', 'core.access'].includes(change.type))) changed();
      });
    },
  };
}
