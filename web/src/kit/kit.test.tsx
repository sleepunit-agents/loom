/** The kit's own rules, read from its markup: what a list's head carries, when a pager shows, what a reader is made of. */
import { expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Actions, Button, Empty, Fact, Facts, Meta, Pager, Reader, Row, Search, Section, Split, Title } from './index';

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
