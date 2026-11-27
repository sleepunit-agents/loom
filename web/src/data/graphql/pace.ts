/** How often a page's live selections are read again, and how the page asks for some of them now
 * (docs/specs/boards.md, "Live reads and their cost"; the paces are in src/core/data/live-pace.ts).
 *
 * A hook that mounts under a `Pace` scope (the boards page gives each placement one; nothing of the desktop has
 * one) opens its selection `relaxed`: loom reads it again at most once in a few seconds. The scope knows the
 * selections open below it, so it can ask loom to read exactly those again now (`refresh`), and it says, for
 * whoever draws it, whether an asking is still unanswered and when its data was last confirmed. `refreshRelaxed`
 * asks for every scope on the page at once: after the member's own write, and when the tab is seen again.
 * A hook with no scope above it behaves exactly as it did: eager, unnamed, never asked for. */
import { createContext } from 'react';

export interface PaceState { /** An asking has not been answered yet. */ refreshing: boolean; /** When every answer shown below was last confirmed by loom: the oldest of them. */ confirmedAt?: number }
/** One open relaxed selection, as its hook reports it. */
export interface PaceRead { /** An answer arrived (a change, or loom's word that nothing changed). */ answered(): void; /** The selection failed or its feed closed. */ failed(): void; close(): void }
export interface PaceScope {
  /** `key` is the name the selection has on the socket; `at` is when the remembered answer it starts from arrived. */
  open(key: string, at?: number): PaceRead;
  /** Ask loom to read this scope's selections again now. */
  refresh(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): PaceState;
}
export const Pace = createContext<PaceScope | undefined>(undefined);

type Entry = { key: string; at?: number; asking: number };
type Scope = PaceScope & { entries: Set<Entry>; tell(): void };
const scopes = new Set<Scope>();
let send: (keys: string[]) => Promise<string[]> = async () => [];
let asks = 0;
/** How an asking reaches loom: given the selections' names, it answers with those loom had open (./index.ts). */
export function paceSender(to: typeof send) { send = to; }

function ask(of: Iterable<Scope>) {
  const asked: { scope: Scope; entry: Entry }[] = [], id = ++asks;
  for (const scope of of) for (const entry of scope.entries) { entry.asking = id; asked.push({ scope, entry }); }
  if (!asked.length) return;
  const told = new Set(asked.map(({ scope }) => scope));
  for (const scope of told) scope.tell();
  // A selection loom did not have open under that name (it had not reached loom yet, or the socket is down) will
  // not be answered for this asking: it stops waiting. Its own first answer is on its way in any case.
  void send([...new Set(asked.map(({ entry }) => entry.key))]).catch(() => [] as string[]).then((open) => {
    for (const { entry } of asked) if (entry.asking === id && !open.includes(entry.key)) entry.asking = 0;
    for (const scope of told) scope.tell();
  });
}
/** Ask for every relaxed selection open on this page now. */
export function refreshRelaxed() { ask(scopes); }

export function paceScope(): PaceScope {
  const listeners = new Set<() => void>();
  let state: PaceState = { refreshing: false };
  const scope: Scope = {
    entries: new Set(),
    tell() {
      let refreshing = false, confirmedAt: number | undefined;
      for (const entry of scope.entries) { refreshing ||= entry.asking > 0; if (entry.at !== undefined) confirmedAt = Math.min(confirmedAt ?? entry.at, entry.at); }
      if (state.refreshing === refreshing && state.confirmedAt === confirmedAt) return;
      state = { refreshing, confirmedAt };
      for (const listener of [...listeners]) listener();
    },
    open(key, at) {
      const entry: Entry = { key, at, asking: 0 };
      scope.entries.add(entry); scopes.add(scope); scope.tell();
      return {
        answered() { entry.at = Date.now(); entry.asking = 0; scope.tell(); },
        failed() { entry.at = undefined; entry.asking = 0; scope.tell(); },
        close() { scope.entries.delete(entry); if (!scope.entries.size) scopes.delete(scope); scope.tell(); },
      };
    },
    refresh() { ask([scope]); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
  };
  return scope;
}

/** The name a relaxed selection has on the socket, and its number among the client's operations: never the number
 * of the same selection opened eager, so a brick's relaxed read and the page's eager read of the same thing are two
 * selections and neither takes the other's pace. */
export const relaxedKey = (key: number) => (key ^ 0x9e3779b9) >>> 0;

const arrived = new WeakMap<object, number>();
/** When an answer arrived, kept beside the answer itself and gone with it. */
export function stampAnswer(data: unknown, at: number = Date.now()) { if (data && typeof data === 'object') arrived.set(data, at); }
export const answerArrived = (data: unknown): number | undefined => (data && typeof data === 'object' ? arrived.get(data) : undefined);
