/** What the agent is told about its boards (docs/specs/boards.md, "What the agent is told"). Pure: the
 * caller loads the rows and stores `agent_seen` afterwards. Apart from a board's title, everything here is
 * an id, a brick name, a choice or a whole number. */
import { bigOf, live, type Board, type ChangeRow, type Placement } from './model.js';

export const said = (p: Pick<Placement, 'brick' | 'params'>) =>
  `${p.brick}(${Object.keys(p.params).sort().map((k) => `${k}=${String(p.params[k])}`).join(', ')})`;

/** One sentence for each change the member made that the agent has not been handed. */
export function changeSentences(board: Board, unseen: readonly ChangeRow[]): string[] {
  const named = (id?: string) => {
    const p = board.placements.find((p) => p.id === id);
    return p ? said(p) : 'a placement';
  };
  return unseen
    .filter((r) => r.actorKind === 'member')
    .sort((a, b) => a.revision - b.revision || a.seq - b.seq)
    .map((r) => {
      const on = `board ${board.id}`;
      if (r.change === 'open') return `The member opened ${on}.`;
      if (r.change === 'place') return `The member placed ${named(r.placement)} on ${on}.`;
      if (r.change === 'remove') return `The member removed ${named(r.placement)} from ${on}.`;
      if (r.change === 'close') return `The member closed ${on}.`;
      if (r.change === 'reopen') return `The member reopened ${on}.`;
      if (r.change === 'maximize') return `The member made ${named(r.placement)} the big one on ${on}.`;
      if (r.change === 'act') {
        const detail = Object.entries(r.detail ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${String(v)}`).join(', ');
        return `The member used ${r.action} on ${named(r.placement)} on ${on}${detail ? ': ' + detail : ''}.`;
      }
      return '';
    })
    .filter(Boolean);
}

/** A board as an agent call returns it and as the brief describes it. */
export function described(board: Board): string {
  const list = live(board);
  const big = bigOf(list);
  return [
    `Board ${board.id}${board.title ? ` "${board.title}"` : ''}, ${board.closed ? 'closed' : 'open'}, revision ${board.revision}.`,
    ...(list.length
      ? list.map((p) => `${p.rank}. ${said(p)} [placement ${p.id}]${p === big ? ' (big)' : ''}${p.flagged ? ' (flagged, not yet looked at)' : ''}`)
      : ['It has no placements.']),
  ].join('\n');
}

export function boardBrief(shown: Board | null, boards: readonly { board: Board; unseen: readonly ChangeRow[] }[]): string {
  const changes = boards.flatMap(({ board, unseen }) => changeSentences(board, unseen));
  return [
    shown ? 'The member is looking at this board:\n' + described(shown) : 'No board is open in this thread.',
    ...(changes.length ? ['Since you last looked:\n' + changes.map((s) => '- ' + s).join('\n')] : []),
  ].join('\n\n');
}

/** What a job in a thread with the second window is told before its mail: that the board exists, how to fill
 * it, and what is on it now. The standing instructions are judgment (docs/specs/boards.md); nothing checks them. */
export function boardsMail(brief: string): string {
  return [
    'This conversation has a second window beside it, the board. Only you fill it, and the member watches you do it.',
    'You place bricks: fixed kinds of thing loom knows how to draw. You never write markup, queries or positions.',
    'Use loom_command with these operations: bricks.catalogue (what bricks exist and their parameters), blueprints.list,',
    'boards.list, boards.open {title, blueprint?, arguments?}, boards.change {board, changes:[{change:"place",brick,params,rank?}',
    '| {change:"remove",placement} | {change:"rank",placement,rank} | {change:"title",title} | {change:"maximize",placement}',
    '| {change:"flag",placement}]}, boards.read {board},',
    'boards.close {board}, boards.reopen {board}, blueprints.save {board, name, description, placements:[{placement, open?}]}.',
    'One placement is big: the first in rank order whose brick can be big (the catalogue says which). The rest are small.',
    'Make big the brick that answers what was asked: lanes or trend for how a project is going, ticket for one ticket,',
    'session for work in flight. project is a summary card and is rarely the right one to lead with.',
    'A board reads best with three to five bricks. More than that and the rest are one-line strips.',
    'Board and placement ids are for your calls. Never write them in your reply: the member sees the board itself.',
    'maximize trades a small one with the big one and moves nothing else. The member can do that too, and you are told.',
    'flag marks a placement as worth a look without moving anything. When the member chose the big one, flag before you',
    'change it, and change it only when it cannot wait. Say what you have to say in your reply; show it on the board.',
    'When you build a new board, place one brick per boards.change call so it comes together in front of them.',
    'Change the board on screen when the subject is the same; open a new one when it is not. Remove what no longer serves.',
    'Save a board worth returning to as a blueprint, and always when you find yourself building the same board again.',
    'If no brick shows what is needed, say so and file a ticket for the brick. Do not approximate.',
    'Here you decide and dispatch. Look things up, run a command, use quick subagents to read. Work that writes code or',
    'runs long is handed off with conversation.handoff, not done in this conversation.',
    '',
    brief,
  ].join('\n');
}
