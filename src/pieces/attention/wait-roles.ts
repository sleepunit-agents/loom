/** Next-mode composition through owning public read roles only. */
import type { Tasks } from '../tasks/role.js';
import type { AttentionWaits } from './waits.js';
export function attentionWaits(approvals: { check: NonNullable<AttentionWaits['approval']> }, tasks: Tasks): AttentionWaits {
  return {
    approval: (id, viewer) => approvals.check(id, viewer),
    task(id, viewer) {
      const response = tasks.call(viewer, 'show', { id });
      if (!response.ok) return;
      const value = response.value as { result?: { ok?: boolean; task?: { status?: unknown } } };
      const result = value?.result;
      if (result?.ok !== true || typeof result.task?.status !== 'string') return;
      return { status: result.task.status };
    },
  };
}
