/** What the page reads: a thread's boards with their live placements (docs/specs/boards.md, "The page").
 * Only the thread's own member is answered. Like every field, a live read re-runs it when a write commits. */
import { and, eq } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, threads } from '../data/schema.js';
import { brickNamed } from './bricks.js';
import { titleSaid } from './brief.js';
import { bigOf, live } from './model.js';
import { BoardStore } from './store.js';

export function boardQueryFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString), integer = new GraphQLNonNull(GraphQLInt), flag = new GraphQLNonNull(GraphQLBoolean);
  const placement = new GraphQLObjectType({ name: 'BoardPlacement', fields: {
    id: { type: text }, brick: { type: text }, params: { type: text, description: 'JSON, valid for the brick.' },
    rank: { type: integer }, placedByKind: { type: text },
    big: { type: flag, description: 'Drawn in the primary form.' }, canBeBig: { type: flag }, flagged: { type: flag },
  } });
  const board = new GraphQLObjectType({ name: 'Board', fields: {
    id: { type: text }, thread: { type: text }, title: { type: text }, revision: { type: integer },
    closed: { type: new GraphQLNonNull(GraphQLBoolean) }, trailAt: { type: text },
    placements: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(placement))) },
  } });
  const store = new BoardStore(db);
  const owns = (viewer: Viewer, thread: string) =>
    viewer.kind === 'member' &&
    !!db.select({ id: threads.id }).from(threads).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(threads.id, thread), eq(conversations.member, viewer.id), eq(conversations.venue, 'loom'))).get();
  const shaped = (id: string) => {
    const found = store.board(id)!, row = store.row(id)!;
    const list = live(found), big = bigOf(list);
    return { id, thread: found.thread, title: titleSaid(found.title), revision: found.revision, closed: found.closed, trailAt: row.trailAt,
      placements: list.map((p) => ({ id: p.id, brick: p.brick, params: JSON.stringify(p.params), rank: p.rank, placedByKind: p.placedByKind,
        big: p === big, canBeBig: !!brickNamed(p.brick)?.big, flagged: !!p.flagged })) };
  };
  return {
    /** Every board of a thread, open ones in trail order and then the closed. Empty for anyone but its member. */
    threadBoards: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(board))), args: { thread: { type: text } },
      resolve: (_row, args: { thread: string }, { viewer }) => {
        if (!owns(viewer, args.thread)) return [];
        const rows = store.inThread(args.thread);
        return [...rows.filter((r) => r.closedAt === null), ...rows.filter((r) => r.closedAt !== null)].map((r) => shaped(r.id));
      },
    },
    /** One board by its address. Nothing for a board that does not exist or is not the viewer's. */
    board: {
      type: board, args: { id: { type: text } },
      resolve: (_row, args: { id: string }, { viewer }) => {
        const row = store.row(args.id);
        return row && owns(viewer, row.thread) ? shaped(row.id) : null;
      },
    },
  };
}
