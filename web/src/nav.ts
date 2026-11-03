// Where each destination lives in the shell, once (no React here, so it's tested on its own: src/ui/nav-plain.test.ts).
// Places holds the apps, Setup the household's configuration, and the account (the side's account menu on a desktop,
// the avatar on a phone's dock) what's the signed-in member's own: their passkeys and signing out. Nothing is in two.

import type { Tone } from './loom';

export type Place = { label: string; href: string; current: boolean; count?: number; stat?: string; tone?: Tone; kind?: 'place' | 'setting' };
type ShellLike = { core: Place[]; pieces: Place[]; tab: string; admin?: boolean };

/** The member's own: their account (who they are, their passkeys, signing out), not in Setup. The avatar on a phone's
 * dock and the side's account menu open it. */
export const ACCOUNT = [{ label: 'Account', href: '/account' }] as const;

/** The apps, where you go regularly: loom's own places and the pieces that are places. The Inbox has its own tab.
 * Appearance (light or dark, the background) isn't one: it's a panel of Setup, changed seldom (Jonathan, 2026-11-03). */
export function placesOf(s: ShellLike): Place[] {
  return [...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')].filter((p) => p.href !== '/inbox');
}

/** Setup: the household's configuration only. The pieces that are settings, then (for the household's owner) its
 * members and its pieces. */
export function settingsOf(s: ShellLike): Place[] {
  return [...s.pieces.filter((p) => p.kind === 'setting'),
    ...(s.admin !== false ? [{ label: 'Members', href: '/members', current: false }, { label: 'Pieces', href: '/pieces', current: false }] : [])];
}
