// loom's haptics (Appearance → Haptics, on unless the person turns it off; Jonathan, 2026-11-04: "Haptics would be
// awesome… only if we can find a library and do it easily"). Its own chunk, loaded once the first page is up and only
// while Haptics is on (haptic.tsx warmHaptics), so it's never part of the first page.
//
// Ours, not a library's. ios-haptics was the known one: its 2.x clicked a hidden `<input type=checkbox switch>`'s
// label from script, which iOS 26.5 closed (WebKit fc1ef83: a script's click on the label is no longer trusted); its
// 3.x lays a switch over the element instead, and the 3.2.0 on npm is the build that swallows the touch and stops the
// page scrolling (its issues #11, #13, #14); 3.3.0 is days old. So, in a few lines:
//
// - Android and other browsers with the Vibration API: a short `navigator.vibrate`.
// - iOS Safari: a real tap on a `<label for>` the switch below (haptic.tsx HapticLabel, over a dock key or an ask's
//   Yes and No) toggles it, and iOS ticks for a trusted tap. A swipe isn't a tap, so it can't tick there; for an iOS
//   older than 26.5 a script's click still does, so a swipe tries that.
// - Anywhere else: nothing.

import { ios as onIos } from './haptic';

/** The id the labels point at: one hidden switch for the whole page. */
export const SWITCH_ID = 'loom-haptic';

const ios = () => onIos;

/** The one switch the labels toggle: in the page, never seen, never focused, out of the accessibility tree. */
export function install(): void {
  if (!ios() || document.getElementById(SWITCH_ID)) return;
  const s = document.createElement('input');
  s.type = 'checkbox'; s.id = SWITCH_ID; s.setAttribute('switch', ''); s.setAttribute('aria-hidden', 'true'); s.tabIndex = -1;
  s.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;visibility:hidden;pointer-events:none;left:0;top:0';
  // Its forwarded click goes no further than the switch: nothing in the page sees a second click.
  s.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(s);
}

/**
 * One light tick, inside the gesture that asked for it. `tap`: a tap on an element wearing a HapticLabel, which iOS
 * ticks for itself (so it isn't ticked twice).
 */
export function tick(tap = false): void {
  try {
    if (typeof navigator.vibrate === 'function' && !ios()) { navigator.vibrate(10); return; }
    if (!ios() || tap) return;
    // An iOS before 26.5: a script's click on a switch's label still ticks (from 26.5 it does nothing).
    const l = document.createElement('label'); l.ariaHidden = 'true'; l.style.display = 'none';
    const s = document.createElement('input'); s.type = 'checkbox'; s.setAttribute('switch', '');
    l.appendChild(s); document.head.appendChild(l); l.click(); l.remove();
  } catch { /* a browser that refuses: quietly nothing */ }
}
