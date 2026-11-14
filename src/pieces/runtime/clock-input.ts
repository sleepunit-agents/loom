import type { Wake } from '../clock/store.js';
/** Both composition and owning admission use the same supported-input hold. */
export function supportedClockPrompt(wake:Wake):boolean {
  return !wake.member&&!!wake.prompt&&!wake.file&&!wake.laneVersion&&!wake.continuation&&!wake.slot&&!wake.approval
    &&!wake.prompt.includes('<!-- house: local -->');
}
