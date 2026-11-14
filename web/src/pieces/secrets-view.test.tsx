import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import { SecretsView, type SecretsSnapshot, type SecretsFolder, type SecretsSelection } from './secrets-view';
import SettingsApp from './settings';
vi.mock('../data', () => ({
  useRecords: () => { throw new Error('Shared Settings must not read legacy records'); },
  call: () => { throw new Error('Shared Settings must not issue legacy commands'); },
}));
// Dynamic props are confined to the renderer boundary.
vi.mock('../kit', () => ({
  Split: (p: any) => h('main', {}, ...p.folders.map((f: any) => h('button', { key: f.id, onClick: () => p.onFolder(f.id) }, f.label, `:${f.count ?? ''}`)), p.listTop, p.list, p.reader ?? p.blank, h('button', { onClick: p.onBack }, p.backLabel)),
  List: (p: any) => h('div', {}, p.children),
  Row: (p: any) => h('button', { onClick: p.onClick, 'aria-current': p.selected }, p.title, p.meta, p.status),
  Empty: (p: any) => h('p', {}, p.title), Error: (p: any) => h('p', { role: 'alert' }, p.text), Loading: (p: any) => h('p', { role: 'status' }, p.label),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: any;
const select = vi.fn(), changeFolder = vi.fn();
const text = () => JSON.stringify(tree.toJSON());
const button = (label: string) => tree.root.findAllByType('button').find((b: any) => b.children.includes(label));
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.clearAllMocks(); });
function snapshot(): SecretsSnapshot {
  return {
    status: 'live', member: 'jonathan',
    secrets: [{ name: 'github-token', description: 'Merge household pull requests', changedBy: 'jonathan', changedAt: '2026-11-14T20:00:00.000Z' }],
    grants: [{ id: 'g-1', secret: 'github-token', agent: 'art', job: 'j-1', request: 'q-1', grantedBy: 'rule', grantedAt: '2026-11-14T20:00:00.000Z', expiresAt: '2026-11-14T21:00:00.000Z' }],
    requests: [{ id: 'q-1', secret: 'github-token', agent: 'art', job: 'j-1', conversation: 'cv-1', why: 'To merge the fix', state: 'pending', minutes: 30, answeredBy: null, always: false, askedAt: '2026-11-14T20:00:00.000Z', answeredAt: null }],
    rules: [{ secret: 'github-token', answer: 'auto', minutes: 30 }],
    ruleAgents: [{ secret: 'github-token', agent: 'art', when: 'on_request' }, { secret: 'github-token', agent: 'art', when: 'at_start' }],
    uses: (['started', 'released', 'failed'] as const).map(state => ({ id: state, secret: 'github-token', agent: 'art', job: 'j-1', at: '2026-11-14T20:00:00.000Z', state })),
    changes: [{ id: 'ch-1', secret: 'github-token', action: 'replace', by: 'jonathan', at: '2026-11-14T20:00:00.000Z' }],
  };
}
async function draw(s = snapshot(), folder: SecretsFolder = 'secrets', id?: string, cards?: Parameters<typeof SecretsView>[0]['cards'], selected?: SecretsSelection) {
  const element = h(SecretsView, { snapshot: s, member: 'jonathan', folder, selected: selected ?? (id ? { folder, id } : undefined), cards, select, changeFolder });
  await act(async () => { if (tree) tree.update(element); else tree = create(element); });
}
it('shows shared metadata, separate rule assignments and each delivery outcome', async () => {
  const s = snapshot(), secret = vi.fn(name => h('button', {}, `Manage ${name}`));
  s.uses = [...s.uses, { ...s.uses[0], id: 'other', secret: 'OTHER-SECRET', agent: 'OTHER-AGENT' }];
  s.changes = [...s.changes, { ...s.changes[0], id: 'other', secret: 'OTHER-SECRET', by: 'OTHER-MEMBER' }];
  await draw(s, 'secrets', 'github-token', { secret });
  for (const value of ['Merge household', 'Who may use it', 'At startup', 'When asked', 'Standing answer', 'Delivery unconfirmed', 'Delivered', 'Failed', 'replace', 'write-only', 'Job: ', 'j-1']) expect(text()).toContain(value);
  expect(text()).not.toContain('OTHER-AGENT'); expect(text()).not.toContain('OTHER-MEMBER');
  expect(secret).toHaveBeenCalledWith('github-token'); expect(tree.root.findAllByType('input')).toHaveLength(0);
});
it.each(['offline', 'error', 'loading', 'member'] as const)('hides retained metadata and does not invoke controls on %s', async mode => {
  const secret = vi.fn(() => h('button', {}, 'Manage secret'));
  const s = snapshot(); await draw(s, 'secrets', 'github-token', { secret });
  expect(text()).toContain('Manage secret'); secret.mockClear();
  await draw({ ...s, ...(mode === 'member' ? { member: 'someone-else' } : { status: mode }) }, 'secrets', 'github-token', { secret });
  expect(text()).not.toContain('github-token'); expect(text()).not.toContain('Manage secret');
  expect(secret).not.toHaveBeenCalled(); expect(tree.root.findAllByType('button')).toHaveLength(0);
});
it('closes secret controls when a live update removes the selected name', async () => {
  const secret = vi.fn(() => h('button', {}, 'Manage secret'));
  await draw(snapshot(), 'secrets', 'github-token', { secret }); secret.mockClear();
  await draw({ ...snapshot(), secrets: [] }, 'secrets', 'github-token', { secret });
  expect(text()).toContain('no longer available'); expect(text()).not.toContain('Manage secret'); expect(secret).not.toHaveBeenCalled();
});
it('shows request context and retires answer controls immediately after an answer', async () => {
  const request = vi.fn(id => h('button', {}, `Answer ${id}`)), s = snapshot();
  await draw(s, 'requests', 'q-1', { request });
  for (const value of ['To merge the fix', 'cv-1', 'j-1', '30', 'Answer q-1']) expect(text()).toContain(value);
  expect(request).toHaveBeenCalledWith('q-1'); request.mockClear();
  await draw({ ...s, requests: s.requests.map(row => ({ ...row, state: 'allowed', answeredBy: 'jonathan', answeredAt: '2026-11-14T20:01:00.000Z', always: true })) }, 'requests', 'q-1', { request });
  expect(text()).toContain('standing rule was made'); expect(text()).not.toContain('Answer q-1'); expect(request).not.toHaveBeenCalled();
  expect(button('Requests').children).toContain(':0');
});
it('shows grant scope and recorded expiry without inventing current validity', async () => {
  const grant = vi.fn(id => h('button', {}, `Revoke ${id}`));
  await draw(snapshot(), 'grants', 'g-1', { grant });
  expect(text()).toContain('2026-11-14T21:00:00.000Z'); expect(text()).toContain('q-1'); expect(grant).toHaveBeenCalledWith('g-1');
  const s = snapshot(); await draw({ ...s, grants: s.grants.map(row => ({ ...row, job: null })) }, 'grants', 'g-1');
  expect(text()).toContain('Agent-wide'); expect(text()).not.toContain('No expiry');
});
it('does not guess a missing household default', async () => {
  const s = { ...snapshot(), rules: [], ruleAgents: [] };
  await draw(s, 'secrets', 'github-token'); expect(text()).toContain('Household default not loaded');
  await draw({ ...s, defaultAnswer: 'never' }, 'secrets', 'github-token'); expect(text()).toContain('Household default: never');
});
it('navigates by stable ids, clears selection on folder changes, and scopes selection to its folder', async () => {
  await draw(); await act(async () => button('github-token').props.onClick());
  expect(select).toHaveBeenCalledWith({ folder: 'secrets', id: 'github-token' });
  await act(async () => button('Requests').props.onClick());
  expect(select).toHaveBeenLastCalledWith(undefined); expect(changeFolder).toHaveBeenCalledWith('requests');
  await draw(snapshot(), 'requests', undefined, undefined, { folder: 'grants', id: 'q-1' });
  expect(tree.root.findAllByType('article')).toHaveLength(0);
});
it('mounts add controls only in the add view and removes them on disconnection', async () => {
  const add = vi.fn(() => h('button', {}, 'Write-only form'));
  await draw(snapshot(), 'secrets', undefined, { add }); expect(add).not.toHaveBeenCalled();
  await act(async () => button('Add a secret').props.onClick()); expect(changeFolder).toHaveBeenCalledWith('add');
  await draw(snapshot(), 'add', undefined, { add }); expect(text()).toContain('Write-only form'); add.mockClear();
  await draw({ ...snapshot(), status: 'offline' }, 'add', undefined, { add });
  expect(text()).not.toContain('Write-only form'); expect(add).not.toHaveBeenCalled();
});
it('reaches shared Secrets through the actual Settings app without legacy reads or commands', async () => {
  await act(async () => { tree = create(h(SettingsApp, { shared: { snapshot: snapshot(), member: 'jonathan', folder: 'secrets', selected: { folder: 'secrets', id: 'github-token' }, select, changeFolder } })); });
  expect(text()).toContain('Merge household pull requests'); expect(text()).toContain('Delivery unconfirmed');
});
