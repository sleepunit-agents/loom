import type { Wake } from '../clock/role.js';
/** Stored lane prompts use the same inbox as one-offs. A lane revision is
 * supersession metadata, not a file or an execution capability. Both composition
 * and owning admission retain the holds for unresolved paths and capabilities. */
export function supportedClockPrompt(wake:Wake):boolean {
  return !!wake.prompt&&!wake.file&&!wake.continuation&&!wake.slot&&!wake.approval
    &&!wake.prompt.includes('<!-- house: local -->');
}

/** Native file consumer only. This validates data, never reads a worker path.
 * Files cannot join an existing conversation until native joining is owned. */
export function supportedClockFile(wake:Wake):boolean {
  return !wake.prompt&&!!wake.file&&wake.file.length<=200
    &&/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(wake.file)
    &&wake.file.split('/').every(p=>p!=='.'&&p!=='..')
    &&!wake.continuation&&!wake.slot&&!wake.approval;
}
export const supportedClockInput=(wake:Wake)=>supportedClockPrompt(wake)||supportedClockFile(wake);
