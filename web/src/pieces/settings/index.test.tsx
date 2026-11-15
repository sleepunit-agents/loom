import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { SettingsData } from './data';
import { settingsQuery } from './data';
import SettingsApp from './index';
const feed = vi.hoisted(() => ({ query: { status: 'loading' } as DataQuerySnapshot<SettingsData>, hook: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery: (query: string) => { feed.hook(query); return feed.query; } }));
vi.mock('../../data', () => ({ useRecords() { throw Error('Legacy records used'); }, call() { throw Error('Legacy command used'); } }));
vi.mock('../../kit', () => ({
  Split: (p: any) => h('main', {}, ...p.folders.map((f: any) => h('button', { key: f.id, onClick: () => p.onFolder(f.id) }, f.label)), p.list, p.reader ?? p.blank, h('button', { onClick: p.onBack }, p.backLabel)),
  List: (p: any) => h('div', {}, p.children), Row: (p: any) => h('button', { onClick: p.onClick }, p.title, p.meta, p.status),
  Empty: (p: any) => h('p', {}, p.title), Error: (p: any) => h('p', { role: 'alert' }, p.text), Loading: (p: any) => h('p', {}, p.label),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: any;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; feed.hook.mockClear(); });
const text = () => JSON.stringify(tree.toJSON());
function data(): SettingsData {
  return { secretsReader: { id: 'jonathan', defaultAnswer: 'ask' }, secrets: [{ name: 'API', description: 'Reads the forge', changedAt: '2026-11-14T12:00:00.000Z', changedBy: 'jonathan' }], secretGrants: [], secretRequests: [], secretRules: [], secretRuleAgents: [], secretUses: [], secretChanges: [] };
}
async function draw(path = '/p/settings-preview', go = vi.fn()) {
  await act(async () => { const app = h(SettingsApp, { path, go }); if (tree) tree.update(app); else tree = create(app); });
  return go;
}
it('the registered Settings app reads generated metadata and navigates to its write-only secret reader', async () => {
  feed.query = { status: 'live', data: data() }; const go = await draw();
  expect(feed.hook).toHaveBeenCalledWith(settingsQuery); expect(text()).toContain('Reads the forge');
  const row = tree.root.findAllByType('button').find((b: any) => b.children.includes('API'));
  await act(async () => row.props.onClick()); expect(go).toHaveBeenCalledWith('/p/settings-preview/item/secrets/API');
  await draw(go.mock.calls[0][0], go); expect(text()).toContain('The value is write-only.'); expect(text()).toContain('Household default: ask');
});
it.each(['loading', 'offline', 'denied'] as const)('hides retained secret metadata while %s', async status => {
  feed.query = { status: 'live', data: data() }; await draw('/p/settings-preview/item/secrets/API'); expect(text()).toContain('Reads the forge');
  feed.query = { status, data: data() }; await draw('/p/settings-preview/item/secrets/API'); expect(text()).not.toContain('Reads the forge'); expect(text()).not.toContain('API');
});
it('requires the authenticated member from the same selection and discards the old reader after a principal change', async () => {
  const initial = data(); feed.query = { status: 'live', data: initial }; await draw('/p/settings-preview/item/secrets/API');
  feed.query = { status: 'live', data: { ...initial, secretsReader: null } }; await draw('/p/settings-preview/item/secrets/API'); expect(text()).not.toContain('Reads the forge');
  feed.query = { status: 'live', data: { ...initial, secretsReader: { id: 'other', defaultAnswer: 'ask' }, secrets: [] } }; await draw('/p/settings-preview/item/secrets/API');
  expect(text()).not.toContain('Reads the forge'); expect(text()).toContain('This item is no longer available');
});
it('handles malformed selection ids and never requests a value field', async () => {
  feed.query = { status: 'live', data: data() }; await draw('/p/settings-preview/item/secrets/%');
  expect(text()).toContain('Choose an item'); expect(settingsQuery).not.toMatch(/\bvalue\b/);
});
