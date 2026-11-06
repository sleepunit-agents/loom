// Where a pop-up renders (docs/specs/desk-tiling.md, "Sheets and dialogs stay inside their tile"): on the tiled desktop,
// a tile's own layer, so its dialog, sheet, menu or list stays inside the tile and is modal to that tile only; anywhere
// else, nothing here, and Radix portals to <body> as before.
import { createContext, useContext } from "react";

export const PortalContainer = createContext<HTMLElement | null>(null);
export const usePortalContainer = () => useContext(PortalContainer);
