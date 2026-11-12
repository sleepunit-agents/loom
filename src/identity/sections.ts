/**
 * Standard identity sections for every agent. Budgets are UTF-8 byte targets
 * for rendered sections, not limits: readers never truncate authored content.
 * Requested project/room/mode blocks and recorder warnings are supplements.
 * The legacy memory index is available only in the historical `all` output.
 */
export interface IdentitySection {
  name: string;
  purpose: string;
  writer: string;
  boot: 'core' | 'piece';
  loadWhen: string;
  byteBudget: number;
}

// Historical full-output order; core keeps the same relative order.
export const IDENTITY_SECTIONS = [
  { name: 'creed', purpose: 'Who the agent is: values, voice and boundaries', writer: 'Owner approves; agent maintains', boot: 'core', loadWhen: 'at every boot', byteBudget: 8_200 },
  { name: 'preferences', purpose: 'How the owner likes to work', writer: 'Agent, from owner direction', boot: 'core', loadWhen: 'at every boot', byteBudget: 9_400 },
  { name: 'owners', purpose: 'Who owns this agent', writer: 'Household owner; loom renders member and People data', boot: 'core', loadWhen: 'at every boot', byteBudget: 300 },
  { name: 'last-24h', purpose: 'Recent work across bodies', writer: 'Bodies write episodes and conversation digests; loom assembles', boot: 'piece', loadWhen: 'when you need what other bodies did recently', byteBudget: 8_000 },
  { name: 'top-of-mind', purpose: 'Salience-ranked authored memories', writer: 'Agent writes memories; loom assembles', boot: 'core', loadWhen: 'at every boot', byteBudget: 5_000 },
  { name: 'self-model', purpose: 'The agent’s capabilities and self-knowledge', writer: 'Agent', boot: 'piece', loadWhen: 'before reflection, retro or identity work', byteBudget: 20_000 },
  { name: 'harness', purpose: 'Runtime manifest and client adapter', writer: 'Agent through harness tools; loom supplies adapter defaults', boot: 'piece', loadWhen: 'before scheduling, delegation, hooks, or harness-specific gotchas (pass client)', byteBudget: 20_000 },
  { name: 'model', purpose: 'Model-specific capability notes', writer: 'Agent', boot: 'piece', loadWhen: 'when choosing or describing models (pass model)', byteBudget: 4_000 },
] as const satisfies readonly IdentitySection[];

export type IdentitySectionName = typeof IDENTITY_SECTIONS[number]['name'];
export const IDENTITY_CORE_BUDGET_BYTES = 24_000;

export function identitySection(name: string): IdentitySection | undefined {
  return IDENTITY_SECTIONS.find(section => section.name === name);
}

export function identityPiecesIndex(): string {
  return '# Pieces\n\nLoad with identity({piece: "name"}); pass client/model for their manifests.\n' +
    'Use piece: "all" for the full identity.\n\n' +
    IDENTITY_SECTIONS.filter(section => section.boot === 'piece')
      .map(section => `- ${section.name} — load ${section.loadWhen}`).join('\n');
}
