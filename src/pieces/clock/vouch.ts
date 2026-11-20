import { vouchDetails as renderVouchDetails } from '../approvals/role.js';
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
  return vouchable(w) && w.member === undefined
    && w.legacy?.member === undefined && (w.legacy?.project === undefined || w.legacy.project === w.project) && !(Array.isArray(w.legacy?.for_people) ? w.legacy.for_people.length : w.legacy?.for_people)
    && !['steered', 'other-agent'].includes(String(w.legacy?.for_why));
}
/** Archived ownership hints only restrict automatic selection. */
export function automaticVouch(w: Wake): boolean {
  return askable(w) && w.project === undefined && w.legacy?.project === undefined && w.legacy?.origin === `agent:${w.agent}` && w.legacy?.for_why === 'none';
}
/** Shape saved work for the owning card renderer without restoring authority. */
export function vouchWords(w: Wake) {
  return {id:w.id,due:w.due,note:w.note,executable:w.file ? `file: ${w.file}` : `runs: ${w.prompt ?? ''}`};
}
export function vouchDetails(rows: Wake[]): string { return renderVouchDetails(rows.map(vouchWords)); }
