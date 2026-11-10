import { it, expect } from 'vitest';
import { parsePage, type Page } from './vocab.js';

it('keeps an item ref on approval panel and list rows, even when neither has a page link', () => {
  const page = parsePage({ title: 'Approvals', sections: [{ id: 'waiting', blocks: [
    { type: 'panel', rows: [{ label: 'Allow this?', ref: 'a-deadbeef', sheet: { blocks: [{ type: 'text', text: 'Why' }] } }] },
    { type: 'list', items: [{ text: 'Answered', ref: 'a-deadbeef' }] },
  ] }] }) as Page;
  expect(page.sections[0].blocks).toMatchObject([
    { rows: [{ ref: 'a-deadbeef' }] }, { items: [{ ref: 'a-deadbeef' }] },
  ]);
});
