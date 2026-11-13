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

/** Archived strings can exclude a request, never authenticate its asker. */
export function askable(w: Wake): boolean {
  return vouchable(w) && !(Array.isArray(w.legacy?.for_people) ? w.legacy.for_people.length : w.legacy?.for_people)
    && !['steered', 'other-agent'].includes(String(w.legacy?.for_why));
}
/** Every id and due time survives the owning card's 1000-character details cap. */
export function vouchDetails(rows: Wake[]): string {
  const room = Math.floor(1000 / rows.length) - 1;
  return rows.map(w => {
    const prefix = `${w.id} fires ${new Date(w.due).toISOString()}: `;
    const words = (w.note || w.file || 'Saved wake').normalize('NFKC').replace(/[\p{C}]/gu, ' ');
    return prefix + words.slice(0, Math.max(0, room - prefix.length));
  }).join('\n');
}
