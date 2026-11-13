import { z } from 'zod';
import { type State, type Approval, stateOf, forOf } from './model.js';
import { request, withdraw, type DomainContext } from './domain.js';
import { denied, vouchOf, covered } from './targets.js';

/** The clock supplies a current, eligible snapshot. This owning transaction alone
 * filters decisions and replaces unanswered cards. No shadow denial ledger. */
export const vouchCandidates = z.array(z.object({
  id: z.string(), automatic: z.boolean(), details: z.string().max(83),
}).strict());
export function groupVouch(s: State, input: Record<string, unknown>, c: DomainContext): Approval | null {
  const rows = vouchCandidates.parse(input.candidates);
  const agent = c.caller.who.agent;
  if (!c.piece || c.caller.who.where !== "loom's clock" || c.caller.for !== 'owner'
    || c.caller.project || c.caller.people?.length || c.caller.conversation)
    denied('Grouped vouch filing belongs to the clock acting for owner');
  const candidates = new Map(rows.map(row => {
    if (!vouchOf(`${agent}:${row.id}`) || !row.details.startsWith(`${row.id} fires `))
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
  const previous = new Set(pending.flatMap(covered));
  const ids: string[] = [];
  for (const id of [...candidates.keys()].sort()) {
    if (deniedIds.has(id) || occupied.has(id) || !(candidates.get(id)!.automatic || previous.has(id))) continue;
    if (ids.length === 12 || `${agent}:${[...ids,id].join(',')}`.length > 200) break;
    ids.push(id);
  }
  // Losing one candidate does not churn a card while other listed work remains.
  if (pending.length === 1 && ids.length && ids.every(id => previous.has(id))) {
    if (c.canRead && !c.canRead(pending[0])) denied('An existing decision prevents this request');
    return pending[0];
  }
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
    details:ids.map(id=>candidates.get(id)!.details).join('\n'),
  }, c);
}
