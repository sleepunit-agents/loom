/** A board's rules as plain functions (docs/specs/boards.md, "Records" and "Operations"). Nothing here reads
 * or writes a database: an operation loads a board, calls these, and stores what comes back. */
import { CLEAN_LINE, isCleanLine } from '../line-name.js';
import { brickNamed, paramsKey, type Brick } from './bricks.js';
import { PLACEMENTS_MAX } from './limits.js';

export type ActorKind = 'agent' | 'member';
export interface Placement {
  id: string;
  brick: string;
  /** Valid for the brick's schema, with every default filled. */
  params: Record<string, unknown>;
  rank: number;
  placedByKind: ActorKind;
  removed: boolean;
  /** The agent pointed at it and the member has not looked yet. */
  flagged?: boolean;
}
export interface Board {
  id: string;
  title: string;
  revision: number;
  closed: boolean;
  /** Its live placements, which hold ranks 0 to n−1, and any removed one the caller loaded to name it. */
  placements: Placement[];
}
export type Change =
  | { change: 'place'; brick: string; params?: Record<string, unknown>; rank?: number }
  | { change: 'remove'; placement: string }
  | { change: 'rank'; placement: string; rank: number }
  | { change: 'title'; title: string }
  | { change: 'maximize'; placement: string }
  | { change: 'flag'; placement: string };
export interface ChangeRow {
  /** When it was stored; set on rows read back. */
  at?: string;
  revision: number;
  seq: number;
  actorKind: ActorKind;
  change: 'open' | 'place' | 'remove' | 'rank' | 'title' | 'close' | 'reopen' | 'act' | 'maximize' | 'flag';
  placement?: string;
  from?: string | number;
  to?: string | number;
  action?: string;
  detail?: Record<string, unknown>;
}

export const TITLE_MAX = 80;
/** A title is the one free text an agent gives a board, and loom repeats it to later jobs: a single clean line
 * (core/line-name.ts). The message a refused one gets, for the operation's schema and the rules alike. */
export const TITLE_RULE = `A title is at most ${TITLE_MAX} characters, on ${CLEAN_LINE}.`;
export const validTitle = (title: unknown): title is string => typeof title === 'string' && title.length <= TITLE_MAX && isCleanLine(title);
/** A call the rules refuse. The message is for the caller: an agent corrects itself from it. */
export class Refused extends Error {}

export const live = (board: Board) =>
  board.placements.filter((p) => !p.removed).sort((a, b) => a.rank - b.rank);

/** The big placement: the first in rank order whose brick has a primary form. A board of small-only bricks has none. */
export const bigOf = <P extends { brick: string }>(inRankOrder: readonly P[]) => inRankOrder.find((p) => brickNamed(p.brick)?.big);

/** A brick's params as they are stored: checked against its schema, defaults filled. */
export function filled(brick: string, params: Record<string, unknown> = {}): { brick: Brick; params: Record<string, unknown> } {
  const found = brickNamed(brick);
  if (!found) throw new Refused(`There is no brick named ${JSON.stringify(brick)}.`);
  const parsed = found.params.safeParse(params);
  if (!parsed.success)
    throw new Refused(`${brick}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'} ${i.message}`).join('; ')}`);
  // An optional parameter left out is absent, not undefined, so equal params have equal keys.
  return { brick: found, params: Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
}

const same = (a: Placement, brick: string, params: Record<string, unknown>) =>
  a.brick === brick && paramsKey(a.params) === paramsKey(params);

/** Applies one call's changes in order. All of them, in one revision, or it throws and the board is as it was. */
export function applyChanges(
  board: Board,
  changes: readonly Change[],
  actorKind: ActorKind,
  newId: () => string,
): { board: Board; rows: ChangeRow[]; placed: Placement[]; flagged: string[] } {
  if (board.closed) throw new Refused('This board is closed. Reopen it, or open another.');
  if (!changes.length) throw new Refused('Give at least one change.');
  const revision = board.revision + 1;
  let title = board.title;
  const placements = board.placements.map((p) => ({ ...p }));
  const rows: ChangeRow[] = [];
  const placed: Placement[] = [];
  const flagged: string[] = [];
  const order = () => placements.filter((p) => !p.removed).sort((a, b) => a.rank - b.rank);
  const renumber = (list: Placement[]) => list.forEach((p, rank) => (p.rank = rank));
  const row = (r: Omit<ChangeRow, 'revision' | 'seq' | 'actorKind'>) =>
    rows.push({ revision, seq: rows.length, actorKind, ...r });
  const find = (id: string) => {
    const p = placements.find((p) => p.id === id && !p.removed);
    if (!p) throw new Refused(`There is no live placement ${JSON.stringify(id)} on this board.`);
    return p;
  };
  for (const c of changes) {
    if (c.change === 'place') {
      if (actorKind === 'member' && c.rank !== undefined) throw new Refused('A member places last.');
      const { params } = filled(c.brick, c.params);
      const list = order();
      if (list.some((p) => same(p, c.brick, params)))
        throw new Refused(`${c.brick} with these params is already on the board.`);
      if (list.length >= PLACEMENTS_MAX)
        throw new Refused(`A board holds at most ${PLACEMENTS_MAX} placements. Remove one that no longer serves, or open another board.`);
      const rank = c.rank ?? list.length;
      if (!Number.isInteger(rank) || rank < 0 || rank > list.length)
        throw new Refused(`rank must be a whole number from 0 to ${list.length}: the board has ${list.length} placement${list.length === 1 ? '' : 's'} as this change lands. Changes apply in order; leave rank out to place last.`);
      const p: Placement = { id: newId(), brick: c.brick, params, rank, placedByKind: actorKind, removed: false };
      list.splice(rank, 0, p);
      placements.push(p);
      renumber(list);
      placed.push(p);
      row({ change: 'place', placement: p.id, to: rank });
    } else if (c.change === 'remove') {
      const p = find(c.placement);
      p.removed = true;
      renumber(order());
      row({ change: 'remove', placement: p.id });
    } else if (c.change === 'rank') {
      if (actorKind === 'member') throw new Refused('A member cannot change rank.');
      const p = find(c.placement);
      const list = order();
      if (!Number.isInteger(c.rank) || c.rank < 0 || c.rank > list.length - 1)
        throw new Refused(`rank must be a whole number from 0 to ${list.length - 1}.`);
      const from = p.rank;
      list.splice(from, 1);
      list.splice(c.rank, 0, p);
      renumber(list);
      row({ change: 'rank', placement: p.id, from, to: c.rank });
    } else if (c.change === 'maximize') {
      const p = find(c.placement);
      if (!brickNamed(p.brick)?.big) throw new Refused(`${p.brick} has no big form. It stays small.`);
      const list = order();
      const big = bigOf(list);
      if (big === p) throw new Refused('That placement is already the big one.');
      // It takes the big one's place, and the one that was big is first among the small: what was just in
      // front of the member stays nearest. The rest keep their order.
      const from = p.rank;
      list.splice(from, 1);
      list.splice(big ? list.indexOf(big) : 0, 0, p);
      renumber(list);
      row({ change: 'maximize', placement: p.id, from, to: p.rank });
    } else if (c.change === 'flag') {
      if (actorKind === 'member') throw new Refused('A member does not flag. Flags are how the board points things out to them.');
      const p = find(c.placement);
      p.flagged = true;
      flagged.push(p.id);
      row({ change: 'flag', placement: p.id });
    } else {
      if (actorKind === 'member') throw new Refused('A member cannot change the title.');
      if (!validTitle(c.title)) throw new Refused(TITLE_RULE);
      row({ change: 'title', from: title, to: c.title });
      title = c.title;
    }
  }
  return { board: { ...board, title, revision, placements }, rows, placed, flagged };
}

/** A member's use of a brick's action, reported by the page after the action's own operation succeeded. */
export function actRow(board: Board, placement: string, action: string, detail: Record<string, unknown>): ChangeRow {
  if (board.closed) throw new Refused('This board is closed.');
  const p = board.placements.find((p) => p.id === placement && !p.removed);
  if (!p) throw new Refused(`There is no live placement ${JSON.stringify(placement)} on this board.`);
  const declared = brickNamed(p.brick)?.actions[action];
  if (!declared) throw new Refused(`${p.brick} has no action ${JSON.stringify(action)}.`);
  const parsed = declared.detail.safeParse(detail);
  if (!parsed.success) throw new Refused(`${action}: detail does not match the action.`);
  return { revision: board.revision + 1, seq: 0, actorKind: 'member', change: 'act', placement, action, detail: parsed.data };
}

/** A blueprint's design: placements in rank order, where a record-reference param may be left open. */
export type Open = { open: string };
export interface Design {
  parameters: { name: string; kind: string }[];
  design: { brick: string; params: Record<string, unknown | Open> }[];
}
const isOpen = (v: unknown): v is Open =>
  !!v && typeof v === 'object' && typeof (v as Open).open === 'string' && Object.keys(v).length === 1;

/** The design saved from a board: which live placements to keep, in the order given, and which of their
 * record references become parameters. */
export function designFrom(board: Board, keep: readonly { placement: string; open?: Record<string, string> }[]): Design {
  if (!keep.length) throw new Refused('Keep at least one placement.');
  const kinds = new Map<string, string>();
  const design = keep.map(({ placement, open = {} }) => {
    const p = board.placements.find((p) => p.id === placement && !p.removed);
    if (!p) throw new Refused(`There is no live placement ${JSON.stringify(placement)} on this board.`);
    const brick = brickNamed(p.brick)!;
    const params: Record<string, unknown | Open> = { ...p.params };
    for (const [param, name] of Object.entries(open)) {
      const kind = brick.references[param];
      if (!kind || !(param in p.params))
        throw new Refused(`${p.brick}.${param} is not a record reference, so it cannot be left open.`);
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Refused('A parameter name is lowercase letters, digits and underscores.');
      if (kinds.has(name) && kinds.get(name) !== kind)
        throw new Refused(`${name} is already a ${kinds.get(name)}; ${p.brick}.${param} is a ${kind}.`);
      kinds.set(name, kind);
      params[param] = { open: name };
    }
    return { brick: p.brick, params };
  });
  const keys = design.map((d) => d.brick + paramsKey(d.params as Record<string, unknown>));
  if (new Set(keys).size !== keys.length) throw new Refused('Two kept placements would be the same brick with the same params.');
  return { parameters: [...kinds].map(([name, kind]) => ({ name, kind })), design };
}

/** The placements a blueprint makes for these arguments. Every parameter, and nothing else. */
export function fill(blueprint: Design, args: Record<string, unknown> = {}): { brick: string; params: Record<string, unknown> }[] {
  const names = blueprint.parameters.map((p) => p.name);
  const missing = names.filter((n) => !(n in args));
  const extra = Object.keys(args).filter((n) => !names.includes(n));
  if (missing.length) throw new Refused(`This blueprint needs ${missing.join(', ')}.`);
  if (extra.length) throw new Refused(`This blueprint has no parameter ${extra.join(', ')}.`);
  const made = blueprint.design.map((d) =>
    filled(d.brick, Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, isOpen(v) ? args[v.open] : v]))),
  );
  const keys = made.map((m) => m.brick.name + paramsKey(m.params));
  if (new Set(keys).size !== keys.length) throw new Refused('With these arguments two placements would be the same.');
  return made.map((m) => ({ brick: m.brick.name, params: m.params }));
}
