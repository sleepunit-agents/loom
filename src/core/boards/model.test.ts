import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bricks, catalogue, knowledgeAnnotations, ticketPriorities } from './bricks.js';
import { taskEditSchema, taskLinkType } from '../../apps/tasks.js';
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
    // An approval is answered by approvals.answer; the board is told that it was allowed or denied and nothing else.
    // A pull request is not answered from a board: it has no action to report.
    const waiting = agent(board, [{ change: 'place', brick: 'approval', params: { approval: 'a-1' } }, { change: 'place', brick: 'pull', params: { change: 'github:acme/app#12' } }], (() => { let n = 5; return () => 'p' + ++n; })());
    for (const action of ['approve', 'refuse']) {
      expect(actRow(waiting.board, 'p6', action, {}).detail).toEqual({});
      for (const detail of [{ reason: 'typed words' }, { review: 'a'.repeat(64) }, { confirm: 'true' }, { answer: 'allow' }])
        expect(() => actRow(waiting.board, 'p6', action, detail), action + JSON.stringify(detail)).toThrow(Refused);
    }
    expect(changeSentences(waiting.board, [actRow(waiting.board, 'p6', 'refuse', {})])).toEqual(['The member used refuse on approval(approval=a-1) on board b1.']);
    for (const [placement, action] of [['p6', 'allow'], ['p6', 'deny'], ['p6', 'answer'], ['p7', 'always'], ['p7', 'answer'], ['p7', 'merge'], ['p7', 'approve']])
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
      ['project', 'lanes', 'trend', 'ticket', 'comments', 'pull', 'repository', 'person', 'agent', 'question', 'approval', 'session', 'inbox', 'approvals', 'new-ticket', 'backlog', 'unfiled', 'knowledge-page', 'knowledge', 'people', 'activity', 'threads', 'agents']);
    for (const b of bricks) {
      const required = (catalogue().find((c) => c.name === b.name)!.params as { required?: string[] }).required ?? [];
      for (const name of required) expect(b.references, `${b.name}.${name}`).toHaveProperty(name);
      if (b.linkKey) expect(b.references).toHaveProperty(b.linkKey);
    }
  });
  it('declares only the actions the page calls, each with a detail of fixed choices', () => {
    const actions = Object.fromEntries(catalogue().map((b) => [b.name, b.actions]));
    expect(Object.fromEntries(Object.entries(actions).map(([name, a]) => [name, Object.keys(a)]))).toEqual({
      project: [], lanes: ['pause', 'resume'], trend: [], ticket: ['claim', 'unclaim', 'close', 'reopen', 'edit', 'link', 'unlink'], comments: ['comment'], pull: [], repository: [],
      person: [], agent: ['stop'], question: ['answer', 'volume'], approval: ['approve', 'refuse', 'always'], session: ['stop'],
      inbox: ['read', 'dismissResult'], approvals: [],
      'new-ticket': ['create'], backlog: ['priority'], unfiled: ['project'],
      'knowledge-page': ['verify', 'recheck', 'annotate'], knowledge: ['add'], people: ['add'], activity: [], threads: [], agents: [] });
    for (const action of [actions.approval.approve, actions.approval.refuse, actions.approval.always, actions.inbox.read, actions.inbox.dismissResult]) expect(action).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
    expect(bricks.find((b) => b.name === 'approval')!.actions).toMatchObject({ approve: { operation: 'approvals.answer' }, refuse: { operation: 'approvals.answer' }, always: { operation: 'approvals.always' } });
    expect(bricks.find((b) => b.name === 'inbox')!.actions).toMatchObject({ read: { operation: 'inbox.read' }, dismissResult: { operation: 'inbox.dismissResult' } });
    // How loudly a question is shown is one of the column's three choices, sent by inbox.volume.
    expect(actions.question.volume).toMatchObject({ type: 'object', required: ['volume'], additionalProperties: false, properties: { volume: { enum: ['full', 'dim', 'mute'] } } });
    expect(bricks.find((b) => b.name === 'question')!.actions.volume.operation).toBe('inbox.volume');
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
    { change: 'place', brick: 'question', params: { item: 'i-1' } },
    { change: 'place', brick: 'ticket', params: { ticket: 't-1' } },
  ]).board;
  it('puts the maximized placement in the big one\'s place, and the old big one first among the small', () => {
    const next = applyChanges(three(), [{ change: 'maximize', placement: 'p3' }], 'member', ids());
    expect(live(next.board).map((p) => [p.brick, p.rank])).toEqual([['ticket', 0], ['lanes', 1], ['question', 2]]);
    expect(next.rows).toMatchObject([{ change: 'maximize', actorKind: 'member', placement: 'p3', from: 2, to: 0 }]);
    expect(changeSentences(next.board, next.rows)).toEqual(['The member made ticket(ticket=t-1) the big one on board b1.']);
  });
  it('refuses a small-only brick and the placement that is already big', () => {
    expect(() => agent(three(), [{ change: 'maximize', placement: 'p2' }])).toThrow(/no big form/);
    expect(() => agent(three(), [{ change: 'maximize', placement: 'p1' }])).toThrow(/already the big one/);
  });
  it('takes the big one from rank, skipping small-only bricks, and has none on a board of them', () => {
    const board = agent(empty(), [
      { change: 'place', brick: 'agents', params: {} },
      { change: 'place', brick: 'question', params: { item: 'i-1' } },
    ]).board;
    expect(bigOf(live(board))).toBeUndefined();
    const later = agent(board, [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }]).board;
    expect(bigOf(live(later))?.brick).toBe('lanes');
    expect(boardBrief(later, [])).toContain('2. lanes(project=loom) [placement p1] (big)');
    // With no big one to trade with, the first to be maximized goes to the front.
    const first = agent(empty(), [{ change: 'place', brick: 'agents', params: {} }]).board;
    expect(bigOf(live(first))).toBeUndefined();
  });
  it('lets only the agent flag, and a flag moves nothing', () => {
    const next = agent(three(), [{ change: 'flag', placement: 'p2' }]);
    expect(next.flagged).toEqual(['p2']);
    expect(live(next.board).map((p) => [p.brick, p.rank, !!p.flagged])).toEqual([['lanes', 0, false], ['question', 1, true], ['ticket', 2, false]]);
    expect(() => applyChanges(three(), [{ change: 'flag', placement: 'p2' }], 'member', ids())).toThrow(Refused);
  });
  it('gives every brick a small form and says which can be big', () => {
    const big = catalogue().filter((b) => b.canBeBig).map((b) => b.name);
    expect(big).toEqual(['project', 'lanes', 'trend', 'ticket', 'comments', 'pull', 'repository', 'person', 'agent', 'session', 'inbox', 'approvals', 'new-ticket', 'backlog', 'unfiled', 'knowledge-page', 'knowledge', 'people', 'activity', 'threads']);
    expect(Object.fromEntries(catalogue().filter((b) => b.flagsItselfFor.length).map((b) => [b.name, b.flagsItselfFor]))).toEqual({
      ticket: ['closed', 'reopened'], comments: ['comment'], pull: ['check failed', 'merged', 'closed'], agent: ['waiting on you'], session: ['finished', 'failed', 'stopped'],
      inbox: ['new item'], approvals: ['new approval'] });
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

describe('the two lists of what waits on the member: inbox and approvals', () => {
  const place = (brick: string, params: Record<string, unknown>) => agent(empty(), [{ change: 'place', brick, params }]);
  it('takes a folder or a state from a fixed list, fills the one that holds what waits, and takes nothing free', () => {
    expect(live(place('inbox', {}).board)[0].params).toEqual({ folder: 'needs' });
    expect(live(place('approvals', {}).board)[0].params).toEqual({ state: 'pending' });
    for (const folder of ['needs', 'alerts', 'answered', 'fyi', 'all', 'errors']) expect(live(place('inbox', { folder }).board)[0].params).toEqual({ folder });
    for (const state of ['pending', 'answered']) expect(live(place('approvals', { state }).board)[0].params).toEqual({ state });
    for (const params of [{ folder: 'agent:art' }, { folder: 'Needs you' }, { folder: 'send money now' }, { folder: 'needs', search: 'pump' }, { item: 'i-1' }, { folder: 1 }])
      expect(() => place('inbox', params), JSON.stringify(params)).toThrow(Refused);
    for (const params of [{ state: 'history' }, { state: 'allowed' }, { state: 'approve them all' }, { state: 'pending', approval: 'a-1' }, { state: 2 }])
      expect(() => place('approvals', params), JSON.stringify(params)).toThrow(Refused);
  });
  it('names no record, so neither is written in words or left open, and each can be the big one', () => {
    for (const name of ['inbox', 'approvals']) {
      const b = bricks.find((b) => b.name === name)!;
      expect(b.references).toEqual({});
      expect(b.linkKey).toBeUndefined();
      expect(b.big).toBe(true);
    }
    const both = agent(empty(), [{ change: 'place', brick: 'approvals', params: {} }, { change: 'place', brick: 'inbox', params: { folder: 'fyi' } }]);
    expect(live(agent(both.board, [{ change: 'maximize', placement: 'p2' }]).board).map((p) => p.brick)).toEqual(['inbox', 'approvals']);
  });
  it('logs the list\'s own actions with an empty detail, a question\'s volume as one of three, and the standing answer with nothing', () => {
    const board = agent(empty(), [{ change: 'place', brick: 'inbox', params: {} }, { change: 'place', brick: 'approvals', params: {} },
      { change: 'place', brick: 'question', params: { item: 'i-1' } }, { change: 'place', brick: 'approval', params: { approval: 'a-1' } }]).board;
    expect(changeSentences(board, [actRow(board, 'p1', 'read', {})])).toEqual(['The member used read on inbox(folder=needs) on board b1.']);
    expect(changeSentences(board, [actRow(board, 'p1', 'dismissResult', {})])).toEqual(['The member used dismissResult on inbox(folder=needs) on board b1.']);
    expect(changeSentences(board, [actRow(board, 'p3', 'volume', { volume: 'dim' })])).toEqual(['The member used volume on question(item=i-1) on board b1: volume=dim.']);
    expect(changeSentences(board, [actRow(board, 'p4', 'always', {})])).toEqual(['The member used always on approval(approval=a-1) on board b1.']);
    for (const [placement, action, detail] of [['p1', 'read', { item: 'i-1' }], ['p1', 'answer', { answer: 'yes' }], ['p1', 'volume', { volume: 'dim' }], ['p2', 'approve', {}], ['p2', 'always', {}],
      ['p3', 'volume', { volume: 'loud' }], ['p3', 'volume', {}], ['p3', 'volume', { volume: 'dim', until: 'tomorrow' }], ['p4', 'always', { project: 'pond' }]] as const)
      expect(() => actRow(board, placement, action, detail), `${placement} ${action}`).toThrow(Refused);
  });
});

describe('Work written from a board', () => {
  const b = () => agent(empty(), [
    { change: 'place', brick: 'ticket', params: { ticket: 't-7' } },
    { change: 'place', brick: 'new-ticket', params: { project: 'loom' } },
    { change: 'place', brick: 'backlog', params: { project: 'loom' } },
    { change: 'place', brick: 'unfiled', params: {} },
  ], (() => { let n = 0; return () => 'w' + ++n; })()).board;
  it('places the new bricks by a project, or by nothing for the unfiled tickets, and refuses anything else', () => {
    expect(live(b()).map((p) => [p.brick, p.params])).toEqual([['ticket', { ticket: 't-7' }], ['new-ticket', { project: 'loom' }], ['backlog', { project: 'loom' }], ['unfiled', {}]]);
    const place = (brick: string, params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick, params }]);
    for (const brick of ['new-ticket', 'backlog']) {
      expect(place(brick, {}), brick).toThrow(Refused);
      expect(place(brick, { project: 'file this now' }), brick).toThrow(Refused);
      expect(place(brick, { project: 'loom', title: 'Typed words' }), brick).toThrow(Refused);
    }
    expect(place('unfiled', { project: 'loom' })).toThrow(Refused);
    expect(() => agent(b(), [{ change: 'place', brick: 'unfiled', params: {} }])).toThrow(Refused);
    for (const name of ['new-ticket', 'backlog', 'unfiled']) expect(bricks.find((x) => x.name === name)).toMatchObject({ big: true, flags: [] });
  });
  it('tells an edit, a filing and a move with nothing typed, and a link or a priority by its fixed choice alone', () => {
    const board = b();
    for (const [placement, action] of [['w1', 'edit'], ['w2', 'create'], ['w4', 'project']]) {
      expect(actRow(board, placement, action, {}).detail).toEqual({});
      for (const detail of [{ title: 'Typed words' }, { project: 'loom' }, { id: 't-9' }, { priority: '1' }])
        expect(() => actRow(board, placement, action, detail), action + JSON.stringify(detail)).toThrow(Refused);
    }
    for (const action of ['link', 'unlink']) {
      for (const type of ['blocks', 'parent-child']) expect(actRow(board, 'w1', action, { type }).detail).toEqual({ type });
      for (const detail of [{}, { type: 'duplicates' }, { type: 'blocks', dependsOn: 't-9' }, { type: 'see the words I typed' }])
        expect(() => actRow(board, 'w1', action, detail), action + JSON.stringify(detail)).toThrow(Refused);
    }
    for (const priority of ['0', '1', '2', '3', '4']) expect(actRow(board, 'w3', 'priority', { priority }).detail).toEqual({ priority });
    for (const detail of [{}, { priority: '5' }, { priority: 2 }, { priority: 'urgent, call me' }, { priority: '1', ticket: 't-9' }])
      expect(() => actRow(board, 'w3', 'priority', detail), JSON.stringify(detail)).toThrow(Refused);
    expect(changeSentences(board, [actRow(board, 'w3', 'priority', { priority: '0' })])).toEqual(['The member used priority on backlog(project=loom) on board b1: priority=0.']);
    expect(changeSentences(board, [actRow(board, 'w1', 'link', { type: 'blocks' })])).toEqual(['The member used link on ticket(ticket=t-7) on board b1: type=blocks.']);
    expect(changeSentences(board, [actRow(board, 'w4', 'project', {})])).toEqual(['The member used project on unfiled() on board b1.']);
    for (const [placement, action] of [['w2', 'edit'], ['w3', 'create'], ['w3', 'edit'], ['w4', 'priority'], ['w1', 'create'], ['w1', 'priority'], ['w1', 'project']])
      expect(() => actRow(board, placement, action, {}), action).toThrow(Refused);
    for (const name of ['ticket', 'new-ticket', 'backlog', 'unfiled']) for (const action of Object.values(bricks.find((x) => x.name === name)!.actions)) expect(action.operation).toBe('tasks.command');
  });
  it('holds the choices a detail may name to the lists tasks.command takes', () => {
    for (const action of ['link', 'unlink']) for (const type of taskLinkType.options) expect(bricks.find((x) => x.name === 'ticket')!.actions[action].detail.safeParse({ type }).success).toBe(true);
    for (const priority of ticketPriorities) expect(taskEditSchema.safeParse({ priority: Number(priority) }).success).toBe(true);
    for (const outside of [-1, ticketPriorities.length]) expect(taskEditSchema.safeParse({ priority: outside }).success).toBe(false);
  });
  it("tells a pause or a resume of an agent's claims from the lanes, with nothing in its detail", () => {
    const board = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }], () => 'l1').board;
    for (const action of ['pause', 'resume']) {
      expect(actRow(board, 'l1', action, {}).detail).toEqual({});
      for (const detail of [{ agent: 'art' }, { paused: 'true' }, { why: 'typed words' }]) expect(() => actRow(board, 'l1', action, detail), action + JSON.stringify(detail)).toThrow(Refused);
      expect(bricks.find((x) => x.name === 'lanes')!.actions[action].operation).toBe('work.setProjectClaims');
    }
    expect(changeSentences(board, [actRow(board, 'l1', 'pause', {})])).toEqual(['The member used pause on lanes(project=loom) on board b1.']);
    expect(() => actRow(board, 'l1', 'claim', {})).toThrow(Refused);
  });
});

describe('what loom knows: knowledge, people and activity', () => {
  const place = (brick: string, params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick, params }]);
  const entry = (name: string) => catalogue().find((b) => b.name === name)!;
  it('places a knowledge page by its slug and by nothing looser', () => {
    for (const page of ['pump', 'how-the-pond-pump-runs', 'ours/pond_pump.v2', 'a'.repeat(128), 'A1'])
      expect(place('knowledge-page', { page }), page).not.toThrow();
    for (const page of ['', 'call your bank', '-pump', 'pump:now', 'pump@home', 'pump#1', 'pümp', 'a'.repeat(201), 'pump\n'])
      expect(place('knowledge-page', { page }), JSON.stringify(page)).toThrow(Refused);
    expect(place('knowledge-page', {})).toThrow(Refused);
    expect(place('knowledge-page', { page: 'pump', query: 'pump' })).toThrow(Refused);
    expect(entry('knowledge-page')).toMatchObject({ canBeBig: true, linkKey: 'page', references: { page: 'knowledge page' }, flagsItselfFor: [] });
  });
  it('lets a knowledge page be checked, and annotated with one of the kinds mind.knowledgeAnnotate takes and no words', () => {
    const board = agent(empty(), [{ change: 'place', brick: 'knowledge-page', params: { page: 'pump' } }]).board;
    for (const action of ['verify', 'recheck']) {
      expect(() => actRow(board, 'p1', action, {})).not.toThrow();
      expect(() => actRow(board, 'p1', action, { note: 'typed' })).toThrow(Refused);
    }
    expect(() => actRow(board, 'p1', 'annotate', { kind: 'outdated' })).not.toThrow();
    for (const detail of [{}, { kind: 'dispute' }, { kind: 'I typed this' }, { kind: 'note', words: 'I typed this' }])
      expect(() => actRow(board, 'p1', 'annotate', detail), JSON.stringify(detail)).toThrow(Refused);
    expect(Object.fromEntries(Object.entries(bricks.find((b) => b.name === 'knowledge-page')!.actions).map(([name, a]) => [name, a.operation])))
      .toEqual({ verify: 'mind.knowledgeVerify', recheck: 'mind.knowledgeRecheck', annotate: 'mind.knowledgeAnnotate' });
    // The kinds are the operation's own.
    const operation = readFileSync('src/pieces/mind/actions.ts', 'utf8');
    expect(operation).toContain("kind: z.enum(['outdated', 'intent', 'note', 'no-longer-owned', 'in-use'])");
    expect([...knowledgeAnnotations].sort()).toEqual(['in-use', 'intent', 'no-longer-owned', 'note', 'outdated']);
  });
});

describe('the knowledge list', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'knowledge', params }]);
  it('takes one of Knowledge\'s lists and a topic, and no words to search for', () => {
    expect(agent(empty(), [{ change: 'place', brick: 'knowledge', params: {} }]).board.placements[0].params).toEqual({ show: 'all' });
    for (const params of [{ show: 'due' }, { show: 'recent', domain: 'pond' }, { domain: 'ours/pond.pump_2' }]) expect(place(params), JSON.stringify(params)).not.toThrow();
    for (const params of [{ show: 'stale' }, { domain: 'Pond' }, { domain: 'home network' }, { domain: '' }, { domain: 'a'.repeat(121) }, { query: 'pump' }, { show: 'all', search: 'pump' }])
      expect(place(params), JSON.stringify(params)).toThrow(Refused);
    const entry = catalogue().find((b) => b.name === 'knowledge')!;
    expect(entry).toMatchObject({ canBeBig: true, linkKey: null, references: { domain: 'knowledge topic' }, flagsItselfFor: [] });
    expect(Object.keys((entry.params as { properties: object }).properties).sort()).toEqual(['domain', 'show']);
    const board = place({})().board;
    expect(() => actRow(board, 'p1', 'add', {})).not.toThrow();
    expect(() => actRow(board, 'p1', 'add', { title: 'I typed this' })).toThrow(Refused);
    expect(() => actRow(board, 'p1', 'search', {})).toThrow(Refused);
    expect(bricks.find((b) => b.name === 'knowledge')!.actions.add.operation).toBe('mind.knowledgeAdd');
  });
});

describe('a person can be big', () => {
  it('lets a person take the big place, and still has no action', () => {
    const board = agent(empty(), [
      { change: 'place', brick: 'question', params: { item: 'i-1' } },
      { change: 'place', brick: 'person', params: { person: 'contact:anton' } },
    ]).board;
    expect(bigOf(live(board))?.brick).toBe('person');
    expect(catalogue().find((b) => b.name === 'person')).toMatchObject({ canBeBig: true, actions: {}, flagsItselfFor: [], linkKey: 'person' });
    expect(() => actRow(board, 'p2', 'add', {})).toThrow(Refused);
  });
});

describe('the directory of people', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'people', params }]);
  it('takes one of People\'s folders and no words to search for', () => {
    expect(place({})().board.placements[0].params).toEqual({ folder: 'all' });
    for (const folder of ['all', 'person', 'agent']) expect(place({ folder }), folder).not.toThrow();
    for (const params of [{ folder: 'friends' }, { folder: 'People' }, { query: 'anton' }, { folder: 'all', search: 'anton' }, { agent: 'art' }])
      expect(place(params), JSON.stringify(params)).toThrow(Refused);
    expect(catalogue().find((b) => b.name === 'people')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [] });
    const board = place({})().board;
    expect(() => actRow(board, 'p1', 'add', {})).not.toThrow();
    expect(() => actRow(board, 'p1', 'add', { name: 'I typed this' })).toThrow(Refused);
    expect(bricks.find((b) => b.name === 'people')!.actions.add.operation).toBe('mind.personAdd');
  });
});

describe('the household timeline', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'activity', params }]);
  it('takes a day, 7 days or 30 days, changes nothing and flags nothing', () => {
    expect(place({})().board.placements[0].params).toEqual({ days: 1 });
    for (const days of [1, 7, 30]) expect(place({ days }), String(days)).not.toThrow();
    for (const params of [{ days: 3 }, { days: 0 }, { days: '7' }, { days: 7.5 }, { days: 7, agent: 'art' }, { day: '2026-11-13' }, { who: 'owner' }])
      expect(place(params), JSON.stringify(params)).toThrow(Refused);
    expect(catalogue().find((b) => b.name === 'activity')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [], actions: {} });
    expect(() => actRow(place({})().board, 'p1', 'open', {})).toThrow(Refused);
  });
});

describe('the threads brick', () => {
  const place = (params: Record<string, unknown>) => agent(empty(), [{ change: 'place', brick: 'threads', params }]);
  it('takes no reference: its one parameter is Comms\' folder, open unless archived is asked for', () => {
    const brick = bricks.find((b) => b.name === 'threads')!;
    expect(brick).toMatchObject({ references: {}, actions: {}, big: true, flags: [] });
    expect(brick.linkKey).toBeUndefined();
    expect(live(place({}).board)[0].params).toEqual({ scope: 'open' });
    expect(live(place({ scope: 'archived' }).board)[0].params).toEqual({ scope: 'archived' });
    for (const params of [{ scope: 'all' }, { scope: 'th:alice' }, { member: 'other' }, { scope: 'open', thread: 'th:1' }]) expect(() => place(params), JSON.stringify(params)).toThrow(Refused);
  });
});

describe('the agent and agents bricks', () => {
  it('an agent can be big, flags itself when it starts waiting on the member, and its one action is stopping a job', () => {
    const brick = bricks.find((b) => b.name === 'agent')!;
    expect(brick).toMatchObject({ big: true, flags: ['waiting on you'], references: { agent: 'agent' }, linkKey: 'agent' });
    expect(Object.keys(brick.actions)).toEqual(['stop']);
    expect(brick.actions.stop.operation).toBe('runtime.jobStop');
    // The job stopped and the reason are the operation's; the board is told only that it happened.
    expect(brick.actions.stop.detail.safeParse({}).success).toBe(true);
    for (const detail of [{ job: 'j-1' }, { reason: 'write-off' }, { note: 'because' }]) expect(brick.actions.stop.detail.safeParse(detail).success).toBe(false);
    const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'agent', params }]);
    expect(place({ agent: 'art' })).not.toThrow();
    for (const params of [{}, { agent: 'the helpful one' }, { agent: 'art', job: 'j-1' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
    const board = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }, { change: 'place', brick: 'agent', params: { agent: 'art' } }]).board;
    expect(live(applyChanges(board, [{ change: 'maximize', placement: 'p2' }], 'member', ids()).board).map((p) => [p.brick, p.rank])).toEqual([['agent', 0], ['lanes', 1]]);
  });
  it('the roster takes no parameter, has no action, never flags itself and is small only', () => {
    const brick = bricks.find((b) => b.name === 'agents')!;
    expect(brick).toMatchObject({ big: false, flags: [], references: {}, actions: {} });
    expect(live(agent(empty(), [{ change: 'place', brick: 'agents', params: {} }]).board)[0].params).toEqual({});
    for (const params of [{ agent: 'art' }, { scope: 'all' }]) expect(() => agent(empty(), [{ change: 'place', brick: 'agents', params }]), JSON.stringify(params)).toThrow(Refused);
    const board = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }, { change: 'place', brick: 'agents', params: {} }]).board;
    expect(() => agent(board, [{ change: 'maximize', placement: 'p2' }])).toThrow(/no big form/);
  });
});
