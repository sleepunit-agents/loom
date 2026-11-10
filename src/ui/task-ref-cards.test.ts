import { describe, it, expect } from 'vitest';
import { taskCardsOf } from '../../web/src/task-ref-cards';
import type { RefCard } from '../../web/src/comms-refs';

describe('task chips read shared records after admission', () => {
  const card: RefCard = { kind: 'task', title: 'Old', status: 'Blocked', tone: 'bad', page: 'p/tasks/task/t-1' };
  const cards = new Map<string, RefCard | null>([['t-1', card], ['t-2', null]]);
  const records = (status: string, blocked = false) => new Map([
    ['tasks/task/t-1', { key: 'tasks/task/t-1', title: 'New', status, blocked }],
    ['tasks/task/t-2', { key: 'tasks/task/t-2', title: 'Never admitted', status }],
  ]);

  it('updates title and state, clears old tone and keeps the admitted destination', () => {
    expect(taskCardsOf(cards, records('in_progress')).get('t-1')).toEqual({ kind: 'task', title: 'New', status: 'In progress', page: card.page });
    expect(taskCardsOf(cards, records('closed')).get('t-1')).toEqual({ ...card, title: 'New', status: 'Closed', tone: 'ok' });
    expect(taskCardsOf(cards, records('open', true)).get('t-1')?.status).toBe('Blocked');
    expect(card.title).toBe('Old');
  });

  it('never admits a refused or unknown ref from collection records alone', () => {
    const got = taskCardsOf(cards, records('open'));
    expect(got.get('t-2')).toBeNull();
    expect(got.size).toBe(cards.size);
  });

  it('leaves missing historical records and malformed records alone', () => {
    expect(taskCardsOf(cards, new Map())).toBe(cards);
    expect(taskCardsOf(cards, records('unexpected'))).toBe(cards);
    const other = new Map<string, RefCard | null>([['t-1', { ...card, kind: 'note' }]]);
    expect(taskCardsOf(other, records('closed'))).toBe(other);
    const otherPiece = new Map<string, RefCard | null>([['t-1', { ...card, page: 'p/other/task/t-1' }]]);
    expect(taskCardsOf(otherPiece, records('closed'))).toBe(otherPiece);
  });
});
