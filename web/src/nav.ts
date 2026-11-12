// Where each destination lives in the shell, once (no React here, so it's tested on its own: src/ui/nav-plain.test.ts).
// Places holds the apps, Setup the household's configuration, and the account (the side's account menu on a desktop,
// the avatar on a phone's dock) what's the signed-in member's own: their passkeys and signing out. Nothing is in two.

import type { Tone } from './loom';

export type Place = { label: string; href: string; current: boolean; count?: number; stat?: string; tone?: Tone; kind?: 'place' | 'setting'; icon?: string };
type ShellLike = { core: Place[]; pieces: Place[]; tab: string; admin?: boolean };

/** The member's own: their account (who they are, their passkeys, signing out), not in Setup. The avatar on a phone's
 * dock and the side's account menu open it. */
export const ACCOUNT = [{ label: 'Profile', href: '/account' }] as const;

/** Appearance (light or dark, the background): this device's own, an app in Setup's grid like the others, changed
 * seldom (Jonathan, 2026-11-03). */
export const APPEARANCE = { label: 'Appearance', href: '/appearance' } as const;

/** Accessibility (Allow zoom, Reduce motion, Higher contrast): the person's, an app of its own beside Appearance
 * (Jonathan, 2026-11-05). */
export const ACCESSIBILITY = { label: 'Accessibility', href: '/accessibility' } as const;

/** The apps, where you go regularly: loom's own places and the pieces that are places. The Inbox has its own tab. */
export function placesOf(s: ShellLike): Place[] {
  return [...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')].filter((p) => p.href !== '/inbox');
}

/** Setup: the household's configuration (the pieces that are settings, then, for the household's owner, its members
 * and its pieces), then Appearance and Accessibility, the person's own: every one a tile, nothing loose under them. */
export function settingsOf(s: ShellLike): Place[] {
  return [...s.pieces.filter((p) => p.kind === 'setting'),
    ...(s.admin !== false ? [{ label: 'Members', href: '/members', current: false }, { label: 'Pieces', href: '/pieces', current: false }] : []),
    { ...APPEARANCE, current: s.tab === 'appearance' }, { ...ACCESSIBILITY, current: s.tab === 'accessibility' }];
}
