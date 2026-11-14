// What a Comms pane in a tile and the agents' rail beside it tell each other (docs/specs/agent-desk.md, "Work"): the
// pane says whose thread it shows, and the rail opens that agent's card; while the rail is shown, that card is the
// pane's comm screen (the pane draws it there, so its face plays the thread's own state) and the band drops its own.
// Its own small module: Comms' chunk and the desk's both import it, and a phone (no rail) never provides it.
import { createContext } from 'react';

export type OnAir = { agent: string } | null;
export type RailLink = {
  /** The visible selected Comms agent, including while the rail is temporarily hidden. */
  selected?: string;
  /** A Comms pane says whose thread it shows (null as it goes). */
  onAir: (who: OnAir, from: object) => void;
  /** The rail is shown beside the tiles now (so a thread's comm screen goes there, not in its band). */
  shown: boolean;
  /** The owned companion card supplies its destination; late cleanup is source fenced. */
  setScreen?: (screen: {agent: string; el: HTMLElement} | null, from: object) => void;
  /** Where the comm screen goes: that agent's rail card, while the rail is shown; null keeps it in the band. */
  screen: { agent: string; el: HTMLElement } | null;
};
export const RailContext = createContext<RailLink | null>(null);
