import { describe, it, expect } from 'vitest';
import {
  initialState,
  reduce,
  type MultiSelectItem,
  type MultiSelectState,
} from './multi-select.js';

const ITEMS: ReadonlyArray<MultiSelectItem<string>> = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function s(cursor: number, selected: string[]): MultiSelectState<string> {
  return { cursor, selected: new Set(selected) };
}

describe('initialState', () => {
  it('starts with cursor 0 and provided initial selection', () => {
    const st = initialState(ITEMS, new Set(['a', 'c']));
    expect(st.cursor).toBe(0);
    expect([...st.selected].sort()).toEqual(['a', 'c']);
  });

  it('defaults selection to empty when initialSelected omitted', () => {
    const st = initialState(ITEMS);
    expect(st.selected.size).toBe(0);
  });
});

describe('reduce', () => {
  it('down moves cursor forward', () => {
    const r = reduce(s(0, []), { kind: 'down' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.cursor).toBe(1);
  });

  it('down wraps at end of list', () => {
    const r = reduce(s(2, []), { kind: 'down' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.cursor).toBe(0);
  });

  it('up wraps at top of list', () => {
    const r = reduce(s(0, []), { kind: 'up' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.cursor).toBe(2);
  });

  it('toggle adds value at cursor when absent', () => {
    const r = reduce(s(1, []), { kind: 'toggle' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.selected.has('b')).toBe(true);
  });

  it('toggle removes value at cursor when present', () => {
    const r = reduce(s(1, ['b']), { kind: 'toggle' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.selected.has('b')).toBe(false);
  });

  it('confirm returns confirmed status carrying the current selection', () => {
    const r = reduce(s(0, ['a', 'c']), { kind: 'confirm' }, ITEMS);
    expect(r.status).toBe('confirmed');
    if (r.status !== 'confirmed') throw new Error();
    expect([...r.selected].sort()).toEqual(['a', 'c']);
  });

  it('cancel returns cancelled status', () => {
    const r = reduce(s(0, ['a']), { kind: 'cancel' }, ITEMS);
    expect(r.status).toBe('cancelled');
  });

  it('toggle on an empty item list is a no-op running state', () => {
    const r = reduce(s(0, []), { kind: 'toggle' }, []);
    expect(r.status).toBe('running');
  });
});

describe('reduce (single-select mode)', () => {
  const items = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ] as const;

  it('replaces prior selection on toggle when single=true', () => {
    const s0 = initialState(items);
    const s1 = reduce(s0, { kind: 'toggle' }, items, { single: true });
    expect(s1.status).toBe('running');
    if (s1.status !== 'running') throw new Error('unreachable');
    expect([...s1.state.selected]).toEqual(['a']);

    const s2 = reduce(s1.state, { kind: 'down' }, items, { single: true });
    if (s2.status !== 'running') throw new Error('unreachable');
    const s3 = reduce(s2.state, { kind: 'toggle' }, items, { single: true });
    if (s3.status !== 'running') throw new Error('unreachable');
    expect([...s3.state.selected]).toEqual(['b']);
  });

  it('deselects on toggle of already-selected item in single mode', () => {
    const s0 = initialState(items);
    const s1 = reduce(s0, { kind: 'toggle' }, items, { single: true });
    if (s1.status !== 'running') throw new Error('unreachable');
    const s2 = reduce(s1.state, { kind: 'toggle' }, items, { single: true });
    if (s2.status !== 'running') throw new Error('unreachable');
    expect([...s2.state.selected]).toEqual([]);
  });

  it('multi-select default unchanged when opts omitted', () => {
    const s0 = initialState(items);
    const s1 = reduce(s0, { kind: 'toggle' }, items);
    if (s1.status !== 'running') throw new Error('unreachable');
    const s2 = reduce(s1.state, { kind: 'down' }, items);
    if (s2.status !== 'running') throw new Error('unreachable');
    const s3 = reduce(s2.state, { kind: 'toggle' }, items);
    if (s3.status !== 'running') throw new Error('unreachable');
    expect([...s3.state.selected].sort()).toEqual(['a', 'b']);
  });
});
