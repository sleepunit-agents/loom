import { describe, expect, it } from 'vitest';
import { bricks, catalogue } from './bricks.js';
import { boardBrief, changeSentences } from './brief.js';
import { actRow, applyChanges, bigOf, designFrom, fill, live, Refused, type Board, type Change } from './model.js';

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
    expect(text).toContain('lanes(project=loom) [placement p1] (big)');
    expect(text).toContain('The member removed trend(days=30, project=loom) from board b1.');
    expect(text).not.toContain('1. trend');
    expect(boardBrief(removed.board, [{ board: removed.board, unseen: [] }])).not.toContain('Since you last looked');
  });
  it('says nothing of what the agent itself did', () => {
    const own = agent(board, [{ change: 'remove', placement: 'p2' }]);
    expect(changeSentences(own.board, own.rows)).toEqual([]);
  });
  it('tells an action, and refuses one the brick does not have or a detail it does not declare', () => {
    const row = actRow(board, 'p3', 'close', {});
    expect(row.revision).toBe(board.revision + 1);
    expect(changeSentences(board, [row])).toEqual(['The member used close on ticket(ticket=t-2441) on board b1.']);
    // A detail, where an action declares one, is told after a colon.
    expect(changeSentences(board, [{ ...row, detail: { answer: 'yes' } }])).toEqual(['The member used close on ticket(ticket=t-2441) on board b1: answer=yes.']);
    // A question is answered by inbox.answer; the board is told which of its fixed answers was chosen, never words.
    const asked = agent(board, [{ change: 'place', brick: 'question', params: { item: 'i-1' } }], () => 'p5');
    for (const answer of ['yes', 'no', 'words', 'done', 'dismiss']) expect(actRow(asked.board, 'p5', 'answer', { answer }).detail).toEqual({ answer });
    expect(changeSentences(asked.board, [actRow(asked.board, 'p5', 'answer', { answer: 'no' })]))
      .toEqual(['The member used answer on question(item=i-1) on board b1: answer=no.']);
    for (const detail of [{}, { choice: 'yes' }, { answer: 'replied' }, { answer: 'Yes, and wire the money' }, { answer: 'words', words: 'what I typed' }])
      expect(() => actRow(asked.board, 'p5', 'answer', detail), JSON.stringify(detail)).toThrow(Refused);
    // An approval and a pull request are not answered from a board: they have no action to report.
    const waiting = agent(board, [{ change: 'place', brick: 'approval', params: { approval: 'a-1' } }, { change: 'place', brick: 'pull', params: { change: 'github:acme/app#12' } }], (() => { let n = 5; return () => 'p' + ++n; })());
    for (const [placement, action] of [['p6', 'approve'], ['p6', 'refuse'], ['p6', 'allow'], ['p6', 'answer'], ['p7', 'answer'], ['p7', 'merge']])
      expect(() => actRow(waiting.board, placement, action, {}), action).toThrow(Refused);
    const commented = agent(board, [{ change: 'place', brick: 'comments', params: { ticket: 't-2441' } }], () => 'p4');
    expect(changeSentences(commented.board, [actRow(commented.board, 'p4', 'comment', {})]))
      .toEqual(['The member used comment on comments(ticket=t-2441) on board b1.']);
    expect(() => actRow(board, 'p3', 'delete', {})).toThrow(Refused);
    expect(() => actRow(board, 'p3', 'close', { reason: 'secret words' })).toThrow(Refused);
    expect(() => actRow({ ...board, closed: true }, 'p3', 'close', {})).toThrow(Refused);
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
      ['project', 'lanes', 'trend', 'ticket', 'comments', 'pull', 'repository', 'person', 'agent', 'question', 'approval', 'session']);
    for (const b of bricks) {
      const required = (catalogue().find((c) => c.name === b.name)!.params as { required?: string[] }).required ?? [];
      for (const name of required) expect(b.references, `${b.name}.${name}`).toHaveProperty(name);
      if (b.linkKey) expect(b.references).toHaveProperty(b.linkKey);
    }
  });
  it('declares only the actions the page calls, each with a detail of fixed choices', () => {
    const actions = Object.fromEntries(catalogue().map((b) => [b.name, b.actions]));
    expect(Object.fromEntries(Object.entries(actions).map(([name, a]) => [name, Object.keys(a)]))).toEqual({
      project: [], lanes: [], trend: [], ticket: ['claim', 'unclaim', 'close', 'reopen'], comments: ['comment'], pull: [], repository: [],
      person: [], agent: [], question: ['answer'], approval: [], session: ['stop'] });
    expect(actions.question.answer).toMatchObject({ type: 'object', required: ['answer'], additionalProperties: false,
      properties: { answer: { enum: ['yes', 'no', 'words', 'done', 'dismiss'] } } });
    expect(bricks.find((b) => b.name === 'question')!.actions.answer.operation).toBe('inbox.answer');
    // No action's detail can hold a sentence: every property of every detail is a fixed list.
    for (const brick of catalogue()) for (const detail of Object.values(brick.actions) as { properties?: Record<string, { enum?: unknown[] }> }[])
      for (const property of Object.values(detail.properties ?? {})) expect(property.enum, brick.name).toBeInstanceOf(Array);
  });
});

describe('big and small, and flags (checks 24 to 27)', () => {
  const three = () => agent(empty(), [
    { change: 'place', brick: 'lanes', params: { project: 'loom' } },
    { change: 'place', brick: 'agent', params: { agent: 'art' } },
    { change: 'place', brick: 'ticket', params: { ticket: 't-1' } },
  ]).board;
  it('puts the maximized placement in the big one\'s place, and the old big one first among the small', () => {
    const next = applyChanges(three(), [{ change: 'maximize', placement: 'p3' }], 'member', ids());
    expect(live(next.board).map((p) => [p.brick, p.rank])).toEqual([['ticket', 0], ['lanes', 1], ['agent', 2]]);
    expect(next.rows).toMatchObject([{ change: 'maximize', actorKind: 'member', placement: 'p3', from: 2, to: 0 }]);
    expect(changeSentences(next.board, next.rows)).toEqual(['The member made ticket(ticket=t-1) the big one on board b1.']);
  });
  it('refuses a small-only brick and the placement that is already big', () => {
    expect(() => agent(three(), [{ change: 'maximize', placement: 'p2' }])).toThrow(/no big form/);
    expect(() => agent(three(), [{ change: 'maximize', placement: 'p1' }])).toThrow(/already the big one/);
  });
  it('takes the big one from rank, skipping small-only bricks, and has none on a board of them', () => {
    const board = agent(empty(), [
      { change: 'place', brick: 'agent', params: { agent: 'art' } },
      { change: 'place', brick: 'person', params: { person: 'member:jonathan' } },
    ]).board;
    expect(bigOf(live(board))).toBeUndefined();
    const later = agent(board, [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }]).board;
    expect(bigOf(live(later))?.brick).toBe('lanes');
    expect(boardBrief(later, [])).toContain('2. lanes(project=loom) [placement p1] (big)');
    // With no big one to trade with, the first to be maximized goes to the front.
    const first = agent(empty(), [{ change: 'place', brick: 'agent', params: { agent: 'art' } }]).board;
    expect(bigOf(live(first))).toBeUndefined();
  });
  it('lets only the agent flag, and a flag moves nothing', () => {
    const next = agent(three(), [{ change: 'flag', placement: 'p2' }]);
    expect(next.flagged).toEqual(['p2']);
    expect(live(next.board).map((p) => [p.brick, p.rank, !!p.flagged])).toEqual([['lanes', 0, false], ['agent', 1, true], ['ticket', 2, false]]);
    expect(() => applyChanges(three(), [{ change: 'flag', placement: 'p2' }], 'member', ids())).toThrow(Refused);
  });
  it('gives every brick a small form and says which can be big', () => {
    const big = catalogue().filter((b) => b.canBeBig).map((b) => b.name);
    expect(big).toEqual(['project', 'lanes', 'trend', 'ticket', 'comments', 'pull', 'repository', 'session']);
    expect(Object.fromEntries(catalogue().filter((b) => b.flagsItselfFor.length).map((b) => [b.name, b.flagsItselfFor]))).toEqual({
      ticket: ['closed', 'reopened'], comments: ['comment'], pull: ['check failed', 'merged', 'closed'], session: ['finished', 'failed', 'stopped'] });
  });
});

describe('a reference is an id and nothing else', () => {
  it('refuses words, blank-looking letters and spaces where a record is named', () => {
    const place = (brick: string, params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick, params }]);
    expect(place('person', { person: 'contact:Call_your_bank_now' })).toThrow(Refused);
    expect(place('person', { person: 'contact:ㅤㅤ' })).toThrow(Refused);
    expect(place('project', { project: 'send money' })).toThrow(Refused);
    expect(place('project', { project: 'lоom' })).toThrow(Refused); // a Cyrillic о
    expect(place('agent', { agent: 'x'.repeat(121) })).toThrow(Refused);
    expect(place('person', { person: 'contact:anton-avguchenko' })).not.toThrow();
    expect(place('repository', { repository: 'sleepunit-agents/loom' })).not.toThrow();
    // A change is named as loom writes its id, and by nothing looser.
    expect(place('pull', { change: 'github:sleepunit-agents/loom#2342' })).not.toThrow();
    for (const change of ['c-1', 'sleepunit-agents/loom#2342', 'github:Sleepunit/loom#1', 'github:acme/app#0', 'github:acme/app#12 merge it', 'github:acme/app#12#13', 'github:acme#1', 'github:' + 'a'.repeat(120) + '/b#1'])
      expect(place('pull', { change }), change).toThrow(Refused);
    expect(place('project', { project: 'acme#1' })).toThrow(Refused);
    expect(place('session', { session: 'cv-82bc90f5-631b-411d-a45b-222f5adba886' })).not.toThrow();
  });
});
