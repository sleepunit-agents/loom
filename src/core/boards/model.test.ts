import { describe, expect, it } from 'vitest';
import { bricks, catalogue } from './bricks.js';
import { boardBrief, changeSentences } from './brief.js';
import { actRow, applyChanges, designFrom, fill, live, Refused, type Board, type Change } from './model.js';

const empty = (): Board => ({ id: 'b1', title: '', revision: 1, closed: false, placements: [] });
function ids() {
  let n = 0;
  return () => 'p' + ++n;
}
const agent = (board: Board, changes: Change[], id = ids()) => applyChanges(board, changes, 'agent', id);
const names = (board: Board) => live(board).map((p) => p.brick);

describe('placing and ranking (checks 1, 3, 4, 5)', () => {
  it('makes the first placement primary and raises the revision once per call', () => {
    const id = ids();
    const one = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }], id);
    const two = agent(one.board, [{ change: 'place', brick: 'trend', params: { project: 'loom' } }], id);
    expect(live(two.board).map((p) => [p.brick, p.rank])).toEqual([['lanes', 0], ['trend', 1]]);
    expect(two.board.revision).toBe(3);
    expect(live(two.board)[1].params).toEqual({ project: 'loom', days: 30 });
  });
  it('promotes the next placement when the primary is removed', () => {
    const { board } = agent(empty(), [
      { change: 'place', brick: 'lanes', params: { project: 'loom' } },
      { change: 'place', brick: 'trend', params: { project: 'loom' } },
      { change: 'place', brick: 'ticket', params: { ticket: 't-1' } },
    ]);
    const after = agent(board, [{ change: 'remove', placement: 'p1' }]).board;
    expect(live(after).map((p) => [p.brick, p.rank])).toEqual([['trend', 0], ['ticket', 1]]);
    expect(after.placements.find((p) => p.id === 'p1')?.removed).toBe(true);
  });
  it('inserts at a rank and shifts the rest, and moves by rank', () => {
    const id = ids();
    const { board } = agent(empty(), [
      { change: 'place', brick: 'lanes', params: { project: 'loom' } },
      { change: 'place', brick: 'trend', params: { project: 'loom' } },
      { change: 'place', brick: 'ticket', params: { ticket: 't-1' } },
    ], id);
    const placed = agent(board, [{ change: 'place', brick: 'project', params: { project: 'loom' }, rank: 0 }], id);
    expect(names(placed.board)).toEqual(['project', 'lanes', 'trend', 'ticket']);
    expect(placed.rows[0]).toMatchObject({ change: 'place', to: 0 });
    const moved = agent(placed.board, [{ change: 'rank', placement: 'p3', rank: 0 }], id);
    expect(names(moved.board)).toEqual(['ticket', 'project', 'lanes', 'trend']);
    expect(moved.rows[0]).toMatchObject({ change: 'rank', from: 3, to: 0 });
    expect(() => agent(moved.board, [{ change: 'place', brick: 'agent', params: { agent: 'art' }, rank: 5 }], id)).toThrow(Refused);
    expect(() => agent(moved.board, [{ change: 'rank', placement: 'p3', rank: 4 }], id)).toThrow(Refused);
  });
  it('stores nothing when any change in the call is refused', () => {
    const board = empty();
    expect(() => agent(board, [
      { change: 'place', brick: 'lanes', params: { project: 'loom' } },
      { change: 'place', brick: 'nonesuch' },
    ])).toThrow(/no brick named/);
    expect(board).toEqual(empty());
  });
  it('refuses bad params, a missing record reference and a duplicate after defaults', () => {
    const { board } = agent(empty(), [{ change: 'place', brick: 'trend', params: { project: 'loom', days: 30 } }]);
    expect(() => agent(board, [{ change: 'place', brick: 'trend', params: { project: 'loom' } }])).toThrow(/already on the board/);
    expect(() => agent(board, [{ change: 'place', brick: 'trend' }])).toThrow(Refused);
    expect(() => agent(board, [{ change: 'place', brick: 'trend', params: { project: 'loom', days: 14 } }])).toThrow(Refused);
    expect(() => agent(board, [{ change: 'place', brick: 'ticket', params: { ticket: 'loom' } }])).toThrow(Refused);
    expect(() => agent(board, [{ change: 'place', brick: 'ticket', params: { ticket: 't-1', extra: 1 } }])).toThrow(Refused);
    // A well-formed id that names nothing is accepted: the read decides what it shows.
    expect(names(agent(board, [{ change: 'place', brick: 'ticket', params: { ticket: 't-999999' } }]).board)).toContain('ticket');
  });
  it('titles within the limit and records old and new', () => {
    const { board, rows } = agent(empty(), [{ change: 'title', title: 'Loom lately' }]);
    expect(board.title).toBe('Loom lately');
    expect(rows[0]).toMatchObject({ change: 'title', from: '', to: 'Loom lately' });
    expect(() => agent(board, [{ change: 'title', title: 'x'.repeat(81) }])).toThrow(Refused);
  });
  it('refuses any change on a closed board', () => {
    expect(() => agent({ ...empty(), closed: true }, [{ change: 'title', title: 'x' }])).toThrow(/closed/);
  });
});

describe("the member's hand (check 6)", () => {
  const member = (board: Board, changes: Change[]) => applyChanges(board, changes, 'member', ids());
  it('places last and removes, and nothing else', () => {
    const { board } = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }]);
    const placed = applyChanges(board, [{ change: 'place', brick: 'person', params: { person: 'member:jonathan' } }], 'member', () => 'm1');
    expect(live(placed.board).at(-1)).toMatchObject({ brick: 'person', rank: 1, placedByKind: 'member' });
    expect(() => member(board, [{ change: 'place', brick: 'agent', params: { agent: 'art' }, rank: 0 }])).toThrow(Refused);
    expect(() => member(board, [{ change: 'rank', placement: 'p1', rank: 0 }])).toThrow(Refused);
    expect(() => member(board, [{ change: 'title', title: 'mine' }])).toThrow(Refused);
  });
});

describe('what the agent is told (checks 9, 11, 12)', () => {
  const { board } = agent(empty(), [
    { change: 'place', brick: 'lanes', params: { project: 'loom' } },
    { change: 'place', brick: 'trend', params: { project: 'loom' } },
    { change: 'place', brick: 'ticket', params: { ticket: 't-2441' } },
  ]);
  it('names a removed placement by brick and params, and the board and placements by id', () => {
    const removed = applyChanges(board, [{ change: 'remove', placement: 'p2' }], 'member', ids());
    const text = boardBrief(removed.board, [{ board: removed.board, unseen: removed.rows }]);
    expect(text).toContain('Board b1');
    expect(text).toContain('lanes(project=loom) [placement p1] (primary)');
    expect(text).toContain('The member removed trend(days=30, project=loom) from board b1.');
    expect(text).not.toContain('1. trend');
    expect(boardBrief(removed.board, [{ board: removed.board, unseen: [] }])).not.toContain('Since you last looked');
  });
  it('says nothing of what the agent itself did', () => {
    const own = agent(board, [{ change: 'remove', placement: 'p2' }]);
    expect(changeSentences(own.board, own.rows)).toEqual([]);
  });
  it('tells an action with its detail, and a comment with none', () => {
    const row = actRow(board, 'p3', 'set status', { status: 'closed' });
    expect(row.revision).toBe(board.revision + 1);
    expect(changeSentences(board, [row])).toEqual(['The member used set status on ticket(ticket=t-2441) on board b1: status=closed.']);
    const commented = agent(board, [{ change: 'place', brick: 'comments', params: { ticket: 't-2441' } }], () => 'p4');
    expect(changeSentences(commented.board, [actRow(commented.board, 'p4', 'comment', {})]))
      .toEqual(['The member used comment on comments(ticket=t-2441) on board b1.']);
    expect(() => actRow(board, 'p3', 'delete', {})).toThrow(Refused);
    expect(() => actRow(board, 'p3', 'set status', { status: 'gone' })).toThrow(Refused);
    expect(() => actRow(board, 'p3', 'set status', { status: 'closed', words: 'x' })).toThrow(Refused);
    expect(() => actRow({ ...board, closed: true }, 'p3', 'set status', { status: 'closed' })).toThrow(Refused);
  });
  it('says so when no board is open, and names another board in its sentences', () => {
    expect(boardBrief(null, [])).toBe('No board is open in this thread.');
    const other: Board = { ...empty(), id: 'b2' };
    const text = boardBrief(board, [{ board: other, unseen: [{ revision: 2, seq: 0, actorKind: 'member', change: 'close' }] }]);
    expect(text).toContain('The member closed board b2.');
  });
});

describe('blueprints (checks 14, 15)', () => {
  const { board } = agent(empty(), [
    { change: 'place', brick: 'lanes', params: { project: 'loom' } },
    { change: 'place', brick: 'trend', params: { project: 'loom' } },
    { change: 'place', brick: 'ticket', params: { ticket: 't-1' } },
  ]);
  const keep = [
    { placement: 'p1', open: { project: 'project' } },
    { placement: 'p2', open: { project: 'project' } },
  ];
  it('keeps the named placements and opens their record references', () => {
    const design = designFrom(board, keep);
    expect(design.parameters).toEqual([{ name: 'project', kind: 'project' }]);
    expect(design.design).toEqual([
      { brick: 'lanes', params: { project: { open: 'project' } } },
      { brick: 'trend', params: { project: { open: 'project' }, days: 30 } },
    ]);
  });
  it('refuses opening a choice, mixing kinds under one name, and two entries that are the same', () => {
    expect(() => designFrom(board, [{ placement: 'p2', open: { days: 'days' } }])).toThrow(/cannot be left open/);
    expect(() => designFrom(board, [{ placement: 'p1', open: { project: 'x' } }, { placement: 'p3', open: { ticket: 'x' } }])).toThrow(Refused);
    const two = agent(board, [{ change: 'place', brick: 'lanes', params: { project: 'pond' } }], () => 'p4').board;
    expect(() => designFrom(two, [{ placement: 'p1', open: { project: 'project' } }, { placement: 'p4', open: { project: 'project' } }])).toThrow(/same brick/);
  });
  it('fills every parameter and nothing else', () => {
    const design = designFrom(board, keep);
    expect(fill(design, { project: 'pond' })).toEqual([
      { brick: 'lanes', params: { project: 'pond' } },
      { brick: 'trend', params: { project: 'pond', days: 30 } },
    ]);
    expect(() => fill(design, {})).toThrow(/needs project/);
    expect(() => fill(design, { project: 'pond', ticket: 't-1' })).toThrow(/no parameter ticket/);
  });
  it('refuses arguments that make two placements the same', () => {
    const two = agent(board, [{ change: 'place', brick: 'lanes', params: { project: 'pond' } }], () => 'p4').board;
    const design = designFrom(two, [{ placement: 'p1' }, { placement: 'p4', open: { project: 'project' } }]);
    expect(() => fill(design, { project: 'loom' })).toThrow(/would be the same/);
  });
});

describe('the catalogue (check 20)', () => {
  it('lists every brick with a schema, and every non-reference parameter has a default', () => {
    expect(catalogue().map((b) => b.name)).toEqual(
      ['project', 'lanes', 'trend', 'ticket', 'comments', 'pull', 'repository', 'person', 'agent', 'question', 'approval']);
    for (const b of bricks) {
      const required = (catalogue().find((c) => c.name === b.name)!.params as { required?: string[] }).required ?? [];
      for (const name of required) expect(b.references, `${b.name}.${name}`).toHaveProperty(name);
      if (b.linkKey) expect(b.references).toHaveProperty(b.linkKey);
    }
  });
});
