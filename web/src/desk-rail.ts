// What a Comms pane in a tile tells the agents' rail beside it (docs/specs/agent-desk.md, "Work"): whose thread it
// shows. The rail opens that agent's card in its accordion. Its own small module: Comms' chunk and the desk's both
// import it, and a phone (no rail) never provides it.
import { createContext } from 'react';

export type OnAir = { agent: string } | null;
export type RailLink = {
  /** A Comms pane says whose thread it shows (null as it goes). */
  onAir: (who: OnAir, from: object) => void;
};
export const RailContext = createContext<RailLink | null>(null);
