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
  return vouchable(w) && w.member === undefined && w.project === undefined && !(Array.isArray(w.legacy?.for_people) ? w.legacy.for_people.length : w.legacy?.for_people)
    && !['steered', 'other-agent'].includes(String(w.legacy?.for_why));
}
/** Archived ownership hints only restrict automatic selection. */
export function automaticVouch(w: Wake): boolean {
  return askable(w) && w.legacy?.origin === `agent:${w.agent}` && w.legacy?.for_why === 'none';
}
/** Every id and due time survives the owning card's 1000-character details cap.
 * Reserve room for executable words even when the saved note is very long.
 * Automatic candidates use twelve slots before Approvals selects its group.
 */
export function vouchDetails(rows: Wake[], slots = rows.length): string {
  const room = Math.floor(1000 / slots) - 1;
  const plain = (words: string) => words.normalize('NFKC').replace(/[\p{C}]/gu, ' ');
  const clip = (words: string, size: number) => words.length <= size ? words : size >= 3 ? words.slice(0, size - 3) + '...' : words.slice(0, size);
  return rows.map(w => {
    const prefix = `${w.id} fires ${new Date(w.due).toISOString()}: `;
    const available = Math.max(0, room - prefix.length);
    const executable = plain(w.file ? `file: ${w.file}` : `runs: ${w.prompt ?? ''}`);
    const note = plain(w.note);
    if (!note) return prefix + clip(executable, available);
    const separator = ' | ';
    const contentRoom = Math.max(0, available - separator.length);
    const executableRoom = Math.min(executable.length, Math.ceil(contentRoom * 2 / 3));
    const noteRoom = Math.min(note.length, contentRoom - executableRoom);
    return prefix + clip(note, noteRoom) + separator + clip(executable, Math.max(0, available - noteRoom - separator.length));
  }).join('\n');
}
