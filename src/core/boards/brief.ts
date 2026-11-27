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
