import { expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Approvals, { ApprovalCard, type ApprovalActions } from './index';
import { approvalTitle, type Approval, type ApprovalSnapshot } from './model';

const gage = { platform: 'slack', workspace: 'T02AYL3QM', user: 'U07V8CZUC1J' };
/** A household card exactly as an older version stored it: the title, question and summary are the raw lines. */
function stored(change: string, after: unknown, more: Partial<Approval> = {}): Approval {
  const raw = `${change} art/pond-et-livonia ${JSON.stringify(gage)}: ${JSON.stringify(after)}`;
  return { id: 'a-' + change, kind: 'setting', operation: 'household.change', target: `household:${change}:art/pond-et-livonia ${JSON.stringify(gage)}`, what: raw, changeSummary: raw,
    ask: 'Grant art kit pond-et-livonia to slack user U07V8CZUC1J in T02AYL3QM?', ifYes: 'Grant art kit pond-et-livonia to slack user U07V8CZUC1J in T02AYL3QM.', ifNo: 'Keep the current access.',
    why: 'Restore the recorded Pond field scope.', agent: 'art', project: null, member: null, conversation: null, state: 'pending',
    details: JSON.stringify({ change, after, seal: { nonce: 'n', digest: 'd' } }), askedAt: '2026-11-19T15:00:00Z', decidedBy: null, expiresAt: null, ...more };
}
const grant = stored('kitGrant', { agent: 'art', grant: true, kit: 'pond-et-livonia', to: gage });
const actions: ApprovalActions = { allow: async () => {}, deny: async () => {} };
const snapshot = (...approvals: Approval[]): ApprovalSnapshot => ({ status: 'live', approvals, rules: [], notices: [], record: [], timezone: 'America/Chicago' });
const app = (card: Approval) => renderToStaticMarkup(h(Approvals, { snapshot: snapshot(card), actions, navigation: { selected: card.id, select() {}, folder: 'pending', openFolder() {} } }));
const chat = (card: Approval) => renderToStaticMarkup(h(ApprovalCard, { id: card.id, snapshot: snapshot(card), actions }));
/** Raw JSON, as it is written and as markup escapes it. */
const json = /\{"|\{&quot;|\[\{/;

it('says a card filed with raw lines in plain words, made from the change it keeps: in the list, the reader and the chat card', () => {
  const sentence = 'Let the Slack account U07V8CZUC1J (workspace T02AYL3QM) use art’s pond-et-livonia kit';
  expect(approvalTitle(grant)).toBe(sentence);
  for (const markup of [app(grant), chat(grant)]) {
    expect(markup).toContain(sentence);
    expect(markup).toContain('Restore the recorded Pond field scope.');
    expect(markup).not.toContain('In that person’s own conversations with Art.');
    expect(markup).not.toContain('They can have Art use the kit’s tools for them.');
    expect(markup).not.toMatch(json);
    expect(markup).not.toContain('Grant art kit');
  }
  // The exact fields are kept for the record under a closed Details.
  expect(app(grant)).not.toContain("Exact request");
});
it('draws an owner’s reading over it: the name loom holds, what the kit does, and the raw id small and last', () => {
  const card = { ...grant, card: { title: 'Let Gage Taylor (Slack) use Art’s pond-et-livonia kit', nothing: false, exact: JSON.stringify(gage,null,2),
    facts: [{ label: 'Who', value: 'Gage Taylor, on Slack' }, { label: 'What the kit does', value: 'pond_status: Read station status.' }, { label: 'Account id', value: 'U07V8CZUC1J', small: true }] } };
  for (const markup of [app(card), chat(card)]) {
    expect(markup).toContain('Let Gage Taylor (Slack) use Art’s pond-et-livonia kit');
    expect(markup).toContain('pond_status: Read station status.');
    expect(markup).toContain('<span class="loom-reader__meta">U07V8CZUC1J</span>');
    expect(markup).not.toMatch(json);
  }
  expect(app(card)).toMatch(/aria-expanded="false"[^>]*>Exact request</);
});
it('says why a card cannot be allowed before anyone presses Allow: both answer buttons stay available', () => {
  const blocked = 'This cannot be allowed yet: Art does not take messages from this account. Deny this card, and ask for it again once that is done.';
  const card = { title: 'Owner title', facts: [], exact: '{}', nothing: false };
  for (const markup of [app({ ...grant, card, blocked }), chat({ ...grant, card, blocked })]) {
    expect(markup).toContain('loom will refuse this as things stand: Art does not take messages');
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Allow<\/button>/);
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Deny<\/button>/);
  }
  // With nothing against it, Allow is on.
  expect(app(grant)).toMatch(/<button(?![^>]*disabled)[^>]*>Allow<\/button>/);
  // An answered card says nothing against itself, whatever was read while it waited.
  expect(app({ ...grant, state: 'denied', card, blocked })).not.toContain(blocked);
});
it.each([
  ['bridge', { action: 'disconnect', id: 'mark-discord' }, 'Disconnect the Discord or Slack connection mark-discord'],
  ['boxSettings', { box: 'box-1', name: 'one', hostsAny: true, reportOnly: false, alwaysOn: true, agents: [{ agent: 'art', lent: false }], facts: [] }, 'Change the settings of the machine one'],
  ['models', { agent: 'art', models: ['fable', 'opus'] }, 'Change the models art may use'],
  ['remove', { of: 'agent', id: 'mark' }, 'Remove the agent mark from the household'],
  ['bodyPolicy', { agent: 'art', people: [{ ...gage, tier: 2 }], deniedTools: [] }, 'Change which outside people art takes messages from, and which tools it is not given'],
  ['kit', { agent: 'art', kit: 'pond', tools: [{ name: 'status', description: 'Read status.', repository: 'https://example.com/house.git', commit: 'a'.repeat(40), image: 'sha256:' + 'b'.repeat(64), program: 'bin/read', args: [{ parameter: 'station' }], parameters: { station: { type: 'string', description: 'Station' } }, secrets: { KIT: 'pond-token' } }] }, 'Give art a kit called pond, with 1 tool'],
])('draws a %s card with no raw JSON anywhere a person looks', (change, after, sentence) => {
  const card = stored(change, after);
  for (const markup of [app(card), chat(card)]) { expect(markup).toContain(sentence); expect(markup).not.toMatch(json); }
});
it('shows any other approval, and a household card of a kind it does not know, in the words it stored', () => {
  const other: Approval = { ...grant, id: 'a-merge', operation: null, kind: 'merge', target: 'github:a/b#1@abc', what: 'Merge the pump change', ask: 'Merge it?', details: '', changeSummary: null };
  expect(app(other)).toContain('Merge the pump change');
  const unknown = stored('somethingNew', { a: 1 }, { what: 'A stored title' });
  expect(approvalTitle(unknown)).toBe('A stored title');
});
