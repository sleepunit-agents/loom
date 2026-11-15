/** Type retained only by the retiring Attention project adapter. */
import type { Viewer, Result } from '../../core/index.js';
export interface Mind {
  call(viewer: Viewer, verb: string, input: Record<string, unknown>, operationId?: string): Result;
}
