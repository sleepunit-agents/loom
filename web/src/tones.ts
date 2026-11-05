// A tone's colours, in one place (Neon Noir's sweep, 2026-11-04): each is a token (index.css --loom-*) whose 000h value
// is the Tailwind colour these used to name, so 000h draws as it did and a look (looks/) re-points them.
// src/ui/web-app.test.ts checks the tokens against Tailwind's palette and this map against the classes it replaced.
import type { Page, Tone } from './loom';

/** A status dot (emerald-500, amber-500, red-500, neutral-400). Never colour alone: a word goes with it. */
export const DOT: Record<Tone, string> = { ok: 'bg-[var(--loom-ok)]', warn: 'bg-[var(--loom-warn)]', bad: 'bg-[var(--loom-bad)]', muted: 'bg-[var(--loom-muted)]' };

/** A section's warning ring (red-400, amber-400). */
export const sectionRing = (s: Page['sections'][number]) => (s.tone === 'bad' ? 'ring-1 ring-[var(--loom-ring-bad)]' : s.tone === 'warn' ? 'ring-1 ring-[var(--loom-ring-warn)]' : undefined);

/** A status screen's headline badge (panel.tsx Health): a 15% wash of its tone and its ink (emerald, amber, red: 700, 300 in the dark). */
export const HEALTH: Record<Tone, string> = {
  ok: 'bg-[color-mix(in_oklab,var(--loom-ok)_15%,transparent)] text-[color:var(--loom-ok-ink)]',
  warn: 'bg-[color-mix(in_oklab,var(--loom-warn)_15%,transparent)] text-[color:var(--loom-warn-ink)]',
  bad: 'bg-[color-mix(in_oklab,var(--loom-bad)_15%,transparent)] text-[color:var(--loom-bad-ink)]',
  muted: 'bg-[color-mix(in_oklab,var(--loom-muted-wash)_15%,transparent)] opacity-80',
};
