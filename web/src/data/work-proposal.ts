import { SHA256_HEX } from '../../../src/core/sha256-hex.js';
/** What a waiting household card would replace, read for a household owner.
 *
 * The card does not carry it. An agent files the card and may read it, and so may others; what the agent
 * asked to change is usually something they may not read. So the card holds the change asked for, and the
 * program works out what it would replace, and anything that already stands against it, for an owner who
 * asks (household.proposalPreview). Anyone else is refused, and this answers with nothing. */
export interface ProposalFact { label: string; value: string; small?: boolean }
export interface ProposalNow { review?: string; exact?: string; summary: string; problem: string | null;
  /** The card as an owner reads it, and the plain line saying it cannot be allowed (with what would fix it). */
  card: { title: string; nothing: boolean; facts: ProposalFact[]; exact: string; ifYes?: string; ifNo?: string } | null; blocked: string | null }
const facts = (value: unknown): ProposalFact[] | undefined => Array.isArray(value) && value.every(fact => fact && typeof fact === 'object' && typeof (fact as ProposalFact).label === 'string' && typeof (fact as ProposalFact).value === 'string')
  ? value.map(fact => ({ label: (fact as ProposalFact).label, value: (fact as ProposalFact).value, ...((fact as ProposalFact).small === true ? { small: true } : {}) })) : undefined;
export async function readProposal(id: string, request: typeof fetch = fetch): Promise<ProposalNow | undefined> {
  try {
    const response = await request('/api/household/proposalPreview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { id } }) });
    const result: unknown = await response.json();
    if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('value' in result) || !result.value || typeof result.value !== 'object') return;
    const value = result.value as Partial<ProposalNow>;
    if (typeof value.summary !== 'string' || !(value.problem === null || typeof value.problem === 'string')) return;
    const told = value.card, said = told && typeof told === 'object' ? facts(told.facts) : undefined, exact = told?.exact;
    return { ...(typeof value.review==='string' && SHA256_HEX.test(value.review) ? {review:value.review} : {}), ...(typeof value.exact === 'string' ? { exact: value.exact } : {}), summary: value.summary, problem: value.problem, blocked: typeof value.blocked === 'string' ? value.blocked : null,
      card: told && typeof told.title === 'string' && said && typeof exact === 'string' ? { title: told.title, nothing: told.nothing === true, facts: said, exact,
        ...(typeof told.ifYes === 'string' ? { ifYes: told.ifYes } : {}),
        ...(typeof told.ifNo === 'string' ? { ifNo: told.ifNo } : {}) } : null };
  } catch { return; }
}
