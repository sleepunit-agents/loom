/** What the agent is told about its boards (docs/specs/boards.md, "What the agent is told"). Pure: the
 * caller loads the rows and stores `agent_seen` afterwards. Apart from a board's title, everything here is
 * an id, a brick name, a choice or a whole number. */
import { live, type Board, type ChangeRow, type Placement } from './model.js';

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
  return [
    `Board ${board.id}${board.title ? ` "${board.title}"` : ''}, ${board.closed ? 'closed' : 'open'}, revision ${board.revision}.`,
    ...(list.length
      ? list.map((p) => `${p.rank}. ${said(p)} [placement ${p.id}]${p.rank === 0 ? ' (primary)' : ''}`)
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
    '| {change:"remove",placement} | {change:"rank",placement,rank} | {change:"title",title}]}, boards.read {board},',
    'boards.close {board}, boards.reopen {board}, blueprints.save {board, name, description, placements:[{placement, open?}]}.',
    'Rank 0 is the primary: the one thing the board is about. Say what you have to say in your reply; show it on the board.',
    'When you build a new board, place one brick per boards.change call so it comes together in front of them.',
    'Change the board on screen when the subject is the same; open a new one when it is not. Remove what no longer serves.',
    'Save a board worth returning to as a blueprint, and always when you find yourself building the same board again.',
    'If no brick shows what is needed, say so and file a ticket for the brick. Do not approximate.',
    '',
    brief,
  ].join('\n');
}
