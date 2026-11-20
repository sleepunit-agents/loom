/** Other pieces use the registry role, never open another piece's content store. */
import type { Operations, Viewer, Result } from '../../core/index.js';
export interface Mind {
  call(viewer: Viewer, verb: string, input: Record<string, unknown>, operationId?: string): Result;
}
export function mindRole(operations: Operations): Mind {
  return { call: (viewer, verb, input, id) => operations.call('direct', viewer, `mind.${verb}`, input, id) };
}
