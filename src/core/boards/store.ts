/** Boards in the household database (docs/specs/boards.md, "Records"). The rules are in model.ts; this file
 * only loads a board, stores what the rules returned, and marks what the agent has been handed. */
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { blueprints, boardChanges, boardPlacements, boards, boardThreads, threads } from '../data/schema.js';
import { cleanLineOf } from '../line-name.js';
import { boardBrief, changeSentences, described, moreChanges, titleSaid } from './brief.js';
import { BLUEPRINTS_MAX, BOARDS_MAX, BOARDS_OPEN_MAX, TOLD_CHANGES_MAX } from './limits.js';
import { live, Refused, type Board, type ChangeRow, type Placement } from './model.js';

export const newBoardId = () => 'bd-' + randomUUID();
export const newPlacementId = () => 'pl-' + randomUUID();

export class BoardStore {
  constructor(readonly db: DataDatabase) {}

  row(id: string) {
    return this.db.select().from(boards).where(eq(boards.id, id)).get();
  }
  private placement(p: typeof boardPlacements.$inferSelect): Placement {
    return { id: p.id, brick: p.brick, params: JSON.parse(p.params) as Record<string, unknown>, rank: p.rank,
      placedByKind: p.placedByKind, removed: p.removedAt !== null, flagged: p.flaggedAt !== null };
  }
  /** A board with its live placements, or nothing if there is no such board. The placements it once had and has
   * no more stay as rows and are not loaded: a board that is changed for years still loads at most PLACEMENTS_MAX. */
  board(id: string): (Board & { thread: string; agentSeen: number }) | undefined {
    const row = this.row(id);
    if (!row) return;
    const placements = this.db.select().from(boardPlacements).where(and(eq(boardPlacements.board, id), isNull(boardPlacements.removedAt))).all()
      .map((p) => this.placement(p));
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

  /** Refuses a board that would join a full trail. Nothing is closed or deleted to make room. */
  roomOnTrail(thread: string): void {
    const open = this.db.select({ n: count() }).from(boards).where(and(eq(boards.thread, thread), isNull(boards.closedAt))).get()!.n;
    if (open >= BOARDS_OPEN_MAX) throw new Refused(`This thread has ${BOARDS_OPEN_MAX} open boards, the most it may have. Close one, or change one that is open.`);
  }
  open(input: { thread: string; title: string; blueprint?: string; at: string }): string {
    this.roomOnTrail(input.thread);
    const all = this.db.select({ n: count() }).from(boards).where(eq(boards.thread, input.thread)).get()!.n;
    if (all >= BOARDS_MAX) throw new Refused(`This thread has had ${BOARDS_MAX} boards, the most it may have. Reopen a closed one (boards.list has them) or change one that is open.`);
    const id = newBoardId();
    this.db.insert(boards).values({ id, thread: input.thread, title: input.title, blueprint: input.blueprint ?? null,
      revision: 1, agentSeen: 0, openedAt: input.at, trailAt: input.at, changedAt: input.at }).run();
    return id;
  }
  /** Stores one revision: the board as the rules left it, and the rows that say what changed. */
  save(before: Board, after: Board, rows: readonly ChangeRow[], at: string, flagged: readonly string[] = []): void {
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
    for (const id of flagged) this.db.update(boardPlacements).set({ flaggedAt: at }).where(eq(boardPlacements.id, id)).run();
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

  private change(r: typeof boardChanges.$inferSelect): ChangeRow {
    // A title stored before the title rule is repeated without what the rule forbids, as `described` does.
    const text = (v: string | null) => (v === null ? undefined : r.change === 'title' ? cleanLineOf(v) : v);
    return { at: r.at, revision: r.revision, seq: r.seq, actorKind: r.actorKind, change: r.change, placement: r.placement ?? undefined,
      from: text(r.from), to: text(r.to), action: r.action ?? undefined,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined };
  }
  /** The rows after revision `since`, oldest first: whole revisions only, `limit` rows at most, and whether there
   * are more. A caller reads on from the last revision it was given. */
  changes(board: string, since: number, limit: number): { rows: ChangeRow[]; more: boolean } {
    const rows = this.db.select().from(boardChanges).where(and(eq(boardChanges.board, board), gt(boardChanges.revision, since)))
      .orderBy(asc(boardChanges.revision), asc(boardChanges.seq)).limit(limit + 1).all();
    if (rows.length <= limit) return { rows: rows.map((r) => this.change(r)), more: false };
    const cut = rows[limit].revision;
    return { rows: rows.filter((r) => r.revision < cut).map((r) => this.change(r)), more: true };
  }
  /** The member's latest changes the agent has not been handed, oldest first, TOLD_CHANGES_MAX at most; how many
   * earlier ones there are; and the board with the removed placements those changes name, so each can be said. */
  private unseen(board: Board & { agentSeen: number }) {
    const mine = and(eq(boardChanges.board, board.id), gt(boardChanges.revision, board.agentSeen), eq(boardChanges.actorKind, 'member'));
    const rows = this.db.select().from(boardChanges).where(mine).orderBy(desc(boardChanges.revision), desc(boardChanges.seq))
      .limit(TOLD_CHANGES_MAX).all().reverse().map((r) => this.change(r));
    const more = rows.length < TOLD_CHANGES_MAX ? 0 : this.db.select({ n: count() }).from(boardChanges).where(mine).get()!.n - rows.length;
    const have = new Set(board.placements.map((p) => p.id));
    const gone = [...new Set(rows.map((r) => r.placement).filter((id): id is string => !!id && !have.has(id)))];
    const named = gone.length ? this.db.select().from(boardPlacements).where(and(eq(boardPlacements.board, board.id), inArray(boardPlacements.id, gone))).all().map((p) => this.placement(p)) : [];
    return { board: { ...board, placements: [...board.placements, ...named] }, unseen: rows, more };
  }
  /** The member looked at a flagged placement. Not a change to the board: no row, no revision. */
  seen(board: string, placement: string): boolean {
    return this.db.update(boardPlacements).set({ flaggedAt: null })
      .where(and(eq(boardPlacements.board, board), eq(boardPlacements.id, placement))).run().changes > 0;
  }
  /** What every agent call that takes a board returns with its result. Marks the member's changes as handed over. */
  handed(id: string) {
    const board = this.board(id);
    if (!board) throw new Refused('There is no such board in this thread.');
    const told = this.unseen(board);
    const meanwhile = [...changeSentences(told.board, told.unseen), ...(told.more ? [moreChanges(told.more)] : [])];
    this.db.update(boards).set({ agentSeen: board.revision }).where(eq(boards.id, id)).run();
    return { board: id, title: titleSaid(board.title), revision: board.revision, closed: board.closed,
      placements: live(board).map((p) => ({ placement: p.id, brick: p.brick, params: p.params, rank: p.rank, flagged: !!p.flagged })),
      described: described(board), meanwhile };
  }
  /** The brief a job is handed at start: the shown board, and the member changes in the thread the agent has
   * not been told (the latest TOLD_CHANGES_MAX, and a count of the rest). Marks them told. The shown board is the
   * one the member last sent from, or the newest on the trail. Only the shown board and the boards with something
   * untold are loaded. */
  takeBrief(thread: string): string {
    const all = this.inThread(thread);
    // The board the member last sent from, unless one has joined the trail since.
    const latest = (b: (typeof all)[number]) => (b.shownAt && b.shownAt > b.trailAt ? b.shownAt : b.closedAt ? '' : b.trailAt);
    const shownRow = all.filter((b) => latest(b)).sort((a, b) => latest(a).localeCompare(latest(b)) || a.id.localeCompare(b.id)).at(-1);
    const loaded = all.filter((row) => row.agentSeen < row.revision || row.id === shownRow?.id).map((row) => this.unseen(this.board(row.id)!));
    const text = boardBrief(shownRow ? loaded.find((l) => l.board.id === shownRow.id)!.board : null, loaded);
    for (const { board, unseen, more } of loaded)
      if (unseen.length || more || board.id === shownRow?.id)
        this.db.update(boards).set({ agentSeen: board.revision }).where(eq(boards.id, board.id)).run();
    return text;
  }

  /** Whether the thread's member uses the page that shows boards. Only then is an agent offered them. */
  attended(thread: string): boolean {
    return !!this.db.select({ thread: boardThreads.thread }).from(boardThreads).where(eq(boardThreads.thread, thread)).get();
  }
  /** The member sent from the page that shows boards, with this board on screen or none. */
  sentFrom(thread: string, board: string | null, at: string): void {
    this.db.insert(boardThreads).values({ thread, since: at }).onConflictDoNothing().run();
    if (board) this.show(thread, board, at);
  }
  /** The member sent a message while looking at this board. */
  show(thread: string, board: string, at: string): void {
    const row = this.row(board);
    if (!row || row.thread !== thread) throw new Refused('That board is not in this thread.');
    this.db.update(boards).set({ shownAt: at }).where(eq(boards.id, board)).run();
  }

  /** A blueprint belongs to an agent and a member: the member of the thread it was saved in. */
  blueprintsOf(agent: string, member: string) {
    return this.db.select().from(blueprints).where(and(eq(blueprints.agent, agent), eq(blueprints.member, member))).orderBy(asc(blueprints.name)).all();
  }
  blueprint(agent: string, member: string, id: string) {
    return this.db.select().from(blueprints).where(and(eq(blueprints.id, id), eq(blueprints.agent, agent), eq(blueprints.member, member))).get();
  }
  usedBlueprint(id: string, at: string): void {
    const row = this.db.select({ uses: blueprints.uses }).from(blueprints).where(eq(blueprints.id, id)).get();
    if (row) this.db.update(blueprints).set({ usedAt: at, uses: row.uses + 1 }).where(eq(blueprints.id, id)).run();
  }
  /** Saves under a name: a name this agent already uses for this member is replaced and keeps its id and uses. */
  saveBlueprint(input: { agent: string; member: string; name: string; description: string; parameters: string; design: string; at: string; newId: () => string }): string {
    const { agent, member, name, at, newId, ...values } = input;
    const mine = and(eq(blueprints.agent, agent), eq(blueprints.member, member));
    const existing = this.db.select({ id: blueprints.id }).from(blueprints).where(and(mine, eq(blueprints.name, name))).get();
    if (existing) { this.db.update(blueprints).set(values).where(eq(blueprints.id, existing.id)).run(); return existing.id; }
    if (this.db.select({ n: count() }).from(blueprints).where(mine).get()!.n >= BLUEPRINTS_MAX)
      throw new Refused(`There are ${BLUEPRINTS_MAX} blueprints for this member, the most there may be. Save under the name of one that is no longer needed: that replaces it.`);
    const id = newId();
    this.db.insert(blueprints).values({ id, agent, member, name, createdAt: at, ...values }).run();
    return id;
  }
}
