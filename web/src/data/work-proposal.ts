/** What a waiting household card would replace, read for a household owner.
 *
 * The card does not carry it. An agent files the card and may read it, and so may others; what the agent
 * asked to change is usually something they may not read. So the card holds the change asked for, and the
 * program works out what it would replace, and anything that already stands against it, for an owner who
 * asks (household.proposal). Anyone else is refused, and this answers with nothing. */
export interface ProposalNow { summary: string; problem: string | null }
export async function readProposal(id: string, request: typeof fetch = fetch): Promise<ProposalNow | undefined> {
  try {
    const response = await request('/api/household/proposal', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { id } }) });
    const result: unknown = await response.json();
    if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('value' in result) || !result.value || typeof result.value !== 'object') return;
    const value = result.value as Partial<ProposalNow>;
    return typeof value.summary === 'string' && (value.problem === null || typeof value.problem === 'string') ? { summary: value.summary, problem: value.problem } : undefined;
  } catch { return; }
}
