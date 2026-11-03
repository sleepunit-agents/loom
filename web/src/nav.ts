// Where each destination lives in the shell, once (no React here, so it's tested on its own: src/ui/nav-plain.test.ts).
// Places holds the apps, Setup the household's configuration, and the account (the side's account menu on a desktop,
// the avatar on a phone's dock) what's the signed-in member's own: their passkeys and signing out. Nothing is in two.

import type { Tone } from './loom';

export type Place = { label: string; href: string; current: boolean; count?: number; stat?: string; tone?: Tone; kind?: 'place' | 'setting' };
type ShellLike = { core: Place[]; pieces: Place[]; tab: string; admin?: boolean };

/** Appearance (light or dark, the background): this device's own, an app in Places like the others. */
export const APPEARANCE = { label: 'Appearance', href: '/appearance' } as const;
/** The member's own: their account (who they are, their passkeys, signing out), not in Setup. The avatar on a phone's
 * dock and the side's account menu open it. */
export const ACCOUNT = [{ label: 'Account', href: '/account' }] as const;

/** The apps: loom's own places, the pieces that are places, and Appearance last. The Inbox has its own tab. */
export function placesOf(s: ShellLike): Place[] {
  return [...s.core, ...s.pieces.filter((p) => p.kind !== 'setting'), { ...APPEARANCE, current: s.tab === 'appearance' }]
    .filter((p) => p.href !== '/inbox');
}

/** Setup: the household's configuration only. The pieces that are settings, then (for the household's owner) its
 * members and its pieces. */
export function settingsOf(s: ShellLike): Place[] {
  return [...s.pieces.filter((p) => p.kind === 'setting'),
    ...(s.admin !== false ? [{ label: 'Members', href: '/members', current: false }, { label: 'Pieces', href: '/pieces', current: false }] : [])];
}
