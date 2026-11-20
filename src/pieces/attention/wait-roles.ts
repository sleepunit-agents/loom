/** Next-mode composition through owning public read roles only. */
import type { Tasks } from '../tasks/role.js';
import type { AttentionWaits } from './waits.js';
export function attentionWaits(approvals: { check: NonNullable<AttentionWaits['approval']> }, tasks: Tasks, owner: () => string | undefined = () => undefined): AttentionWaits {
  return {
    approval: (id, viewer) => approvals.check(id, viewer),
    batch(asks, viewer) {
      const ids = [...new Set(asks.flatMap(ask => ask.waits_on && 'task' in ask.waits_on ? [ask.waits_on.task] : []))];
      const response = ids.length ? tasks.readMany?.(viewer, ids) : undefined;
      const records = new Map<string, { id: string; status: string; comments?: unknown }>();
      if (response?.ok && Array.isArray(response.value)) for (const task of response.value) {
        if (task && typeof task.id === 'string' && typeof task.status === 'string') records.set(task.id, task);
      }
      // This closure is confined to one synchronous operation and its exact viewer.
      // An unavailable/denied batch holds waits; never fall back to per-row calls.
      return attentionWaits(approvals, { call(actor, _verb, input) {
        const task = actor === viewer && typeof input.id === 'string' ? records.get(input.id) : undefined;
        return { ok: true, value: { result: task ? { ok: true, task } : { ok: false } } };
      } }, owner);
    },
    taskAnswered(id, ask, since, viewer) {
      const person = owner()?.trim();
      if (!person || !Number.isFinite(since)) return;
      const response = tasks.call(viewer, 'show', { id });
      if (!response.ok) return;
      const value = response.value as { result?: { ok?: boolean; task?: { comments?: unknown } } };
      if (value?.result?.ok !== true || !Array.isArray(value.result.task?.comments)) return;
      const normalized = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      const question = normalized(ask);
      if (!question) return false;
      return value.result.task.comments.some((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return false;
        const comment = raw as { actor?: unknown; at?: unknown; text?: unknown };
        if (comment.actor !== person || typeof comment.at !== 'string' || typeof comment.text !== 'string') return false;
        const at = Date.parse(comment.at);
        const answer = /^(?:Yes|No|Answer), to: (.*)$/.exec(comment.text.split('\n', 1)[0] ?? '');
        return Number.isFinite(at) && at >= since && !!answer && normalized(answer[1]) === question;
      });
    },
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
