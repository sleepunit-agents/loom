import type { Answer } from './dependencies/approvals.js';
import type { Wake } from './store.js';

const resumed = /^(?:(?:Resumed(?: after your OK| after you said no| after your answer \([^)]*\)|, [^:]*)|unparked \([^)]*\)): )+/;
const labels: Record<Answer['state'], string> = {
  allowed: 'Resumed after your OK', granted: 'Resumed after your OK', denied: 'Resumed after you said no',
  pending: 'Resumed, no answer in 24h', expired: 'Resumed, your OK expired', unknown: "Resumed, your answer couldn't be read",
  used: 'Resumed after your answer (used)', withdrawn: 'Resumed after your answer (withdrawn)', cancelled: 'Resumed after your answer (cancelled)',
};
const ownerApplied = new Set(['grant', 'vouch-wake', 'principal-reset', 'box-write-off', 'host']);
// Python shlex.quote's portable single-word form, including embedded apostrophes.
const quote = (value: string) => /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
function spendWords(id: string, answer: Answer) {
  if (answer.kind && ownerApplied.has(answer.kind)) return `The owner allowed ${id}, and the piece that filed it applies it: there's nothing for you to spend. Check it took (wake list, or Permissions), and pick up where you left off.`;
  if (answer.instruction) return answer.instruction;
  if (answer.kind === 'local-wake') return `The clock no longer has the words ${id} was filed for, so it can't be set from it. Don't spend it: comment on the task what was waiting, set the wake again with its words (-p) so the owner is asked once more, and park on the new id.`;
  if (answer.kind && answer.target) return `Pick up where you left off, and spend it on exactly the action it allows (${answer.kind} for ${answer.target}): \`approvals use ${quote(id)} --kind ${quote(answer.kind)} --target ${quote(answer.target)}\`, or the tool that asked with this id (${id}). Don't ask again: any of this agent's bodies spends it, once.`;
  return `Pick up where you left off, and spend it with --approval ${id} on exactly the action it allows.`;
}
/** The role supplies spending instructions. Saved request metadata never authorizes a spend.
 * In particular a pending card's instruction cannot survive a denial or timeout.
 */
export function unpark(w: Wake, answer: Answer) {
  const id = w.wait!.id, state = answer.state;
  let head: string;
  if (state === 'allowed' || state === 'granted') {
    const how = id.startsWith('q-')
      ? "Pick up where you left off. A secret: request it again (the secrets piece's `request <name> --why …`), and it's granted to this house at once; then get it."
      : spendWords(id, answer);
    head = `The owner allowed ${id}. ${how}`;
  } else if (state === 'pending') {
    head = `No answer to ${id} after 24h. Leave a comment saying what's waiting on the owner and stop; don't ask again unless the work needs it now.`;
  } else {
    head = `The owner's answer to ${id}: ${state}. Don't work around it: comment on the task what's blocked and why, and wrap up cleanly.`;
  }
  w.wait!.answer = state;
  w.prompt = `${head}\n\n---\n\n${w.prompt ?? ''}`;
  w.note = `${labels[state]}: ${w.note.replace(resumed, '')}`;
}
