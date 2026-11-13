/** Private metadata through the installed Comms role, never Comms tables or words. */
import type { Operations } from '../../core/index.js';
import { commsMetadata } from '../comms/role.js';
import type { DigestReferences } from './project-references.js';
export function attentionThreadProject(operations: Operations): NonNullable<DigestReferences['threadProject']> {
  return (viewer, conversation) => ({ok: true, value: commsMetadata(operations)?.threadProject(viewer, conversation) ?? null});
}
