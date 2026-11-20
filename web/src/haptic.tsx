// Haptics' front (haptics.ts is the chunk that does it): whether they're on, a tick when they are, and the label that
// gives iOS a real tap to tick for. Small on purpose: this is on the first page; haptics.ts isn't.
import { createContext, useContext } from 'react';

type Chunk = typeof import('./haptics');
let chunk: Chunk | null = null;
let asked = false;

/** Load the chunk, once, so a tick later is inside its gesture (a tick that waits on the network is too late). */
export function warmHaptics(): void {
  if (asked) return;
  asked = true;
  void import('./haptics').then((m) => { chunk = m; m.install(); }).catch(() => { asked = false; });
}

/** A light tick, when Haptics is on and the chunk is here; a touch device only. `tap`: see haptics.ts tick. */
export function buzz(on: boolean, tap = false): void {
  if (!on || navigator.maxTouchPoints < 1) return;
  if (chunk) chunk.tick(tap); else warmHaptics();
}

/** Appearance's Haptics, the person's (on unless they turn it off). */
export const HapticsContext = createContext(true);
export const useHaptics = () => useContext(HapticsContext);

/** iOS's Safari (an iPad says it's a Mac, with touch). */
export const ios = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * Over a key or a button, for iOS only: a transparent label for haptics.ts's switch, so the tap that presses the key
 * also toggles it and iOS ticks. Its parent must be positioned. Nothing elsewhere (another browser would let the label
 * take the click's default from a submit button).
 */
export function HapticLabel({ on }: { on: boolean }) {
  if (!on || !ios) return null;
  return <label htmlFor="loom-haptic" aria-hidden className="loom-haptic" />;
}
