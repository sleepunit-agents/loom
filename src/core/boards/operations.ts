/** The door's board operations (docs/specs/boards.md, "Operations"). Two callers: a job's body, for boards in
 * that job's own thread and blueprints of its own agent; and the thread's member, with a narrower hand. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { blueprints, conversations, threads } from '../data/schema.js';
import { operation, OperationError, type Context, type Operations } from '../operations/index.js';
import type { conversationBodyScope } from '../conversations/body-scope.js';
import { catalogue } from './bricks.js';
import { actRow, applyChanges, bigOf, live, designFrom, fill, filled, Refused, TITLE_MAX, type Change, type Design } from './model.js';
import { BoardStore, newPlacementId } from './store.js';

type BodyScope = ReturnType<typeof conversationBodyScope>;
const id = z.string().min(1).max(200);
const params = z.record(z.string(), z.unknown());
const change = z.discriminatedUnion('change', [
  z.object({ change: z.literal('place'), brick: z.string().min(1).max(80), params: params.optional(), rank: z.number().int().optional() }).strict(),
  z.object({ change: z.literal('remove'), placement: id }).strict(),
  z.object({ change: z.literal('rank'), placement: id, rank: z.number().int() }).strict(),
  z.object({ change: z.literal('title'), title: z.string().max(TITLE_MAX) }).strict(),
  z.object({ change: z.literal('maximize'), placement: id }).strict(),
  z.object({ change: z.literal('flag'), placement: id }).strict(),
]);
const any = z.unknown();

export function registerBoardOperations(operations: Operations, db: DataDatabase, body: BodyScope, hash: (words: string) => string): BoardStore {
  const store = new BoardStore(db);
  const at = (ctx: Context) => new Date(ctx.now).toISOString();
  /** The thread a job's body is working in, and its agent. */
  const working = (viewer: Viewer) => {
    const found = body(viewer);
    const thread = found && store.threadOfConversation(found.cv.id);
    // Boards are offered only where the member has the second window to see them.
    return thread && store.attended(thread) ? { thread, agent: found.cv.agent } : undefined;
  };
  /** A member owns a thread when its conversation is theirs, in loom's own venue. */
  const owns = (viewer: Viewer, thread: string) =>
    viewer.kind === 'member' &&
    !!db.select({ id: threads.id }).from(threads).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(threads.id, thread), eq(conversations.member, viewer.id), eq(conversations.venue, 'loom'))).get();
  const actor = (viewer: Viewer, thread: string): 'agent' | 'member' | undefined =>
    working(viewer)?.thread === thread ? 'agent' : owns(viewer, thread) ? 'member' : undefined;
  const mayBoard = (viewer: Viewer, board: string) => {
    const row = store.row(board);
    return !!row && !!actor(viewer, row.thread);
  };
  const loaded = (viewer: Viewer, board: string) => {
    const found = store.board(board);
    const who = found && actor(viewer, found.thread);
    if (!found || !who) throw new OperationError('denied', 'There is no such board in this thread.');
    return { board: found, who };
  };
  const result = (who: 'agent' | 'member', board: string) =>
    who === 'agent' ? store.handed(board) : { board, revision: store.row(board)!.revision };
  const common = {
    refuses: true, doors: ['http'] as ['http'], write: true, recheckPolicy: true,
    inputHash: (value: string, identity: Readonly<{ actor: Viewer }>) =>
      hash(`board-operation\0${body(identity.actor)?.job.id ?? 'member'}\0${value}`),
  };
  const agentOnly = { ...common, may: (viewer: Viewer) => !!working(viewer) };

  operations.register(operation({ name: 'bricks.catalogue', write: false, doors: ['http'], input: z.object({}).strict(), output: any,
    may: (viewer) => !!working(viewer) || viewer.kind === 'member',
    run: () => ({ bricks: catalogue() }) }));

  operations.register(operation({ name: 'blueprints.list', write: false, doors: ['http'], input: z.object({}).strict(), output: any,
    may: (viewer) => !!working(viewer),
    run(ctx) {
      const { agent } = working(ctx.viewer)!;
      return { blueprints: store.blueprintsOf(agent).map((b) => ({ blueprint: b.id, name: b.name, description: b.description,
        parameters: JSON.parse(b.parameters) as unknown, uses: b.uses })) };
    } }));

  operations.register(operation({ name: 'boards.list', write: false, doors: ['http'], input: z.object({}).strict(), output: any,
    may: (viewer) => !!working(viewer),
    run(ctx) {
      const { thread } = working(ctx.viewer)!;
      return { boards: store.inThread(thread).map((row) => {
        const primary = bigOf(live(store.board(row.id)!));
        return { board: row.id, title: row.title, closed: row.closedAt !== null, trailAt: row.trailAt,
          big: primary ? { brick: primary.brick, params: primary.params } : null };
      }) };
    } }));

  operations.register(operation({ ...common, name: 'boards.open',
    input: z.object({ thread: id.optional(), title: z.string().max(TITLE_MAX).optional(), blueprint: id.optional(),
      arguments: params.optional(), place: z.object({ brick: z.string().min(1).max(80), params: params.optional() }).strict().optional() }).strict(),
    output: any,
    may: (viewer, input) => !!working(viewer) || (!!input.thread && owns(viewer, input.thread)),
    run(ctx, input) {
      const job = working(ctx.viewer);
      const who: 'agent' | 'member' = job ? 'agent' : 'member';
      const thread = job ? job.thread : input.thread!;
      if (job && (input.thread || input.place)) throw new Refused('A body opens a board in its own thread, with a title and perhaps a blueprint.');
      if (!job && (!input.place || input.title || input.blueprint || input.arguments))
        throw new Refused('A member opens a board by placing one brick.');
      let placed: { brick: string; params: Record<string, unknown> }[] = [];
      if (input.blueprint) {
        const blueprint = db.select().from(blueprints).where(and(eq(blueprints.id, input.blueprint), eq(blueprints.agent, job!.agent))).get();
        if (!blueprint) throw new OperationError('denied', 'This agent has no such blueprint.');
        placed = fill({ parameters: JSON.parse(blueprint.parameters), design: JSON.parse(blueprint.design) } as Design, input.arguments);
        db.update(blueprints).set({ usedAt: at(ctx), uses: blueprint.uses + 1 }).where(eq(blueprints.id, blueprint.id)).run();
      } else if (input.arguments) throw new Refused('Arguments are for a blueprint.');
      else if (input.place) placed = [{ brick: input.place.brick, params: filled(input.place.brick, input.place.params).params }];
      const board = store.open({ thread, title: input.title ?? '', blueprint: input.blueprint, at: at(ctx) });
      const made = placed.map((p, rank) => ({ id: newPlacementId(), brick: p.brick, params: p.params, rank, placedByKind: who, removed: false } as const));
      const empty = { id: board, title: input.title ?? '', revision: 1, closed: false, placements: [] };
      store.save(empty, { ...empty, placements: [...made] }, [
        { revision: 1, seq: 0, actorKind: who, change: 'open' },
        ...made.map((p, i) => ({ revision: 1, seq: i + 1, actorKind: who, change: 'place' as const, placement: p.id, to: p.rank })),
      ], at(ctx));
      ctx.changed('boards', board);
      return result(who, board);
    } }));

  operations.register(operation({ ...common, name: 'boards.change',
    input: z.object({ board: id, changes: z.array(change).min(1).max(40) }).strict(), output: any,
    may: (viewer, input) => mayBoard(viewer, input.board),
    run(ctx, input) {
      const { board, who } = loaded(ctx.viewer, input.board);
      const next = applyChanges(board, input.changes as Change[], who, newPlacementId);
      store.save(board, next.board, next.rows, at(ctx), next.flagged);
      ctx.changed('boards', board.id);
      return result(who, board.id);
    } }));

  operations.register(operation({ ...common, name: 'boards.read', write: false,
    input: z.object({ board: id, since: z.number().int().nonnegative().optional() }).strict(), output: any,
    may: (viewer, input) => !!working(viewer) && mayBoard(viewer, input.board),
    run(ctx, input) {
      const { board } = loaded(ctx.viewer, input.board);
      return { board: board.id, title: board.title, revision: board.revision, closed: board.closed,
        placements: board.placements.filter((p) => !p.removed).sort((a, b) => a.rank - b.rank)
          .map((p) => ({ placement: p.id, brick: p.brick, params: p.params, rank: p.rank })),
        changes: store.changes(board.id, input.since ?? 0) };
    } }));

  for (const name of ['close', 'reopen'] as const)
    operations.register(operation({ ...common, name: `boards.${name}`, input: z.object({ board: id }).strict(), output: any,
      may: (viewer, input) => mayBoard(viewer, input.board),
      run(ctx, input) {
        const { board, who } = loaded(ctx.viewer, input.board);
        if (board.closed === (name === 'close')) throw new Refused(name === 'close' ? 'This board is already closed.' : 'This board is already open.');
        const now = at(ctx);
        store.stamp(board, { revision: board.revision + 1, seq: 0, actorKind: who, change: name }, now,
          name === 'close' ? { closedAt: now } : { closedAt: null, trailAt: now });
        ctx.changed('boards', board.id);
        return result(who, board.id);
      } }));

  operations.register(operation({ ...common, name: 'boards.act',
    input: z.object({ board: id, placement: id, action: z.string().min(1).max(80), detail: params }).strict(), output: any,
    may: (viewer, input) => { const row = store.row(input.board); return !!row && owns(viewer, row.thread); },
    run(ctx, input) {
      const { board } = loaded(ctx.viewer, input.board);
      const revision = store.stamp(board, actRow(board, input.placement, input.action, input.detail), at(ctx));
      ctx.changed('boards', board.id);
      return { board: board.id, revision };
    } }));

  operations.register(operation({ ...common, name: 'boards.seen',
    input: z.object({ board: id, placement: id }).strict(), output: any,
    may: (viewer, input) => { const row = store.row(input.board); return !!row && owns(viewer, row.thread); },
    run(ctx, input) {
      const cleared = store.seen(input.board, input.placement);
      if (cleared) ctx.changed('boards', input.board);
      return { board: input.board, cleared };
    } }));

  operations.register(operation({ ...agentOnly, name: 'boards.brief', input: z.object({}).strict(), output: any,
    run(ctx) {
      const { thread } = working(ctx.viewer)!;
      const text = store.takeBrief(thread);
      ctx.changed('boards', thread);
      return { text };
    } }));

  operations.register(operation({ ...agentOnly, name: 'blueprints.save',
    input: z.object({ board: id, name: z.string().trim().min(1).max(80), description: z.string().trim().max(300),
      placements: z.array(z.object({ placement: id, open: z.record(z.string(), z.string()).optional() }).strict()).min(1).max(40) }).strict(),
    output: any,
    may: (viewer, input) => !!working(viewer) && mayBoard(viewer, input.board),
    run(ctx, input) {
      const { agent } = working(ctx.viewer)!;
      const { board } = loaded(ctx.viewer, input.board);
      const design = designFrom(board, input.placements);
      const values = { description: input.description, parameters: JSON.stringify(design.parameters), design: JSON.stringify(design.design) };
      const existing = db.select({ id: blueprints.id }).from(blueprints).where(and(eq(blueprints.agent, agent), eq(blueprints.name, input.name))).get();
      const blueprint = existing?.id ?? 'bp-' + randomUUID();
      if (existing) db.update(blueprints).set(values).where(eq(blueprints.id, blueprint)).run();
      else db.insert(blueprints).values({ id: blueprint, agent, name: input.name, createdAt: at(ctx), ...values }).run();
      ctx.changed('blueprints', blueprint);
      return { blueprint, name: input.name, parameters: design.parameters };
    } }));

  return store;
}
