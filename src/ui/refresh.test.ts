import { describe, expect, it } from 'vitest';
import { refreshEvery } from '../../web/src/refresh';

// Jonathan, 2026-11-02, a box's model login: "the result of I came back and gave you a token should spin and go hey
// look it worked". The runtime's sign-in page sets refresh: 2 while the box checks the code; with the live stream
// open the app waited 60 seconds anyway, since the stream only says a piece's manifest moved, never its page.
describe('how often the app fetches an open page again', () => {
  const form = { type: 'form', action: 'a', submit: 'Go', fields: [] };
  const page = (refresh?: number, blocks: unknown[] = []) => ({ view: 'page', page: { title: 'T', sections: [{ id: 's', blocks }], ...(refresh ? { refresh } : {}) } });

  it('a page that asked for a refresh gets it as asked, with the live stream open or not', () => {
    expect(refreshEvery(page(2), true)).toBe(2);
    expect(refreshEvery(page(2), false)).toBe(2);
    expect(refreshEvery(page(5, [form]), true)).toBe(5);
  });

  it('otherwise a page without a form is a slow fallback: 20 seconds, or 60 while live', () => {
    expect(refreshEvery(page(), false)).toBe(20);
    expect(refreshEvery(page(), true)).toBe(60);
    expect(refreshEvery({ view: 'dashboard' }, true)).toBe(60);
  });

  it('a page with a form, a sheet, or nothing shown: never on its own', () => {
    expect(refreshEvery(page(undefined, [form]), false)).toBe(0);
    expect(refreshEvery({ view: 'sheet' }, false)).toBe(0);
    expect(refreshEvery(null, false)).toBe(0);
  });
});
