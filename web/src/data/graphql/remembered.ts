/** Answers a page chooses to remember while it is open (the boards page: docs/specs/boards.md, "The page").
 *
 * A hook that mounts under `Remembered` and finds the last live answer to its own selection (the same document
 * and variables) shows it at once, marked `settling`, and replaces it with the fresh answer when that arrives.
 * The store is a Map in this page's memory and nothing else: it is never written to localStorage, sessionStorage,
 * IndexedDB or the address, so it ends with the page, and its owner clears it when the signed-in member changes
 * or the session ends. It is bounded: the most recently used answers are kept and the oldest dropped. An answer
 * is dropped the moment its selection fails or its feed closes, and it never outlives the client that gave it.
 * A hook with no `Remembered` above it (the whole desktop) behaves exactly as it did. */
import { createContext } from 'react';

export interface RememberedAnswers {
  get(key: number): { data: unknown; from: unknown } | undefined;
  set(key: number, data: unknown, from: unknown): void;
  drop(key: number): void;
  clear(): void;
  readonly size: number;
}
/** How many answers one page remembers. */
export const REMEMBERED_MOST = 300;
export function rememberedAnswers(most = REMEMBERED_MOST): RememberedAnswers {
  const held = new Map<number, { data: unknown; from: unknown }>();
  return {
    get(key) { const found = held.get(key); if (found) { held.delete(key); held.set(key, found); } return found; },
    set(key, data, from) { held.delete(key); held.set(key, { data, from }); while (held.size > most) held.delete(held.keys().next().value!); },
    drop(key) { held.delete(key); },
    clear() { held.clear(); },
    get size() { return held.size; },
  };
}
export const Remembered = createContext<RememberedAnswers | undefined>(undefined);
/** Told by each hook below it whether it is showing a remembered answer that has not been replaced yet, so what
 * draws the hooks (a board's placement) can say "getting new data" once for all of them. */
export const RememberedWatch = createContext<((hook: object, settling: boolean) => void) | undefined>(undefined);
