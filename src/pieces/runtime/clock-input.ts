import type { Wake } from '../clock/role.js';
/** Stored lane prompts use the same inbox as one-offs. A lane revision is
 * supersession metadata, not a file or an execution capability. Both composition
 * and owning admission retain the holds for unresolved paths and capabilities. */
export function supportedClockPrompt(wake:Wake):boolean {
  return !wake.member&&!!wake.prompt&&!wake.file&&!wake.continuation&&!wake.slot&&!wake.approval
    &&!wake.prompt.includes('<!-- house: local -->');
}
