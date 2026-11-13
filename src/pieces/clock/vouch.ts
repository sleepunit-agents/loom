import type { Wake } from './store.js';
/** Import metadata can restrict adoption; it can never confer authority. Only a
 * fresh owner decision supplies a Viewer. Capabilities need their owning recovery.
 */
export function vouchable(w: Wake): boolean {
  const old = w.legacy;
  return w.by.kind === 'runner' && w.by.id === 'clock-import:unverified'
    && w.state === 'held' && w.hold === 'provenance' && !w.attempt
    && !w.schedule && !w.wait && !w.deadman && !w.bypassPause && !w.runNow
    && !w.continuation && !w.approval && !w.slot && !w.place
    && !!old && old.kind === 'wake' && old.for === '-'
    && !old._firing && !old.schedule && !old.on && !old.continuation
    && !old.approval && !old.slot && !old.place && !old.local_approval
    && !old.standing && !old.standing_target && !old.standing_digest
    && !old.delivery && !old.deliver_place
    && !w.prompt?.includes('<!-- house: local -->')
    && !String(old.prompt ?? '').includes('<!-- house: local -->');
}
