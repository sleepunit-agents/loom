// The launcher's list (launcher.tsx): every app, grouped (t-1925 G; the app mockups, 2026-11-06). Plain, no React,
// tested on its own (src/ui/nav-plain.test.ts); its own module so the first page doesn't carry it.
import type { Tone } from './loom';
import { ACCESSIBILITY, APPEARANCE, type Place } from './nav';

type ShellLike = { core: Place[]; pieces: Place[]; tab: string; admin?: boolean };

/** An app in the launcher: where it opens, and what it says about itself under its name (its live state). */
export type LaunchApp = { label: string; href: string; sub?: string; count?: number; tone?: Tone; icon?: string; agent?: string };
export type LaunchSection = { name: string; apps: LaunchApp[] };
type AgentLike = { id: string; label: string; href: string; asks?: number; sub?: string; working?: true };
type LaunchShell = ShellLike & { owner?: string; asks?: number; agents?: AgentLike[] };

/** The sections, in order. A piece with no section of its own is Work's unless it runs the household (System's). */
export const LAUNCH_SECTIONS = ['Work', 'People & agents', 'Library', 'System', 'Look & feel', 'Pieces'] as const;
/** Pieces that run the household rather than hold its work: System's, whatever their kind says. */
const SYSTEM = new Set(['Boxes', 'Machine', 'Clock', 'Bridges', 'Houses', 'Runtime', 'Secrets', 'Subscriptions', 'Fuel', 'Discord', 'Slack', 'Packages', 'Shuttle', 'Deploys']);

/** Every app the launcher shows, by section (empty sections left out). The same apps as Places, Setup and the account,
 * once each, plus the household's agents: nothing is in two sections. `look` and `motion` are this device's own
 * (Appearance's and Accessibility's live state). */
export function launcherOf(s: LaunchShell, own: { look?: string; motion?: string } = {}): LaunchSection[] {
  const by = new Map<string, LaunchApp[]>(LAUNCH_SECTIONS.map((n) => [n, []]));
  const put = (sec: string, a: LaunchApp) => by.get(sec)!.push(a);
  const core = (href: string) => s.core.find((p) => p.href === href);
  const inbox = core('/inbox');
  if (inbox) put('Work', { label: 'Inbox', href: '/inbox', count: inbox.count || undefined, sub: inbox.count ? `${inbox.count} need${inbox.count === 1 ? 's' : ''} you` : 'Nothing waiting' });
  for (const p of s.core) {
    if (p.href === '/inbox') continue;
    const sec = p.href === '/comms' || p.href === '/people' ? 'People & agents' : p.href === '/knowledge' || p.href === '/mind' ? 'Library' : 'Work';
    put(sec, { label: p.label, href: p.href, count: p.count || undefined, ...(p.href === '/comms' ? { sub: p.count ? `${p.count} unread` : 'All read' } : {}) });
  }
  for (const p of s.pieces) {
    const sec = p.kind === 'setting' || SYSTEM.has(p.label) ? 'System' : 'Work';
    put(sec, { label: p.label, href: p.href, sub: p.stat, tone: p.tone, icon: p.icon, count: (p as { alerts?: number }).alerts || undefined });
  }
  for (const a of s.agents ?? []) {
    put('People & agents', { label: a.label, href: a.href, agent: a.id, count: a.asks || undefined,
      sub: a.asks ? `${a.asks} waiting on you` : a.working ? 'Working' : a.sub ?? 'Quiet' });
  }
  if (s.admin !== false) put('System', { label: 'Members', href: '/members' });
  put('Look & feel', { ...APPEARANCE, ...(own.look ? { sub: own.look } : {}) });
  put('Look & feel', { ...ACCESSIBILITY, ...(own.motion ? { sub: own.motion } : {}) });
  if (s.admin !== false) put('Pieces', { label: 'Pieces', href: '/pieces', sub: `${s.pieces.length} installed` });
  // People & agents: Comms, then the agents, then People (the mockup's order).
  const pa = by.get('People & agents')!;
  const rank = (a: LaunchApp) => (a.href === '/comms' ? 0 : a.agent ? 1 : 2);
  pa.sort((x, y) => rank(x) - rank(y));
  // Work: the Inbox first, then loom's own, then the pieces by name (as they come).
  return LAUNCH_SECTIONS.map((name) => ({ name, apps: by.get(name)! })).filter((x) => x.apps.length > 0);
}

/** The apps a search matches, in the launcher's order: by the app's name, its section's, or its live line. */
export function launchFilter(sections: LaunchSection[], q: string): LaunchSection[] {
  const n = q.trim().toLowerCase();
  if (!n) return sections;
  return sections.map((s) => ({ ...s, apps: s.apps.filter((a) => a.label.toLowerCase().includes(n) || s.name.toLowerCase().includes(n)) }))
    .filter((s) => s.apps.length > 0);
}

/** The best match for Enter: an app whose name starts with what's typed, else the first one shown. */
export const firstMatch = (apps: LaunchApp[], q: string) => {
  const n = q.trim().toLowerCase();
  return apps.find((a) => a.label.toLowerCase().startsWith(n)) ?? apps[0];
};
