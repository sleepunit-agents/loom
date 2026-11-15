import { afterEach, expect, it } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error The existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import { MeasuringChange, type MeasuringSettings } from './settings';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const off: MeasuringSettings = { on: false, send_outside: false, outside_address: '', keep_days: 90 };
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const text = () => JSON.stringify(tree.toJSON());
it('shows every persisted before/after value, including settings retained while off', async () => {
  const after = { on: true, send_outside: true, outside_address: 'https://monitor.example/v1/traces', keep_days: 7 };
  await act(async () => { tree = create(h(MeasuringChange, { before: off, after })); });
  expect(text()).toContain('Before'); expect(text()).toContain('After');
  expect(text()).toContain('Off'); expect(text()).toContain('On');
  expect(text()).toContain('Do not send measurements'); expect(text()).toContain('Send measurements');
  expect(text()).toContain('None'); expect(text()).toContain(after.outside_address);
  expect(text()).toContain('90'); expect(text()).toContain('7');
});
