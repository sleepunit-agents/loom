/** Other pieces depend only on this role; implementations are replaceable. */
import type { Operations, Viewer, Result } from '../../core/index.js';
export interface Tasks {
  call(viewer: Viewer, verb: string, input: Record<string, unknown>, operationId?: string): Result;
}
export function tasksRole(operations: Operations): Tasks {
  return { call: (viewer, verb, input, id) => operations.call('direct', viewer, `tasks.${verb}`, input, id) };
}
