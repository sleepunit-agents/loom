/** Boards in the household database (docs/specs/boards.md, "Records"). The rules are in model.ts; this file
 * only loads a board, stores what the rules returned, and marks what the agent has been handed. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { blueprints, boardChanges, boardPlacements, boards, threads } from '../data/schema.js';
import { boardBrief, changeSentences, described } from './brief.js';
import { live, Refused, type Board, type ChangeRow, type Placement } from './model.js';

export const newBoardId = () => 'bd-' + randomUUID();
export const newPlacementId = () => 'pl-' + randomUUID();

export class BoardStore {
  constructor(readonly db: DataDatabase) {}

  row(id: string) {
    return this.db.select().from(boards).where(eq(boards.id, id)).get();
  }
  /** A board with every placement it has had, or nothing if there is no such board. */
  board(id: string): (Board & { thread: string; agentSeen: number }) | undefined {
    const row = this.row(id);
    if (!row) return;
    const placements: Placement[] = this.db.select().from(boardPlacements).where(eq(boardPlacements.board, id)).all()
      .map((p) => ({ id: p.id, brick: p.brick, params: JSON.parse(p.params) as Record<string, unknown>, rank: p.rank,
        placedByKind: p.placedByKind, removed: p.removedAt !== null }));
    return { id: row.id, title: row.title, revision: row.revision, closed: row.closedAt !== null, placements,
      thread: row.thread, agentSeen: row.agentSeen };
  }
  /** A thread's boards, in trail order: the open ones as they last joined, then the closed. */
  inThread(thread: string) {
    return this.db.select().from(boards).where(eq(boards.thread, thread)).orderBy(asc(boards.trailAt), asc(boards.id)).all();
  }
  trail(thread: string) {
    return this.db.select().from(boards).where(and(eq(boards.thread, thread), isNull(boards.closedAt)))
      .orderBy(asc(boards.trailAt), asc(boards.id)).all();
  }
  threadOfConversation(conversation: string) {
    return this.db.select({ id: threads.id }).from(threads).where(eq(threads.conversation, conversation)).get()?.id;
  }

  open(input: { thread: string; title: string; blueprint?: string; at: string }): string {
    const id = newBoardId();
    this.db.insert(boards).values({ id, thread: input.thread, title: input.title, blueprint: input.blueprint ?? null,
      revision: 1, agentSeen: 0, openedAt: input.at, trailAt: input.at, changedAt: input.at }).run();
    return id;
  }
  /** Stores one revision: the board as the rules left it, and the rows that say what changed. */
  save(before: Board, after: Board, rows: readonly ChangeRow[], at: string): void {
    const known = new Set(before.placements.map((p) => p.id));
    for (const p of after.placements) {
      if (!known.has(p.id))
        this.db.insert(boardPlacements).values({ id: p.id, board: after.id, brick: p.brick, params: JSON.stringify(p.params),
          rank: p.rank, placedByKind: p.placedByKind, placedAt: at, removedAt: p.removed ? at : null }).run();
      else {
        const old = before.placements.find((o) => o.id === p.id)!;
        if (old.rank !== p.rank || old.removed !== p.removed)
          this.db.update(boardPlacements).set({ rank: p.rank, ...(p.removed && !old.removed ? { removedAt: at } : {}) })
            .where(eq(boardPlacements.id, p.id)).run();
      }
    }
    this.db.update(boards).set({ title: after.title, revision: after.revision, changedAt: at }).where(eq(boards.id, after.id)).run();
    this.log(after.id, rows, at);
  }
  log(board: string, rows: readonly ChangeRow[], at: string): void {
    for (const r of rows)
      this.db.insert(boardChanges).values({ board, revision: r.revision, seq: r.seq, at, actorKind: r.actorKind, change: r.change,
        placement: r.placement ?? null, from: r.from === undefined ? null : String(r.from), to: r.to === undefined ? null : String(r.to),
        action: r.action ?? null, detail: r.detail ? JSON.stringify(r.detail) : null }).run();
  }
  /** One row that changes nothing but the board's own state: a close, a reopen, or a reported action. */
  stamp(board: Board, row: ChangeRow, at: string, set: { closedAt?: string | null; trailAt?: string } = {}): number {
    this.db.update(boards).set({ revision: row.revision, changedAt: at, ...set }).where(eq(boards.id, board.id)).run();
    this.log(board.id, [row], at);
    return row.revision;
  }

  changes(board: string, since = 0): ChangeRow[] {
    return this.db.select().from(boardChanges).where(and(eq(boardChanges.board, board), gt(boardChanges.revision, since)))
      .orderBy(asc(boardChanges.revision), asc(boardChanges.seq)).all()
      .map((r) => ({ revision: r.revision, seq: r.seq, actorKind: r.actorKind, change: r.change, placement: r.placement ?? undefined,
        from: r.from ?? undefined, to: r.to ?? undefined, action: r.action ?? undefined,
        detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined }));
  }
  /** What every agent call that takes a board returns with its result. Marks the member's changes as handed over. */
  handed(id: string) {
    const board = this.board(id);
    if (!board) throw new Refused('There is no such board in this thread.');
    const meanwhile = changeSentences(board, this.changes(id, board.agentSeen));
    this.db.update(boards).set({ agentSeen: board.revision }).where(eq(boards.id, id)).run();
    return { board: id, title: board.title, revision: board.revision, closed: board.closed,
      placements: live(board).map((p) => ({ placement: p.id, brick: p.brick, params: p.params, rank: p.rank })),
      described: described(board), meanwhile };
  }
  /** The brief a job is handed at start: the shown board, and every member change in the thread the agent has
   * not been told. Marks them told. The shown board is the one the member last sent from, or the newest on the trail. */
  takeBrief(thread: string): string {
    const all = this.inThread(thread);
    // The board the member last sent from, unless one has joined the trail since.
    const latest = (b: (typeof all)[number]) => (b.shownAt && b.shownAt > b.trailAt ? b.shownAt : b.closedAt ? '' : b.trailAt);
    const shownRow = all.filter((b) => latest(b)).sort((a, b) => latest(a).localeCompare(latest(b)) || a.id.localeCompare(b.id)).at(-1);
    const loaded = all.map((row) => {
      const board = this.board(row.id)!;
      return { board, unseen: this.changes(row.id, board.agentSeen) };
    });
    const text = boardBrief(shownRow ? loaded.find((l) => l.board.id === shownRow.id)!.board : null, loaded);
    for (const { board, unseen } of loaded)
      if (unseen.length || board.id === shownRow?.id)
        this.db.update(boards).set({ agentSeen: board.revision }).where(eq(boards.id, board.id)).run();
    return text;
  }

  /** The member sent a message while looking at this board. */
  show(thread: string, board: string, at: string): void {
    const row = this.row(board);
    if (!row || row.thread !== thread) throw new Refused('That board is not in this thread.');
    this.db.update(boards).set({ shownAt: at }).where(eq(boards.id, board)).run();
  }

  blueprintsOf(agent: string) {
    return this.db.select().from(blueprints).where(eq(blueprints.agent, agent)).orderBy(asc(blueprints.name)).all();
  }
}
