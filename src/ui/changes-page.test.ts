import { describe, it, expect } from 'vitest';
import { parsePage } from './vocab.js';
const page = { title: 'Changes', sections: [], changes: { groups: [{ id: 'you', label: 'Waiting on you' }], rows: [{ id: 'c/github/acme/loom/1', group: 'you', title: 'Fix it', repo: 'acme/loom', number: '1', author: 'Art', ago: '1 hour ago', status: 'Green' }], selected: 'c/github/acme/loom/1', reader: { title: 'loom#1', sections: [{ id: 'state', blocks: [{ type: 'buttons', items: [{ action: 'yes', label: 'Yes, merge it', fields: { head: 'a'.repeat(40) } }] }] }] } } };
describe('Changes page boundary', () => {
  it('retains the reader’s existing action and commit fields', () => {
    expect(parsePage(page)).toMatchObject(page);
  });
  it('refuses unsafe paths, excessive rows and nested readers', () => {
    for (const changes of [
      { ...page.changes, selected: '../escape' },
      { ...page.changes, rows: Array(501).fill(page.changes.rows[0]) },
      { ...page.changes, reader: page },
      { ...page.changes, rows: [{ ...page.changes.rows[0], id: 'javascript:alert(1)' }] },
    ]) expect(typeof parsePage({ ...page, changes })).toBe('string');
  });
});
