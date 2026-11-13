import { apps, appAt } from './apps';
// The launcher's list (launcher.tsx): every app, grouped (t-1925 G; the app mockups, 2026-11-06). Plain, no React,
// tested on its own (src/ui/nav-plain.test.ts); its own module so the first page doesn't carry it.
import type { Tone } from './loom';
import { ACCESSIBILITY, ACCOUNT, APPEARANCE, type Place } from './nav';

type ShellLike = { core: Place[]; pieces: Place[]; tab: string; admin?: boolean };

/** An app in the launcher: where it opens, and what it says about itself under its name (its live state). */
export type LaunchApp = { label: string; href: string; sub?: string; count?: number; tone?: Tone; icon?: string; agent?: string;
  /** Other words a search finds it by (Profile: "passkey", "sign out"). */ keywords?: readonly string[] };
export type LaunchSection = { name: string; apps: LaunchApp[] };
type AgentLike = { id: string; label: string; href: string; asks?: number; sub?: string; working?: true };
type LaunchShell = ShellLike & { agents?: AgentLike[];
  /** The household's Permissions page (the grants authority's), for its owner: which agent may use which piece (t-1970). */
  permissions?: string };

/** Profile (t-1970: Jonathan couldn't find it, a control in the corner a search didn't know): the member's own account,
 * an app like the others. */
export const PROFILE: LaunchApp = { label: ACCOUNT[0].label, href: ACCOUNT[0].href, sub: 'Passkeys, signing out',
  keywords: ['profile', 'account', 'passkey', 'passkeys', 'sign out', 'sign in', 'log out'] };
/** Permissions: which agent may use which piece, who may relay to whom, and each agent's people (the runtime's page). */
const PERMISSIONS = (href: string): LaunchApp => ({ label: 'Permissions', href, sub: 'Who can use what',
  keywords: ['permissions', 'grants', 'access', 'relay'] });

/** The sections, in order. A piece is in the section SECTION names for it, if any; else System's when its kind is a
 * setting, or when it's one of loom's own first-party pieces that run the household while being a place (SYSTEM, by
 * its tab's label: a manifest has no section field yet); any other piece, a third party's too, is Work's. Apps with no number of their own to say (Activity, People, Projects,
 * Knowledge, Members) show no line under their name rather than a made-up one. */
export const LAUNCH_SECTIONS = ['Work', 'People & agents', 'Library', 'System', 'Look & feel', 'Pieces'] as const;
/** Pieces that run the household rather than hold its work: System's, whatever their kind says. */
const SYSTEM = new Set(['Boxes', 'Machine', 'Clock', 'Bridges', 'Houses', 'Runtime', 'Secrets', 'Subscriptions', 'Fuel', 'Discord', 'Slack', 'Packages', 'Shuttle', 'Deploys']);
/** A piece's section, by its tab's label, whatever its kind says (the launcher's place for it, not what the piece is):
 * Approvals is a setting (its standing rules are configuration) but what it holds is work waiting on you, so it's
 * Work's, as in the app mockups (t-1925). Its kind stays a setting everywhere else (Setup, the phone's More). */
export const SECTION: Readonly<Record<string, (typeof LAUNCH_SECTIONS)[number]>> = { Approvals: 'Work' };

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
    if (p.href === '/inbox' || appAt(p.href)) continue;
    const sec = p.href === '/comms' || p.href === '/people' ? 'People & agents' : p.href === '/knowledge' || p.href === '/mind' ? 'Library' : 'Work';
    put(sec, { label: p.label, href: p.href, count: p.count || undefined, ...(p.href === '/comms' ? { sub: p.count ? `${p.count} unread` : 'All read' } : {}) });
  }
  for (const app of apps.filter(app => app.listed)) put('Work', {label:app.title,href:app.path,icon:app.icon});
  for (const p of s.pieces) {
    if (appAt(p.href)) continue;
    const sec = SECTION[p.label] ?? (p.kind === 'setting' || SYSTEM.has(p.label) ? 'System' : 'Work');
    put(sec, { label: p.label, href: p.href, sub: p.stat, tone: p.tone, icon: p.icon, count: (p as { alerts?: number }).alerts || undefined });
  }
  for (const a of s.agents ?? []) {
    put('People & agents', { label: a.label, href: a.href, agent: a.id, count: a.asks || undefined,
      sub: a.asks ? `${a.asks} waiting on you` : a.working ? 'Working' : a.sub ?? 'Quiet' });
  }
  if (s.admin !== false) put('System', { label: 'Members', href: '/members' });
  if (s.admin !== false && s.permissions) put('System', PERMISSIONS(s.permissions));
  put('System', PROFILE);
  // System by name (t-1970): Members, Permissions and Profile among the pieces, not after them.
  by.get('System')!.sort((x, y) => x.label.localeCompare(y.label));
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

/** The apps a search matches, in the launcher's order: by the app's name or its section's. */
export function launchFilter(sections: LaunchSection[], q: string): LaunchSection[] {
  const n = q.trim().toLowerCase();
  if (!n) return sections;
  return sections.map((s) => ({ ...s, apps: s.apps.filter((a) => a.label.toLowerCase().includes(n) || s.name.toLowerCase().includes(n)
    || (a.keywords ?? []).some((k) => k.includes(n))) }))
    .filter((s) => s.apps.length > 0);
}

/** The best match for Enter: an app whose name starts with what's typed, else the first one shown. */
export const firstMatch = (apps: LaunchApp[], q: string) => {
  const n = q.trim().toLowerCase();
  return apps.find((a) => a.label.toLowerCase().startsWith(n)) ?? apps.find((a) => (a.keywords ?? []).some((k) => k.startsWith(n))) ?? apps[0];
};
