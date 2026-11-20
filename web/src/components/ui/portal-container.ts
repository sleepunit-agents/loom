// Where a pop-up renders (docs/specs/desk-tiling.md, "Sheets and dialogs stay inside their tile"): on the tiled desktop,
// a tile's own layer, so its dialog, sheet, menu or list stays inside the tile and is modal to that tile only; anywhere
// else, nothing here, and Radix portals to <body> as before.
import { createContext, useContext } from "react";

/** A tile's layer for pop-ups (tiles.tsx): it covers its tile, holding the pop-ups and, while a dialog is open, the
 * tile's scrim. Null outside a tile. */
export const PortalContainer = createContext<HTMLElement | null>(null);
export const usePortalContainer = () => useContext(PortalContainer);

/** A tile's dialog or sheet is modal to its tile only: a press outside the layer (another tile, the dock) leaves it
 * open; a press on the layer's scrim, which covers its own tile, closes it, as a screen's scrim does. Outside a tile,
 * nothing changes. The caller's own handler runs after. */
export function tileOnly<E extends Event>(layer: HTMLElement | null, own?: (e: E) => void): { onInteractOutside?: (e: E) => void } {
  if (!layer) return {};
  return { onInteractOutside: (e: E) => { if (!layer.contains(e.target as Node)) e.preventDefault(); own?.(e); } };
}
