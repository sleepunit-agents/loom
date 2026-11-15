import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
// @ts-expect-error The existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => h('button', props),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => h('input', props),
}));
import { MeasuringChange, MeasuringSettingsProposal, type MeasuringSettings } from './settings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const off: MeasuringSettings = { on: false, send_outside: false, outside_address: '', keep_days: 90 };
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const text = () => JSON.stringify(tree.toJSON());
const submit = () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} });
async function toggle() {
  await act(async () => tree.root.findAllByType('input').find((node: { props: { type: string } }) => node.props.type === 'checkbox').props.onChange({ target: { checked: true } }));
}

it('shows every persisted before/after value, including settings retained while off', async () => {
  const after = { on: true, send_outside: true, outside_address: 'https://monitor.example/v1/traces', keep_days: 7 };
  await act(async () => { tree = create(h(MeasuringChange, { before: off, after })); });
  expect(text()).toContain('Before'); expect(text()).toContain('After');
  expect(text()).toContain('Off'); expect(text()).toContain('On');
  expect(text()).toContain('Do not send measurements'); expect(text()).toContain('Send measurements');
  expect(text()).toContain('None'); expect(text()).toContain(after.outside_address);
  expect(text()).toContain('90'); expect(text()).toContain('7');
});

it('requests the exact previewed change without modifying authoritative settings and waits for approval', async () => {
  const propose = vi.fn(async () => {}), current = Object.freeze({ ...off });
  await act(async () => { tree = create(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value: current }, propose })); });
  expect(tree.root.findByType('button').props.disabled).toBe(true);
  expect(tree.root.findAllByType(MeasuringChange)).toHaveLength(0);
  await toggle();
  expect(propose).not.toHaveBeenCalled();
  expect(tree.root.findByType(MeasuringChange).props).toMatchObject({ before: off, after: { ...off, on: true } });
  await act(async () => { await submit(); });
  expect(propose).toHaveBeenCalledExactlyOnceWith({ ...off, on: true });
  expect(current).toEqual(off);
  expect(text()).toContain('Settings change only when the request is allowed');
  expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
});

it('keeps failed proposals editable without exposing callback errors', async () => {
  const propose = vi.fn().mockRejectedValueOnce(new Error('private transport detail')).mockResolvedValueOnce(undefined);
  await act(async () => { tree = create(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value: off }, propose })); });
  await toggle();
  await act(async () => { await submit(); });
  expect(text()).toContain('Could not request approval'); expect(text()).not.toContain('private transport detail');
  expect(tree.root.findByType('fieldset').props.disabled).toBe(false);
  await act(async () => { await submit(); });
  expect(propose).toHaveBeenCalledTimes(2);
  expect(text()).toContain('Approval requested');
});

it.each(['loading', 'offline', 'denied'] as const)('immediately removes cached settings and a draft when %s', async status => {
  const propose = vi.fn(async () => {});
  const value = { ...off, outside_address: 'https://private-monitor.example/v1/traces' };
  await act(async () => { tree = create(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value }, propose })); });
  await toggle();
  expect(text()).toContain(value.outside_address);
  await act(async () => tree.update(h(MeasuringSettingsProposal, { snapshot: { status }, propose })));
  expect(text()).not.toContain(value.outside_address);
  expect(tree.root.findAllByType('form')).toHaveLength(0);
  await act(async () => tree.update(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value }, propose })));
  expect(tree.root.findAllByType(MeasuringChange)).toHaveLength(0);
  expect(propose).not.toHaveBeenCalled();
});

it('replaces a stale draft and ignores the visible result of a superseded pending proposal', async () => {
  let resolve!: () => void;
  const propose = vi.fn(() => new Promise<void>(yes => { resolve = yes; }));
  await act(async () => { tree = create(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value: off }, propose })); });
  await toggle();
  let saving!: Promise<void>;
  await act(async () => { saving = submit(); });
  expect(text()).toContain('Requesting approval');
  const newer = { ...off, keep_days: 14 };
  await act(async () => tree.update(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value: newer }, propose })));
  await act(async () => { resolve(); await saving; });
  expect(text()).not.toContain('Approval requested');
  expect(tree.root.findAllByType(MeasuringChange)).toHaveLength(0);
  expect(tree.root.findByType('fieldset').props.disabled).toBe(false);
});

it('submits destination and retention from the preview once even for repeated submits before render', async () => {
  let resolve!: () => void;
  const propose = vi.fn(() => new Promise<void>(yes => { resolve = yes; }));
  await act(async () => { tree = create(h(MeasuringSettingsProposal, { snapshot: { status: 'live', value: off }, propose })); });
  const inputs = tree.root.findAllByType('input');
  await act(async () => {
    inputs[1].props.onChange({ target: { checked: true } });
  });
  await act(async () => inputs[2].props.onChange({ target: { value: 'https://collector.example/v1/traces' } }));
  await act(async () => inputs[3].props.onChange({ target: { valueAsNumber: 14 } }));
  const after = { ...off, send_outside: true, outside_address: 'https://collector.example/v1/traces', keep_days: 14 };
  expect(tree.root.findByType(MeasuringChange).props.after).toEqual(after);
  let first!: Promise<void>;
  await act(async () => { first = submit(); void submit(); });
  expect(propose).toHaveBeenCalledExactlyOnceWith(after);
  await act(async () => { resolve(); await first; });
  await act(async () => { await submit(); });
  expect(propose).toHaveBeenCalledTimes(1);
});
