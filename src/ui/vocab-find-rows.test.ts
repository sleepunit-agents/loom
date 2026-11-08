// Two small additions for a list you scan and narrow (Jonathan's Tasks mock, t-1925): a list row that opens in place
// (`more`), and a filters block whose sort is one switch with rows of chips under it (`switch`, `chips`).
// docs/extensions.md, "Blocks".
import { describe, it, expect } from 'vitest';
import { LIMITS, parsePage, type Page } from './vocab.js';

const page = (b: Record<string, unknown>) => parsePage({ title: 'T', sections: [{ id: 's', blocks: [b] }] });
const blockOf = (r: Page | string) => (typeof r === 'string' ? r : r.sections[0].blocks[0]);

describe('a list row that opens in place', () => {
  const row = (more: unknown) => page({ type: 'list', items: [{ text: 'Fix it', page: 'task/t-1', more }] });

  it('keeps its label and value pairs and what its link is called', () => {
    const b = blockOf(row({ items: [{ label: 'Goal', value: 'It works' }, { label: 'Why', value: 'It broke' }], open: 'Open task' }));
    expect(b).toMatchObject({ type: 'list', items: [{ text: 'Fix it', page: 'task/t-1', more: { items: [{ label: 'Goal', value: 'It works' }, { label: 'Why', value: 'It broke' }], open: 'Open task' } }] });
  });

  it('takes up to 6 pairs, and a row with no link may still say what it would open', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: 'v' }));
    expect(blockOf(row({ items: six }))).toMatchObject({ items: [{ more: { items: six } }] });
  });

  it('a row without more is as it was', () => {
    const b = blockOf(page({ type: 'list', items: [{ text: 'Fix it', page: 'task/t-1' }] })) as { items: object[] };
    expect(b.items[0]).not.toHaveProperty('more');
  });

  it('refuses an empty more, too many pairs, or a pair that isn\'t words', () => {
    expect(row({ items: [] })).toMatch(/list\.more needs an item/);
    expect(row({ items: Array.from({ length: 7 }, (_, i) => ({ label: `L${i}`, value: 'v' })) })).toMatch(/list\.more\.items/);
    expect(row({ items: [{ label: 'Goal', value: { x: 1 } }] })).toMatch(/list\.more\.value/);
    expect(row('Goal: it works')).toMatch(/list\.more/);
  });
});

describe('a filters block with a switch and chips', () => {
  const sort = [{ value: '', label: 'Priority' }, { value: 'new', label: 'Newest' }, { value: 'updated', label: 'Updated' }];
  const status = { param: 'show', label: 'Status', options: [{ value: 'yours', label: 'Needs you' }, { value: 'doing', label: 'In progress' }] };

  it('keeps the switch and the chip rows', () => {
    const b = blockOf(page({ type: 'filters', param: 'sort', search: 'Find a task', switch: true, options: sort, chips: [status] }));
    expect(b).toMatchObject({ type: 'filters', param: 'sort', switch: true, chips: [status] });
  });

  it('a plain filters block is as it was', () => {
    const b = blockOf(page({ type: 'filters', param: 'sort', options: sort }));
    expect(b).not.toHaveProperty('switch');
    expect(b).not.toHaveProperty('chips');
  });

  it('a switch is 2 to 4 options', () => {
    for (const n of [2, 4]) {
      const options = Array.from({ length: n }, (_, i) => ({ value: i ? `o${i}` : '', label: `O${i}` }));
      expect(blockOf(page({ type: 'filters', param: 'sort', switch: true, options }))).toMatchObject({ switch: true });
    }
    expect(page({ type: 'filters', param: 'sort', switch: true, options: sort.slice(0, 1) })).toMatch(/2 to 4/);
    expect(page({ type: 'filters', param: 'sort', switch: true, options: [...sort, ...sort.map((o) => ({ ...o, value: `${o.value}x` }))] })).toMatch(/2 to 4/);
    expect(page({ type: 'filters', param: 'sort', switch: 'yes', options: sort })).toMatch(/switch must be true or false/);
  });

  it('a chip row has its own query key, distinct values with no comma, and at least one chip', () => {
    const f = (chips: unknown) => page({ type: 'filters', param: 'sort', options: sort, chips });
    expect(f([{ ...status, param: 'sort' }])).toMatch(/query key of its own/);
    expect(f([{ ...status, param: 'q' }])).toMatch(/query key of its own/);
    expect(f([status, status])).toMatch(/query key of its own/);
    expect(f([{ ...status, param: 'Show' }])).toMatch(/query key/);
    expect(f([{ ...status, options: [{ value: 'a,b', label: 'A' }] }])).toMatch(/no comma/);
    expect(f([{ ...status, options: [{ value: '', label: 'All' }] }])).toMatch(/no comma/);
    expect(f([{ ...status, options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }])).toMatch(/distinct/);
    expect(f([{ ...status, options: [] }])).toMatch(/needs a chip/);
    expect(f([status, { ...status, param: 'b' }, { ...status, param: 'c' }, { ...status, param: 'd' }])).toMatch(/filters\.chips/);
  });

  it('a chip value is at most 15 characters, so a full row of them, all on, fits in one query value', () => {
    const f = (value: string) => page({ type: 'filters', param: 'sort', options: sort, chips: [{ param: 'tag', label: 'Tag', options: [{ value, label: 'V' }] }] });
    expect(f('x'.repeat(16))).toMatch(/1 to 15 characters/);
    expect(blockOf(f('x'.repeat(15)))).toMatchObject({ chips: [{ options: [{ value: 'x'.repeat(15) }] }] });
    // Twelve of the longest, joined as a click on every one would send them, against the query value limit.
    const options = Array.from({ length: 12 }, (_, i) => ({ value: `chip-value-${String(i).padStart(4, '0')}`, label: `C${i}` }));
    const b = blockOf(page({ type: 'filters', param: 'sort', options: sort, chips: [{ param: 'tag', label: 'Tag', options }] })) as { chips: Array<{ options: Array<{ value: string }> }> };
    expect(b.chips[0].options.map((o) => o.value).join(',').length).toBeLessThanOrEqual(LIMITS.queryValue);
    expect(page({ type: 'filters', param: 'sort', options: sort, chips: [{ param: 'tag', label: 'Tag', options: [...options, { value: 'one-more', label: 'M' }] }] })).toMatch(/chips\.options/);
  });
});
