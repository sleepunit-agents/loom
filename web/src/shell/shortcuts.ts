/** The shell's keyboard shortcuts: one declared list, and the one place their keys are read.
 *
 * Every binding is data in SHORTCUTS (a name, what it does, its keys), so the list a person is shown and the keys the
 * shell answers come from the same entry: a different key is one edit there.
 *
 * In a browser tab the keys the browser or the system owns never arrive (Ctrl+Tab, Ctrl+W, Alt+Tab, Cmd+Space), so app
 * switching is Ctrl+` here. An installed, full-screen build could take the real Alt+Tab with
 * `navigator.keyboard.lock(['AltLeft','AltRight','Tab'])`: add an `{ code: 'Tab', alt: true, shift: 'either' }` chord
 * to `switch` below and release on Alt as well as Control in `keyup`. Considered and left out: it needs fullscreen,
 * and only Chromium has it.
 */
import { useEffect, useRef, useState } from 'react';

/** Keys held together. `code` is the physical key, so a binding is the same key on every layout. */
export interface Chord { code: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean | 'either' }
export interface Shortcut {
  id: string;
  /** What it is called in a list of shortcuts. */
  name: string;
  /** What it does, as the end of a sentence that starts with the keys. */
  does: string;
  /** Chords this module answers. More than one is one shortcut with aliases. */
  chords?: readonly Chord[];
  /** A lone modifier tapped this many times. */
  taps?: { key: 'Shift'; times: 2 };
  /** Keys read somewhere else, written as a person reads them; `{ctrl}` is the Control key's name. */
  elsewhere?: { keys: string; file: string };
}

/** Longest a Shift may stay down and still be a tap, and longest wait between the two taps. */
export const TAP_HELD_MS = 250;
export const TAP_GAP_MS = 350;

export const SHORTCUTS = [
  { id: 'launcher', name: 'Launcher', does: 'opens or closes this', chords: [{ code: 'Space', ctrl: true }] },
  { id: 'launcher-taps', name: 'Launcher, without a chord', does: 'opens or closes this', taps: { key: 'Shift', times: 2 } },
  // The first binding, kept: Ctrl+Space belongs to the input method on some machines and never reaches the page there.
  { id: 'launcher-alias', name: 'Launcher, the older keys', does: 'opens or closes this', chords: [{ code: 'Space', ctrl: true, shift: true }, { code: 'Space', meta: true, shift: true }] },
  { id: 'switch', name: 'Switch apps', does: 'switches apps: hold, tap again to move on, let go to land', chords: [{ code: 'Backquote', ctrl: true, shift: 'either' }] },
  { id: 'agent-thread', name: 'Jump to an agent', does: 'jumps to an agent’s thread', elsewhere: { keys: '{ctrl}+Shift+1…9', file: 'web/src/pieces/attention/desk-signals.tsx' } },
] as const satisfies readonly Shortcut[];
type Id = typeof SHORTCUTS[number]['id'];
const bound = (id: Id): Shortcut => SHORTCUTS.find(s => s.id === id)!;

export const onMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const KEY_NAMES: Readonly<Record<string, string>> = { Space: 'Space', Backquote: '`' };
/** A shortcut's keys for the person's platform. Control is Control on a Mac too: these never use Cmd, the old alias aside. */
export function keysOf(shortcut: Shortcut, mac: boolean): string {
  const ctrl = mac ? 'Control' : 'Ctrl';
  if (shortcut.elsewhere) return shortcut.elsewhere.keys.replace('{ctrl}', ctrl);
  if (shortcut.taps) return `double-tap ${shortcut.taps.key}`;
  const chords = shortcut.chords ?? [];
  const chord = chords.find(c => !!c.meta === mac) ?? chords[0];
  return [chord.ctrl && ctrl, chord.meta && (mac ? 'Cmd' : 'Meta'), chord.alt && (mac ? 'Option' : 'Alt'), chord.shift === true && 'Shift', KEY_NAMES[chord.code] ?? chord.code].filter(Boolean).join('+');
}
/** The declared list as short hints: shortcuts that do the same thing share a line. */
export function shortcutHints(mac: boolean): { does: string; keys: string[] }[] {
  const hints: { does: string; keys: string[] }[] = [];
  for (const shortcut of SHORTCUTS as readonly Shortcut[]) {
    const hint = hints.find(h => h.does === shortcut.does) ?? hints[hints.push({ does: shortcut.does, keys: [] }) - 1];
    hint.keys.push(keysOf(shortcut, mac));
  }
  return hints;
}

type Key = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'timeStamp' | 'isComposing' | 'preventDefault' | 'stopPropagation'>;
const held = (chord: Chord, e: Key) => e.code === chord.code && e.ctrlKey === !!chord.ctrl && e.metaKey === !!chord.meta && e.altKey === !!chord.alt && (chord.shift === 'either' || e.shiftKey === !!chord.shift);
const pressed = (id: Id, e: Key) => !!bound(id).chords?.some(chord => held(chord, e));

/** The app switcher while Control is down: the apps, most recently used first, and the one a release lands on. */
export interface Switching { order: readonly string[]; index: number }
export interface ShortcutHost {
  toggleLauncher(): void;
  /** Open apps, most recently used first, and the one in front (none on the empty desk). */
  apps(): { order: readonly string[]; focused?: string };
  /** The switcher to draw, or null to take it away. */
  show(switching: Switching | null): void;
  land(id: string): void;
}

/** The key logic with no page under it: the shell feeds it events, tests feed it plain objects.
 * It keeps no "Control is down" flag. The switcher being open is the only state, so nothing can stick. */
export function shortcutEngine(host: ShortcutHost) {
  let switching: (Switching & { from?: string }) | null = null;
  const down = new Set<string>();
  let shiftDown: number | undefined, tapped: number | undefined;
  const take = (e: Key) => { e.preventDefault(); e.stopPropagation(); };
  const forget = () => { shiftDown = tapped = undefined; };
  const end = () => { if (switching) { switching = null; host.show(null); } };
  const land = (id: string) => { const from = switching?.from; end(); if (id !== from) host.land(id); };
  return {
    keydown(e: Key) {
      const alone = down.size === 0;
      // A lock key on a Mac stays "down" for as long as its light is on; it is nobody's held key.
      if (!e.key.endsWith('Lock')) down.add(e.code);
      // Control came up where the page could not see it (another window took the keys): stay where we were.
      if (switching && !e.ctrlKey) end();
      if (e.key === 'Shift') {
        // A tap is a Shift pressed with nothing else down. Key repeat means it is being held.
        const clean = alone && !e.repeat && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey;
        if (!clean || (tapped !== undefined && e.timeStamp - tapped > TAP_GAP_MS)) tapped = undefined;
        shiftDown = clean ? e.timeStamp : undefined;
        return;
      }
      forget();
      if (switching && e.key === 'Escape') { take(e); end(); return; }
      if (pressed('switch', e)) {
        const step = e.shiftKey ? -1 : 1;
        if (!switching) {
          const { order, focused } = host.apps();
          if (order.length < 2) return;
          const at = focused === undefined ? -1 : order.indexOf(focused);
          switching = { order: [...order], from: focused, index: at < 0 ? (step > 0 ? 0 : order.length - 1) : (at + step + order.length) % order.length };
        } else switching = { ...switching, index: (switching.index + step + switching.order.length) % switching.order.length };
        take(e); host.show({ order: switching.order, index: switching.index });
        return;
      }
      if (pressed('launcher', e) || pressed('launcher-alias', e)) { take(e); if (!e.repeat) host.toggleLauncher(); }
    },
    keyup(e: Key) {
      down.delete(e.code);
      // A Mac sends no keyup for a key let go while Cmd is down; do not count those as held for ever.
      if (e.key === 'Meta') down.clear();
      if (e.key === 'Shift') {
        const began = shiftDown; shiftDown = undefined;
        if (began === undefined || down.size || e.ctrlKey || e.altKey || e.metaKey || e.timeStamp - began > TAP_HELD_MS) { tapped = undefined; return; }
        if (tapped === undefined) { tapped = e.timeStamp; return; }
        tapped = undefined; host.toggleLauncher();
        return;
      }
      forget();
      if (switching && !e.ctrlKey) { if (e.key === 'Control') land(switching.order[switching.index]); else end(); }
    },
    /** A click is not a tap's company: Shift+click selects text. */
    pointerdown() { forget(); },
    /** The window lost the keys (blur, a hidden tab): close without switching and hold nothing over. */
    away() { end(); forget(); down.clear(); },
    pick(id: string) { land(id); },
  };
}

/** The shell's one keyboard listener for the declared shortcuts. Capture, so a text field or an app cannot swallow
 * them first; a key is prevented only when it was one of ours. */
export function useShortcuts(host: Omit<ShortcutHost, 'show'>) {
  const [switching, setSwitching] = useState<Switching | null>(null);
  const latest = useRef(host); latest.current = host;
  const [engine] = useState(() => shortcutEngine({ toggleLauncher: () => latest.current.toggleLauncher(), apps: () => latest.current.apps(), land: id => latest.current.land(id), show: setSwitching }));
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') engine.away(); };
    window.addEventListener('keydown', engine.keydown, true); window.addEventListener('keyup', engine.keyup, true);
    window.addEventListener('pointerdown', engine.pointerdown, true); window.addEventListener('blur', engine.away);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', engine.keydown, true); window.removeEventListener('keyup', engine.keyup, true);
      window.removeEventListener('pointerdown', engine.pointerdown, true); window.removeEventListener('blur', engine.away);
      document.removeEventListener('visibilitychange', hidden); engine.away();
    };
  }, [engine]);
  return { switching, pick: engine.pick };
}

/** Most recently used first. `open` is every open app (freshest first, for ones not yet seen in front); the app in
 * front moves to the head, closed apps drop out. Returns `recent` itself when nothing moved. */
export function recency(recent: readonly string[], open: readonly string[], focused?: string): readonly string[] {
  const kept = recent.filter(id => id !== focused && open.includes(id));
  const next = [...(focused !== undefined && open.includes(focused) ? [focused] : []), ...kept, ...open.filter(id => id !== focused && !recent.includes(id))];
  return next.length === recent.length && next.every((id, i) => id === recent[i]) ? recent : next;
}
