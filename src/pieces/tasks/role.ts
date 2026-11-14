/** Other pieces depend only on this role; implementations are replaceable. */
import type { Operations, Viewer, Result } from '../../core/index.js';
export interface Tasks {
  readMany?(viewer: Viewer, ids: readonly string[]): Result;
  call(viewer: Viewer, verb: string, input: Record<string, unknown>, operationId?: string): Result;
}
export function tasksRole(operations: Operations): Tasks {
  return { readMany: (viewer, ids) => operations.call('direct', viewer, 'tasks.readMany', { ids }), call: (viewer, verb, input, id) => operations.call('direct', viewer, `tasks.${verb}`, input, id) };
}
