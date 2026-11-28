/** The gallery's fixtures (development only; web/vite.gallery.config.ts): for each brick, the scenes it is drawn
 * in. A scene is the parameters a placement holds and what each of the brick's reads answers, by the name of the
 * query (`query BrickTicket(...)` is `BrickTicket`), as the page tests fake them. Nothing here ships. */
import type { Params } from '../brick-kit';

/** What one read answers: the data itself, or a function of the read's variables. The words `'loading'`,
 * `'offline'` and `'denied'` are a read in that state. A query a scene does not name answers `{}`. */
export type Answer = unknown | ((variables: Record<string, unknown>) => unknown);
export interface Scene {
  /** A short name in kebab case: `default` is the brick's ordinary, well-filled state. */
  name: string;
  params: Params;
  data: Record<string, Answer>;
  /** The placement's flag words, when the scene is a flagged one. */
  flag?: string;
  /** Buttons to press once the brick is drawn, by their words, in order: how a scene shows a form that opens on a
   * press (an edit form, the question a brick asks before it acts). */
  press?: string[];
  /** The conversation the page is open on, for a brick that treats it apart (the `threads` brick: no Delete on it). */
  here?: string;
  /** Draw only these forms (default: all). */
  only?: ('primary' | 'side' | 'compact')[];
}
export interface BrickScenes { brick: string; scenes: Scene[] }
