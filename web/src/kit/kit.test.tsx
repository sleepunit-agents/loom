/** The kit's own rules, read from its markup: what a list's head carries, when a pager shows, what a reader is made of. */
import { expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Actions, Button, Clamp, Disclosure, Empty, Fact, Facts, Field, Fields, Head, Menu, Meta, Pager, Reader, RefCard, Row, Search, Section, Split, Title } from './index';
import { displayName } from './words';

const draw = renderToStaticMarkup;
const split = (extra: object = {}) => draw(h(Split, { label: 'Tasks', folders: [{ id: 'open', label: 'Open', count: 3 }], folder: 'open', onFolder() {}, listTitle: 'Open', list: null, reader: null, open: false, onBack() {}, backLabel: 'Back', ...extra }));

it('shows a pager only when there is another page', () => {
  const pager = (hasPrevious: boolean, hasNext: boolean) => draw(h(Pager, { label: 'Pages', hasPrevious, hasNext, previous() {}, next() {} }));
  expect(pager(false, false)).toBe('');
  expect(pager(false, true)).toMatch(/<nav class="loom-kit-pager" aria-label="Pages">.*Previous page.*Next page/);
  expect(pager(true, false).match(/disabled=""/g)).toHaveLength(1);
});
it('puts the count beside the list title and the one list action at the right, and pads what sits over the rows', () => {
  expect(split()).toContain('<header class="loom-split__list-head"><h2>Open</h2></header>');
  expect(split()).not.toContain('loom-split__list-top');
  const html = split({ listCount: 3, listAction: h(Button, null, 'Create task'), listTop: h('p', null, 'Today') });
  expect(html).toMatch(/<h2>Open<\/h2><span class="loom-split__list-count">3<\/span><span class="loom-split__list-action"><button/);
  expect(html).toContain('<div class="loom-split__list-top"><p>Today</p></div>');
  expect(split({ listTop: h('div', null) })).toContain('loom-split__list-top');
  expect(split({ listTop: false })).not.toContain('loom-split__list-top');
});
it('names a search field by its label and shows the words as its placeholder', () => {
  expect(draw(h(Search, { label: 'Search asks', value: '', onChange() {} }))).toBe('<label class="loom-kit-search"><input type="search" aria-label="Search asks" placeholder="Search asks" autoComplete="off" value=""/></label>');
});
it('builds a reader from a meta line, a title, labelled facts and ruled sections, and leaves out a fact with no value', () => {
  const html = draw(h(Reader, { 'aria-label': 'Item' }, h(Meta, null, 'Art · open'), h(Title, null, 'Buy it?'),
    h(Facts, null, h(Fact, { label: 'Why' }, 'In stock'), h(Fact, { label: 'If no' }, null)), h(Section, { label: 'Record your answer' }, h(Actions, null, h(Button, { variant: 'primary' }, 'Yes')))));
  expect(html).toContain('<p class="loom-reader__meta ">Art · open</p><h2 class="loom-reader__title ">Buy it?</h2>');
  expect(html).toContain('<dl class="loom-reader__facts "><dt class="loom-reader__label">Why</dt><dd>In stock</dd></dl>');
  expect(html).toContain('<section aria-label="Record your answer" class="loom-reader__section "><h3 class="loom-reader__label">Record your answer</h3><div class="loom-kit-actions ">');
});
it('says an empty state in plain lines and a row\'s status in plain text', () => {
  expect(draw(h(Empty, { title: 'No items here', text: 'New ones arrive on their own.' }))).toBe('<div class="loom-kit-empty" data-slot="empty"><p class="loom-kit-empty__title">No items here</p><p class="loom-kit-empty__text">New ones arrive on their own.</p></div>');
  expect(draw(h(Row, { title: 'A', status: 'Art · open' }))).toContain('<span class="loom-kit-status">Art · open</span>');
});
it('keeps shared row labels, metadata and folder names readable at their full height', () => {
  const inbox = readFileSync(new URL('../pieces/inbox-view/index.tsx', import.meta.url), 'utf8');
  expect(inbox).not.toMatch(/loom-kit-title[^'"]*line-clamp/);
  const sheets = ['./app.css', './split.css', '../pieces/attention/rail.css', '../pieces/comms-view/comms.css'];
  for (const file of sheets) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    const rules = css.match(/[^{}]*(?:loom-kit-title|loom-kit-meta|loom-split__folder-name|loom-split__title)[^{}]*\{[^{}]*\}/g) ?? [];
    for (const rule of rules) expect(rule).not.toMatch(/line-clamp|text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  }
});
it('keeps the page-wide control rules to the tile page, compact at a desk and a full target on the phone', () => {
  const css = readFileSync(new URL('./controls.css', import.meta.url), 'utf8'), rows = readFileSync(new URL('./split.css', import.meta.url), 'utf8'), app = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
  // Every rule that restyles a library control is scoped to an app's page, so sign-in, the launcher, the dock and the bar keep theirs.
  for (const selector of css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]*(?:\.v-btn|\.v-input|\.v-textarea|:where\((?:select|textarea|input|label|fieldset))[^{}]*(?=\{)/g) ?? []) expect(selector, selector).toContain('.next-page');
  expect(css).toMatch(/\[data-shell="phone"\] \.next-page \{ --kit-ctl: 40px; --kit-field: 40px; \}/);
  expect(css).toMatch(/\.next-page \{[^}]*--kit-ctl: 28px/);
  // The open row is a bar on its left edge; a ring is keyboard focus alone.
  expect(rows).toMatch(/\[data-split-row\]\[aria-current="true"\] \{[^}]*box-shadow: inset 3px 0 0 var\(--sp-tint\)/);
  expect(rows).toMatch(/\[data-split-row\]:focus-visible[^{]*\{\s*outline: 2px solid/);
  expect(app).not.toMatch(/\.loom-kit-status \{[^}]*border:/);
  // Every Split fills its tile page and scrolls pane by pane without its app asking.
  expect(rows).toMatch(/\.next-page > \.loom-split \{ height: 100%/);
});
it('opening an item leaves the rows mounted and where they were scrolled; only another list starts from its top', async () => {
  const { act, create } = await import('react-test-renderer' as string) as { act(run: () => Promise<void>): Promise<void>; create(node: unknown, options: object): { update(node: unknown): void; unmount(): void; root: { findByProps(props: object): { props: Record<string, unknown> } } } };
  const { useEffect } = await import('react');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const had = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  let mounts = 0; const scrolls: string[] = [];
  const RowProbe = ({ current }: { current: boolean }) => { useEffect(() => { mounts++; }, []); return h('button', { 'data-split-row': '', 'aria-current': current ? 'true' : undefined }, 'Row'); };
  const node = (element: { props: { className?: string } }) => ({ getBoundingClientRect: () => ({ width: 1000 }), closest: () => null, querySelectorAll: () => [], focus() {},
    scrollTo: () => scrolls.push(String(element.props.className)), parentElement: { scrollTo: () => scrolls.push('pane') } });
  const draw = (extra: object) => h(Split, { label: 'Inbox', folders: [{ id: 'needs', label: 'Needs you', count: 2 }], folder: 'needs', onFolder() {}, listTitle: 'Needs you', onBack() {}, backLabel: 'Back',
    list: h(RowProbe, { current: false }), reader: null, open: false, listKey: 'needs|0', ...extra });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(draw({}), { createNodeMock: node }); });
    scrolls.length = 0;
    // Open an item, let its reader load, then show it: the rows are the same rows and nothing scrolls them.
    for (const reader of [h('p', null, 'Loading…'), h('article', null, 'The item')]) await act(async () => { tree.update(draw({ open: true, reader, list: h(RowProbe, { current: true }) })); });
    expect(mounts).toBe(1); expect(scrolls).toEqual([]);
    expect(tree.root.findByProps({ className: 'loom-split__rows' }).props['aria-busy']).toBeUndefined();
    await act(async () => { tree.update(draw({ listKey: 'needs|50', listBusy: true })); });
    expect(mounts).toBe(1); expect(scrolls).toEqual(['loom-split__rows', 'pane']);
    expect(tree.root.findByProps({ className: 'loom-split__rows' }).props['aria-busy']).toBe(true);
    await act(async () => tree.unmount());
  } finally { globalThis.ResizeObserver = had; }
});
it('heads an item that scrolls under it: something small at the left, the title over its quiet line, the actions at the right', () => {
  const html = draw(h(Head, { leading: h('i', null), actions: h(Actions, null, h(Button, null, 'More')) }, h(Title, null, 'Pond pump'), h(Meta, null, 'with Art')));
  expect(html).toMatch(/^<header class="loom-reader__head "><i><\/i><div class="loom-reader__head-words"><h2 class="loom-reader__title ">Pond pump<\/h2><p class="loom-reader__meta ">with Art<\/p><\/div><div class="loom-kit-actions "><button/);
  expect(draw(h(Head, null, h(Title, null, 'Bare')))).toBe('<header class="loom-reader__head "><div class="loom-reader__head-words"><h2 class="loom-reader__title ">Bare</h2></div></header>');
});

it('draws a form field as its words over its control with the hint outside the label, and a closed section as a button', () => {
  // The hint is beside the label, not in it, so the control's name is its label alone.
  expect(draw(h(Field, { label: 'Reason', hint: 'One word.' }, h('textarea')))).toBe('<div class="loom-kit-field"><label><span class="loom-kit-field__label">Reason</span><textarea></textarea></label><p class="loom-kit-field__hint">One word.</p></div>');
  expect(draw(h(Fields, { disabled: true }))).toBe('<fieldset disabled="" class="loom-kit-fields "></fieldset>');
  const closed = draw(h(Disclosure, { label: 'Details' }, 'facts'));
  expect(closed).toMatch(/^<section aria-label="Details" class="loom-reader__section"><h3 class="loom-reader__label"><button type="button" class="loom-reader__toggle" aria-expanded="false">Details<\/button><\/h3><\/section>$/);
  expect(draw(h(Disclosure, { label: 'Details', defaultOpen: true }, 'facts'))).toContain('class="loom-reader__more">facts</div>');
});
it('clamps only what is long, cards a reference, keeps a menu closed until asked, and names a person without a kind word', () => {
  expect(draw(h(Clamp, { long: false }, 'short'))).toBe('short');
  expect(draw(h(Clamp, { long: true }, 'long'))).toBe('<div class="loom-reader__clamp">long</div><button type="button" aria-expanded="false" class="loom-kit-link ">Show all</button>');
  expect(draw(h(RefCard, { label: 'Pull request a/b#1', note: 'Made here' }, 'card'))).toBe('<div class="loom-kit-refc" role="group" aria-label="Pull request a/b#1"><p class="loom-kit-refc__note">Made here</p>card</div>');
  const menu = draw(h(Menu, { label: 'More', name: 'More for this task', children: () => h('i') }));
  expect(menu).toMatch(/^<span class="loom-kit-menu"><button[^>]*aria-label="More for this task"[^>]*aria-expanded="false"[^>]*>More<\/button><\/span>$/);
  expect(displayName('art', { art: 'Art the agent' })).toBe('Art the agent'); expect(displayName('jonathan')).toBe('Jonathan'); expect(displayName(null)).toBe('');
});
