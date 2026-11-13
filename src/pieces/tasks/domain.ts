// taskstore-core reference implementation — the pure transition function.
// apply: (state, command) -> {result, state}. No I/O, no wall clock, no
// invented attribution: everything observable is determined by the command
// sequence (it-ts-model). Persistence, CLI, and scheduling are bindings.

export type TaskType = "task" | "bug" | "feature" | "epic";
export type TaskStatus = "open" | "in_progress" | "closed";
export type LinkType = "blocks" | "parent-child";

export interface Comment {
  actor: string;
  at: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  createdAt: string;
  createdBy: string;
  comments: Comment[];
  description?: string;
  assignee?: string;
  startedAt?: string;
  closedAt?: string;
  closeReason?: string;
  legacyRef?: string;
  specItemRef?: string;
  criterionId?: string;
  // The plain summary (it-ts-plain): what's true when it's done, why it
  // matters, and how we'll know. Every task should carry one; none is required.
  goal?: string;
  why?: string;
  doneWhen?: string;
  // The owner's ask (it-ts-plain): the one question a person answers, what
  // happens either way, and how it's answered. askedBy is stamped from the
  // command that set the ask, so an answer can go back to whoever asked.
  ask?: string;
  ifYes?: string;
  ifNo?: string;
  answers?: Answers;
  askedBy?: string;
  // Where the work came from (it-ts-source): <kind>:<value>, like
  // conversation:cv-0123456789ab, the conversation a body made or changed it in.
  source?: string;
}

export type Answers = "yes-no" | "words";

export interface Link {
  id: string;
  dependsOn: string;
  type: LinkType;
}

export interface StoreState {
  tasks: Task[];
  links: Link[];
  seq: number;
}

export const emptyState = (): StoreState => ({ tasks: [], links: [], seq: 0 });

export type Command = { op: string } & Record<string, unknown>;
export type Result = Record<string, unknown>;

const TYPES: readonly string[] = ["task", "bug", "feature", "epic"];
const STATUSES: readonly string[] = ["open", "in_progress", "closed"];
const LINK_TYPES: readonly string[] = ["blocks", "parent-child"];
const ANSWERS: readonly string[] = ["yes-no", "words"];
/** The plain summary and the ask: optional strings an update clears with "". */
export const PLAIN_FIELDS = ["goal", "why", "doneWhen", "ask", "ifYes", "ifNo", "answers"] as const;
/** Held only beside an ask. */
const ASK_PARTS = ["ifYes", "ifNo", "answers"] as const;
const UPDATABLE: readonly string[] = ["assignee", "description", "priority", "title", ...PLAIN_FIELDS, "source"];
/** A source (it-ts-source): a kind (lowercase letters, digits and -, a letter first, at most 32), a colon, and 1-200 non-space characters. */
export const SOURCE = /^[a-z][a-z0-9-]{0,31}:\S{1,200}$/;
/** The fields `search` matches (and loom's page's "Find a task", src/loom-ui.ts). */
export const SEARCH_FIELDS: readonly string[] = [
  "id", "title", "description", "specItemRef", "criterionId", "legacyRef", "goal", "why", "ask",
];

// "Parseable" per felag-core it-verification's Timestamps rule (incorporated
// by reference in it-ts-model): RFC 3339 date-time, case-insensitive T/Z,
// numeric offset or Z REQUIRED, second 60 excluded.
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function parseable(s: string): boolean {
  const m = RFC3339.exec(s);
  if (!m) return false;
  // RFC 3339's ABNF bounds every field (time-hour 00-23, date-mday by month
  // and leap year, time-numoffset hours 00-23). Date.parse is not a check:
  // V8 accepts T24:00:00 and 2026-02-30 (cold review t-720, measured).
  const [y, mo, d] = s.slice(0, 10).split("-").map(Number);
  const [h, mi, se] = [m[1], m[2], m[3]].map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const mdays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > mdays[mo - 1]) return false;
  if (h > 23 || mi > 59 || se > 59) return false;
  if (m[5].length === 6 && (Number(m[5].slice(1, 3)) > 23 || Number(m[5].slice(4, 6)) > 59)) return false;
  return true;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isPriority = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Errs {
  private codes = new Set<string>();
  add(code: string): void {
    this.codes.add(code);
  }
  get any(): boolean {
    return this.codes.size > 0;
  }
  list(): string[] {
    return [...this.codes].sort();
  }
}

/** Required string field: absent or mistyped -> E_MISSING_FIELD. */
function reqString(errs: Errs, v: unknown): v is string {
  if (!isString(v)) {
    errs.add("E_MISSING_FIELD");
    return false;
  }
  return true;
}

/** Required timestamp: E_MISSING_FIELD when absent/mistyped, E_BAD_TIMESTAMP when unparseable. */
function reqAt(errs: Errs, v: unknown): boolean {
  if (!reqString(errs, v)) return false;
  if (!parseable(v)) {
    errs.add("E_BAD_TIMESTAMP");
    return false;
  }
  return true;
}

/** Optional string field: present but mistyped -> E_BAD_FIELD. */
function optString(errs: Errs, v: unknown): boolean {
  if (v !== undefined && !isString(v)) {
    errs.add("E_BAD_FIELD");
    return false;
  }
  return true;
}

/**
 * The plain fields, as given: optional strings (E_BAD_FIELD otherwise), and
 * answers one of its two words when it's non-empty ("" clears on update).
 */
function checkPlain(errs: Errs, c: Record<string, unknown>): void {
  for (const f of PLAIN_FIELDS) optString(errs, c[f]);
  if (isString(c.answers) && c.answers !== "" && !ANSWERS.includes(c.answers)) errs.add("E_BAD_FIELD");
}

/** source, as given: absent, "" (absent on create, a clear on update), or a well-formed <kind>:<value>. */
function checkSource(errs: Errs, v: unknown): void {
  if (v === undefined || v === "") return;
  if (!isString(v) || !SOURCE.test(v)) errs.add("E_BAD_FIELD");
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// Collision-free: absent criterionId (null) is distinct from "" and no
// separator character can make two different pairs spell the same key.
const linkageKey = (specItemRef: string, criterionId: string | undefined): string =>
  JSON.stringify([specItemRef, criterionId ?? null]);

// Ascending Unicode code-point order (it-ts-query's report sort). JavaScript's
// `<` compares UTF-16 code units, which disagrees above U+FFFF.
function cmpCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

function findTask(state: StoreState, id: string): Task | undefined {
  return state.tasks.find((t) => t.id === id);
}

/** Would adding edge from->to create a directed cycle in `type`'s graph? */
function wouldCycle(links: Link[], from: string, to: string, type: LinkType): boolean {
  if (from === to) return true;
  // cycle iff `to` already reaches `from` along type edges (id -> dependsOn)
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of links) if (l.type === type && l.id === cur) stack.push(l.dependsOn);
  }
  return false;
}

function blockedIds(state: StoreState): Set<string> {
  const blocked = new Set<string>();
  for (const l of state.links) {
    if (l.type !== "blocks") continue;
    const blocker = findTask(state, l.dependsOn);
    if (blocker && blocker.status !== "closed") blocked.add(l.id);
  }
  return blocked;
}

function showShape(state: StoreState, t: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { ...t };
  out.dependsOn = state.links
    .filter((l) => l.type === "blocks" && l.id === t.id)
    .map((l) => l.dependsOn);
  const parent = state.links.find((l) => l.type === "parent-child" && l.id === t.id);
  if (parent) out.parent = parent.dependsOn;
  return out;
}

function listEntry(state: StoreState, t: Task): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: t.id,
    priority: t.priority,
    status: t.status,
    title: t.title,
    type: t.type,
  };
  const parent = state.links.find((l) => l.type === "parent-child" && l.id === t.id);
  if (parent) entry.parent = parent.dependsOn;
  if (t.goal !== undefined) entry.goal = t.goal;
  return entry;
}

const contractStatus = (t: Task): string =>
  t.status === "closed" ? (t.closeReason === "cancelled" ? "cancelled" : "done") : t.status;

function freshId(state: StoreState): string {
  let id: string;
  do {
    state.seq += 1;
    id = `t-${state.seq}`;
  } while (findTask(state, id) !== undefined);
  return id;
}

// ------------------------------------------------------------------ apply

export function apply(prev: StoreState, command: Command): { result: Result; state: StoreState } {
  const state = clone(prev);
  const result = dispatch(state, command);
  // Per-command atomicity: any error means the state is unchanged.
  if (result.ok === false) return { result, state: prev };
  return { result, state };
}

function dispatch(state: StoreState, c: Command): Result {
  switch (c.op) {
    case "create":
      return doCreate(state, c);
    case "claim":
      return doLifecycle(state, c, "claim");
    case "unclaim":
      return doLifecycle(state, c, "unclaim");
    case "close":
      return doLifecycle(state, c, "close");
    case "reopen":
      return doLifecycle(state, c, "reopen");
    case "delete":
      return doDelete(state, c);
    case "update":
      return doUpdate(state, c);
    case "comment":
      return doComment(state, c);
    case "link":
      return doLink(state, c);
    case "unlink":
      return doUnlink(state, c);
    case "show":
      return doShow(state, c);
    case "list":
      return doList(state, c);
    case "search":
      return doSearch(state, c);
    case "ready":
      return doReady(state);
    case "report":
      return doReport(state);
    case "export":
      return doExport(state);
    case "import":
      return doImport(state, c);
    default:
      return { errors: ["E_BAD_FIELD"], ok: false };
  }
}

function doCreate(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.title);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  optString(errs, c.description);
  optString(errs, c.parent);
  optString(errs, c.specItemRef);
  optString(errs, c.criterionId);
  optString(errs, c.legacyRef);
  checkPlain(errs, c);
  checkSource(errs, c.source);
  if (!(isString(c.ask) && c.ask !== "") && ASK_PARTS.some((f) => isString(c[f]) && c[f] !== "")) errs.add("E_MISSING_FIELD");
  if (c.type !== undefined && !(isString(c.type) && TYPES.includes(c.type)))
    errs.add("E_BAD_TYPE");
  if (c.priority !== undefined && !isPriority(c.priority)) errs.add("E_BAD_PRIORITY");
  if (c.criterionId !== undefined && c.specItemRef === undefined) errs.add("E_MISSING_FIELD");
  if (isString(c.parent) && findTask(state, c.parent) === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { created: false, errors: errs.list(), id: null, ok: false };

  // Linkage idempotency: a held (specItemRef, criterionId) key returns the
  // existing task, whatever its status; the new proposal is discarded.
  if (isString(c.specItemRef)) {
    const key = linkageKey(c.specItemRef, c.criterionId as string | undefined);
    const existing = state.tasks.find(
      (t) => t.specItemRef !== undefined && linkageKey(t.specItemRef, t.criterionId) === key,
    );
    if (existing) return { created: false, errors: [], id: existing.id, ok: true };
  }

  const id = freshId(state);
  const task: Task = {
    id,
    title: c.title as string,
    type: (c.type as TaskType | undefined) ?? "task",
    status: "open",
    priority: (c.priority as number | undefined) ?? 2,
    createdAt: c.at as string,
    createdBy: c.actor as string,
    comments: [],
  };
  if (c.description !== undefined) task.description = c.description as string;
  if (c.legacyRef !== undefined) task.legacyRef = c.legacyRef as string;
  if (c.specItemRef !== undefined) task.specItemRef = c.specItemRef as string;
  if (c.criterionId !== undefined) task.criterionId = c.criterionId as string;
  for (const f of PLAIN_FIELDS) if (isString(c[f]) && c[f] !== "") (task as unknown as Record<string, unknown>)[f] = c[f];
  if (task.ask !== undefined) task.askedBy = c.actor as string;
  if (isString(c.source) && c.source !== "") task.source = c.source;
  state.tasks.push(task);
  if (isString(c.parent)) state.links.push({ id, dependsOn: c.parent, type: "parent-child" });
  return { created: true, errors: [], id, ok: true };
}

function doLifecycle(state: StoreState, c: Command, kind: "claim" | "unclaim" | "close" | "reopen"): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  if (kind === "close") optString(errs, c.reason);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  // Transition legality interrogates the referent: evaluated only when the
  // task exists; co-fires with any field errors (it-ts-lifecycle).
  if (task) {
    if (kind === "claim" && task.status !== "open") errs.add("E_BAD_TRANSITION");
    if (kind === "unclaim" && task.status !== "in_progress") errs.add("E_BAD_TRANSITION");
    if (kind === "close" && task.status === "closed") errs.add("E_BAD_TRANSITION");
    if (kind === "reopen" && task.status !== "closed") errs.add("E_BAD_TRANSITION");
  }
  if (errs.any) return { errors: errs.list(), ok: false };

  const t = task!;
  if (kind === "claim") {
    t.status = "in_progress";
    t.assignee = c.actor as string;
    t.startedAt = c.at as string;
  } else if (kind === "unclaim") {
    t.status = "open";
    delete t.startedAt;
    delete t.assignee;
  } else if (kind === "close") {
    t.status = "closed";
    t.closedAt = c.at as string;
    // A close without a reason clears any stray closeReason (an imported open
    // record may carry one), so report never reads a reason this close did not give.
    if (c.reason !== undefined) t.closeReason = c.reason as string;
    else delete t.closeReason;
  } else {
    t.status = "open";
    delete t.startedAt;
    delete t.assignee;
    delete t.closedAt;
    delete t.closeReason;
  }
  return { errors: [], ok: true };
}

function doDelete(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false };
  // Hard removal — the escape hatch for an erroneously-created task (there is
  // no other way to take one out of the store). Cascades every link the task
  // participated in (either endpoint), so the graph stays consistent: a deleted
  // blocker unblocks its dependents, a deleted parent frees its children.
  state.tasks = state.tasks.filter((t) => t.id !== c.id);
  state.links = state.links.filter((l) => l.id !== c.id && l.dependsOn !== c.id);
  return { errors: [], ok: true };
}

function doUpdate(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  if (!isPlainObject(c.set) || Object.keys(c.set).length === 0) {
    errs.add("E_MISSING_FIELD");
  } else {
    for (const [k, v] of Object.entries(c.set)) {
      if (!UPDATABLE.includes(k)) errs.add("E_BAD_FIELD");
      else if (k === "priority") {
        if (!isPriority(v)) errs.add("E_BAD_PRIORITY");
      } else if (!isString(v)) errs.add("E_BAD_FIELD");
    }
    checkPlain(errs, c.set);
    checkSource(errs, c.set.source);
  }
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  // An if-yes, if-no or answers is held only beside an ask: the task's own,
  // or one this update sets (clearing the ask clears them with it).
  if (task && isPlainObject(c.set)) {
    const set = c.set;
    const askAfter = set.ask !== undefined ? set.ask : task.ask;
    if (!(isString(askAfter) && askAfter !== "") && ASK_PARTS.some((f) => isString(set[f]) && set[f] !== ""))
      errs.add("E_MISSING_FIELD");
  }
  if (errs.any) return { errors: errs.list(), ok: false };

  const set = c.set as Record<string, unknown>;
  const t = task!;
  const tr = t as unknown as Record<string, unknown>;
  if (set.title !== undefined) t.title = set.title as string;
  if (set.description !== undefined) t.description = set.description as string;
  if (set.priority !== undefined) t.priority = set.priority as number;
  if (set.assignee !== undefined) t.assignee = set.assignee as string;
  if (set.ask === "") for (const f of [...ASK_PARTS, "ask", "askedBy"]) delete tr[f];
  for (const f of PLAIN_FIELDS) {
    if (set[f] === undefined || (f === "ask" && set.ask === "")) continue;
    if (set[f] === "") delete tr[f];
    else tr[f] = set[f];
  }
  if (isString(set.ask) && set.ask !== "") t.askedBy = c.actor as string;
  if (set.source === "") delete t.source;
  else if (isString(set.source)) t.source = set.source;
  return { errors: [], ok: true };
}

function doComment(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  reqString(errs, c.text);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false };
  task!.comments.push({ actor: c.actor as string, at: c.at as string, text: c.text as string });
  return { errors: [], ok: true };
}

function doLink(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.dependsOn);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  let type: LinkType | undefined;
  if (c.type === undefined) errs.add("E_MISSING_FIELD");
  else if (!isString(c.type) || !LINK_TYPES.includes(c.type)) errs.add("E_BAD_TYPE");
  else type = c.type as LinkType;
  const from = isString(c.id) ? findTask(state, c.id) : undefined;
  const to = isString(c.dependsOn) ? findTask(state, c.dependsOn) : undefined;
  if ((isString(c.id) && from === undefined) || (isString(c.dependsOn) && to === undefined))
    errs.add("E_UNKNOWN_ID");

  // Referent-interrogating checks: need both referents and a valid type.
  if (from && to && type) {
    const dup = state.links.some(
      (l) => l.id === from.id && l.dependsOn === to.id && l.type === type,
    );
    if (dup) {
      if (errs.any) return { errors: errs.list(), linked: false, ok: false };
      return { errors: [], ok: true, linked: false }; // accepted no-op, precedes all semantic checks
    }
    if (
      type === "parent-child" &&
      state.links.some((l) => l.type === "parent-child" && l.id === from.id)
    )
      errs.add("E_HAS_PARENT");
    if (wouldCycle(state.links, from.id, to.id, type)) errs.add("E_CYCLE");
  }
  if (errs.any) return { errors: errs.list(), linked: false, ok: false };
  state.links.push({ id: from!.id, dependsOn: to!.id, type: type! });
  return { errors: [], ok: true, linked: true };
}

// link's inverse. Validation is link's, verbatim — the same required fields,
// the same vocabulary, the same referent rules — because an inverse that
// accepts a command link would have rejected is not an inverse. No graph
// checks: removing an edge can neither close a cycle nor give a task a
// second parent.
//
// An unlink naming no held edge is ACCEPTED and changes nothing, mirroring
// link's treatment of a duplicate. Both are idempotent, which is what a store
// whose exit door is a replayable mirror needs; the inverse is exact over held
// referents and deliberately not total (it-ts-links). The no-op is not silent, though: removed distinguishes the
// removal from the miss exactly as created distinguishes a fresh task from
// an idempotent hit. A caller who reversed the direction sees removed false
// rather than a success it can mistake for a repair.
function doUnlink(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  reqString(errs, c.dependsOn);
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  let type: LinkType | undefined;
  if (c.type === undefined) errs.add("E_MISSING_FIELD");
  else if (!isString(c.type) || !LINK_TYPES.includes(c.type)) errs.add("E_BAD_TYPE");
  else type = c.type as LinkType;
  const from = isString(c.id) ? findTask(state, c.id) : undefined;
  const to = isString(c.dependsOn) ? findTask(state, c.dependsOn) : undefined;
  if ((isString(c.id) && from === undefined) || (isString(c.dependsOn) && to === undefined))
    errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false, removed: false };

  const before = state.links.length;
  state.links = state.links.filter(
    (l) => !(l.id === from!.id && l.dependsOn === to!.id && l.type === type!),
  );
  return { errors: [], ok: true, removed: state.links.length < before };
}

function doShow(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.id);
  const task = isString(c.id) ? findTask(state, c.id) : undefined;
  if (isString(c.id) && task === undefined) errs.add("E_UNKNOWN_ID");
  if (errs.any) return { errors: errs.list(), ok: false, task: null };
  return { errors: [], ok: true, task: showShape(state, task!) };
}

function doList(state: StoreState, c: Command): Result {
  if (c.status !== undefined && !(isString(c.status) && STATUSES.includes(c.status)))
    return { entries: [], errors: ["E_BAD_FIELD"], ok: false };
  const entries = state.tasks
    .filter((t) => c.status === undefined || t.status === c.status)
    .map((t) => listEntry(state, t));
  return { entries, errors: [], ok: true };
}

function doSearch(state: StoreState, c: Command): Result {
  const errs = new Errs();
  if (!isString(c.q)) errs.add("E_MISSING_FIELD");
  if (c.status !== undefined && !(isString(c.status) && STATUSES.includes(c.status)))
    errs.add("E_BAD_FIELD");
  if (errs.any || !isString(c.q)) return { entries: [], errors: errs.list(), ok: false };
  // Case-insensitive substring match over the text-bearing fields (the retrieval
  // `list` lacks — it filters only by status). Same listEntry shape as list/ready.
  const q = c.q.toLowerCase();
  const entries = state.tasks
    .filter((t) => c.status === undefined || t.status === c.status)
    .filter((t) =>
      SEARCH_FIELDS.some((f) => {
        const v = (t as unknown as Record<string, unknown>)[f];
        return isString(v) && v.toLowerCase().includes(q);
      }),
    )
    .map((t) => listEntry(state, t));
  return { entries, errors: [], ok: true };
}

function doReady(state: StoreState): Result {
  const blocked = blockedIds(state);
  const entries = state.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status === "open" && t.type !== "epic" && !blocked.has(t.id))
    .sort((a, b) => a.t.priority - b.t.priority || a.i - b.i)
    .map(({ t }) => ({ id: t.id, priority: t.priority, title: t.title, type: t.type, ...(t.goal !== undefined ? { goal: t.goal } : {}) }));
  return { entries, errors: [], ok: true };
}

function doReport(state: StoreState): Result {
  const entries = state.tasks
    .filter((t) => t.specItemRef !== undefined)
    .map((t) => ({
      ...(t.criterionId !== undefined ? { criterionId: t.criterionId } : {}),
      specItemRef: t.specItemRef!,
      status: contractStatus(t),
      taskRef: t.id,
    }))
    .sort((a, b) => {
      if (a.specItemRef !== b.specItemRef) return cmpCodePoints(a.specItemRef, b.specItemRef);
      if (a.criterionId !== b.criterionId) {
        if (a.criterionId === undefined) return -1; // absent sorts before any present value, "" included
        if (b.criterionId === undefined) return 1;
        return cmpCodePoints(a.criterionId, b.criterionId);
      }
      return cmpCodePoints(a.taskRef, b.taskRef);
    });
  return { entries, errors: [], ok: true };
}

function doExport(state: StoreState): Result {
  return {
    errors: [],
    links: clone(state.links),
    ok: true,
    tasks: state.tasks.map((t) => clone(t)),
  };
}

function doImport(state: StoreState, c: Command): Result {
  const errs = new Errs();
  reqString(errs, c.actor);
  reqAt(errs, c.at);
  // All-applicable: a non-array tasks does not stop the envelope and links checks.
  if (!Array.isArray(c.tasks)) errs.add("E_MISSING_FIELD");
  if (c.links !== undefined && !Array.isArray(c.links)) errs.add("E_BAD_FIELD");
  const payloadLinks = Array.isArray(c.links) ? c.links : [];

  const payloadIds = new Set<string>();
  const payloadKeys = new Set<string>();
  const heldKeys = new Set(
    state.tasks
      .filter((t) => t.specItemRef !== undefined)
      .map((t) => linkageKey(t.specItemRef!, t.criterionId)),
  );

  for (const raw of Array.isArray(c.tasks) ? c.tasks : []) {
    if (!isPlainObject(raw)) {
      errs.add("E_MISSING_FIELD");
      continue;
    }
    const r = raw;
    for (const f of ["createdAt", "createdBy", "id", "title"])
      if (!isString(r[f])) errs.add("E_MISSING_FIELD");
    if (r.type === undefined) errs.add("E_MISSING_FIELD");
    else if (!isString(r.type) || !TYPES.includes(r.type)) errs.add("E_BAD_TYPE");
    if (r.status === undefined) errs.add("E_MISSING_FIELD");
    else if (!isString(r.status) || !STATUSES.includes(r.status)) errs.add("E_BAD_FIELD");
    if (r.priority === undefined) errs.add("E_MISSING_FIELD");
    else if (!isPriority(r.priority)) errs.add("E_BAD_PRIORITY");
    for (const f of ["createdAt", "startedAt", "closedAt"]) {
      const v = r[f];
      if (v === undefined) continue;
      if (!isString(v)) {
        if (f !== "createdAt") errs.add("E_BAD_FIELD");
      } else if (!parseable(v)) errs.add("E_BAD_TIMESTAMP");
    }
    for (const f of ["description", "assignee", "closeReason", "legacyRef", "specItemRef", "criterionId", "askedBy"])
      optString(errs, r[f]);
    checkPlain(errs, r);
    // A held source is never empty, so an imported one isn't either.
    if (r.source !== undefined && (r.source === "" || !isString(r.source) || !SOURCE.test(r.source))) errs.add("E_BAD_FIELD");
    if (r.criterionId !== undefined && r.specItemRef === undefined) errs.add("E_MISSING_FIELD");
    if (r.parent !== undefined || r.dependsOn !== undefined) errs.add("E_BAD_FIELD");
    if (r.comments !== undefined) {
      if (!Array.isArray(r.comments)) errs.add("E_BAD_FIELD");
      else
        for (const cm of r.comments) {
          if (!isPlainObject(cm)) {
            errs.add("E_MISSING_FIELD");
            continue;
          }
          for (const f of ["actor", "text"]) if (!isString(cm[f])) errs.add("E_MISSING_FIELD");
          if (!isString(cm.at)) errs.add("E_MISSING_FIELD");
          else if (!parseable(cm.at)) errs.add("E_BAD_TIMESTAMP");
        }
    }
    if (isString(r.id)) {
      if (payloadIds.has(r.id) || findTask(state, r.id) !== undefined) errs.add("E_DUP_ID");
      payloadIds.add(r.id);
    }
    // Linkage collision is a lookup: well-posed only when both key fields are
    // well-typed (a mistyped criterionId reports E_BAD_FIELD alone).
    if (isString(r.specItemRef) && (r.criterionId === undefined || isString(r.criterionId))) {
      const key = linkageKey(r.specItemRef, isString(r.criterionId) ? r.criterionId : undefined);
      if (payloadKeys.has(key) || heldKeys.has(key)) errs.add("E_DUP_LINKAGE");
      payloadKeys.add(key);
    }
  }

  // Link validation over the union of held and payload ids.
  const knows = (id: string): boolean => payloadIds.has(id) || findTask(state, id) !== undefined;
  const prospective: Link[] = [...state.links];
  for (const raw of payloadLinks) {
    if (!isPlainObject(raw)) {
      errs.add("E_MISSING_FIELD");
      continue;
    }
    const l = raw;
    for (const f of ["id", "dependsOn"]) if (!isString(l[f])) errs.add("E_MISSING_FIELD");
    let type: LinkType | undefined;
    if (l.type === undefined) errs.add("E_MISSING_FIELD");
    else if (!isString(l.type) || !LINK_TYPES.includes(l.type)) errs.add("E_BAD_TYPE");
    else type = l.type as LinkType;
    if ((isString(l.id) && !knows(l.id)) || (isString(l.dependsOn) && !knows(l.dependsOn)))
      errs.add("E_UNKNOWN_ID");
    if (isString(l.id) && knows(l.id) && isString(l.dependsOn) && knows(l.dependsOn) && type) {
      const dup = prospective.some(
        (p) => p.id === l.id && p.dependsOn === l.dependsOn && p.type === type,
      );
      if (dup) continue; // accepted no-op
      // Entries apply in payload order; only an entry that validates clean
      // joins the graph later entries are checked against (it-ts-portability).
      const reparent =
        type === "parent-child" &&
        prospective.some((p) => p.type === "parent-child" && p.id === l.id);
      const cycle = wouldCycle(prospective, l.id, l.dependsOn, type);
      if (reparent) errs.add("E_HAS_PARENT");
      if (cycle) errs.add("E_CYCLE");
      if (!reparent && !cycle) prospective.push({ id: l.id, dependsOn: l.dependsOn, type });
    }
  }

  if (errs.any) return { errors: errs.list(), imported: 0, ok: false };

  for (const raw of c.tasks as Record<string, unknown>[]) {
    const task: Task = {
      id: raw.id as string,
      title: raw.title as string,
      type: raw.type as TaskType,
      status: raw.status as TaskStatus,
      priority: raw.priority as number,
      createdAt: raw.createdAt as string,
      createdBy: raw.createdBy as string,
      // Unknown keys are dropped, on comments as on task records (it-ts-portability).
      comments:
        (raw.comments as Comment[] | undefined)?.map((cm) => ({ actor: cm.actor, at: cm.at, text: cm.text })) ?? [],
    };
    for (const f of [
      "description", "assignee", "startedAt", "closedAt", "closeReason",
      "legacyRef", "specItemRef", "criterionId", ...PLAIN_FIELDS, "askedBy", "source",
    ] as const)
      if (raw[f] !== undefined) (task as unknown as Record<string, unknown>)[f] = raw[f];
    state.tasks.push(task);
    // A generated id is never reused (it-ts-model): an imported id in the
    // generator's own t-<n> form moves the sequence past it, so deleting that
    // task can never hand its id to a later create.
    const m = /^t-(\d+)$/.exec(task.id);
    if (m && Number(m[1]) > state.seq) state.seq = Number(m[1]);
  }
  state.links = prospective;
  return { errors: [], imported: (c.tasks as unknown[]).length, ok: true };
}
