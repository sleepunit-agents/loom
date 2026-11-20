import { z } from 'zod';
import { type State, type Approval, stateOf, forOf } from './model.js';
import { vouchDetails } from './vouch-details.js';
import { request, withdraw, type DomainContext } from './domain.js';
import { denied, vouchOf, covered } from './targets.js';

/** The clock supplies a current, eligible snapshot. This owning transaction alone
 * filters decisions and replaces unanswered cards. No shadow denial ledger. */
export const vouchCandidates = z.array(z.object({
  id: z.string(), automatic: z.boolean(), due: z.number().int().safe().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
  note:z.string().max(100_000), executable:z.string().min(1).max(100_010),
}).strict());
export function groupVouch(s: State, input: Record<string, unknown>, c: DomainContext): Approval | null {
  const rows = vouchCandidates.parse(input.candidates);
  const agent = c.caller.who.agent;
  if (!c.piece || c.caller.who.where !== "loom's clock" || c.caller.for !== 'owner'
    || c.caller.project || c.caller.people?.length || c.caller.conversation)
    denied('Grouped vouch filing belongs to the clock acting for owner');
  const candidates = new Map(rows.map(row => {
    if (!vouchOf(`${agent}:${row.id}`))
      denied('Each candidate lists its exact wake and saved due time');
    return [row.id, row];
  }));
  const cards = s.approvals.filter(a => a.kind === 'vouch-wake' && a.who.agent === agent);
  const own = (a: Approval) => a.who.where === "loom's clock" && forOf(a) === 'owner' && !a.project && !a.member && !a.conversation && !a.people?.length;
  const pending = cards.filter(a => own(a) && stateOf(a,c.now) === 'pending');
  // An answer stands, even if application must wait. Never withdraw or refresh it.
  const allowed = cards.find(a => own(a) && stateOf(a,c.now) === 'allowed');
  if (allowed) return c.canRead && !c.canRead(allowed) ? null : allowed;
  const deniedIds = new Set(cards.filter(a => a.state === 'denied').flatMap(covered));
  const occupied = new Set(cards.filter(a => !pending.includes(a) && ['pending','allowed'].includes(stateOf(a,c.now))).flatMap(covered));
  for (const card of pending) if (c.canRead && !c.canRead(card)) denied('An existing decision prevents this request');
  const previous = new Set(pending.flatMap(covered));
  const eligible = [...candidates.keys()].sort().filter(id=>!deniedIds.has(id) && !occupied.has(id));
  const retained = eligible.filter(id=>previous.has(id));
  const ids: string[] = [];
  // Existing explicit choices cannot fall out of the group at its capacity cap.
  for (const id of [...retained,...eligible.filter(id=>!previous.has(id) && candidates.get(id)!.automatic)]) {
    if (ids.length === 12 || `${agent}:${[...ids,id].join(',')}`.length > 200) break;
    ids.push(id);
  }
  if (retained.some(id=>!ids.includes(id)) || pending.length && ids.length && ids.every(id=>previous.has(id))) {
    // Preserve separate explicit cards until new selected work can join all of
    // their still-eligible ids. Empty cards can be withdrawn independently.
    for (const card of pending) if (!covered(card).some(id=>retained.includes(id))) withdraw(s,card.id,c);
    return pending.find(card=>stateOf(card,c.now)==='pending') ?? null;
  }
  ids.sort();
  for (const card of pending) {
    if (c.canRead && !c.canRead(card)) denied('An existing decision prevents this request');
    withdraw(s,card.id,c);
  }
  if (!ids.length) return null;
  return request(s, {
    kind:'vouch-wake', target:`${agent}:${ids.join(',')}`,
    ask:'Count these scheduled jobs as your work?',
    why:'These imported jobs have no verified owner and remain held.',
    if_yes:'Eligible jobs become your work with their saved words and due times.',
    if_no:'The jobs remain held and are not asked about again.',
    details:vouchDetails(ids.map(id=>candidates.get(id)!)),
  }, c);
}
