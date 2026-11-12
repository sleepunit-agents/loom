/** Read-only watch sources. Callers supply an already authorized snapshot; this module never opens a piece's store.
 * A new registry per snapshot keeps viewer data out of process-global state. Piece manifest offers are step 3.
 */
import type { PieceInfo } from './ui/pieces.js';
import type { Job } from './ui/vocab.js';
import { pageHref, pieceSource } from './ui/render.js';

export interface WatchItem { id: string; agent: string; title: string; state: string; href?: string; at?: string; run?: string }
export interface WatchSource {
  kind: string;
  label: string;
  list(agent: string): WatchItem[];
  /** Stable target key, independent of labels and observation values. */
  identity(item: WatchItem): string;
  /** Deterministic JSON value; unavailable/computing must throw, never become an observation. */
  observe(item: WatchItem): string;
}
export interface WatchGroup { kind: string; label: string; status: 'available' | 'unavailable'; count: number | null; items: WatchItem[] }

export class WatchRegistry {
  private readonly sources = new Map<string, WatchSource>();
  register(source: WatchSource): void {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(source.kind) || this.sources.has(source.kind)) throw new Error('Invalid or duplicate watch source');
    this.sources.set(source.kind, source);
  }
  source(kind: string): WatchSource {
    const source = this.sources.get(kind);
    if (!source) throw new Error('Unknown watch source');
    return source;
  }
  list(agent: string): WatchGroup[] {
    return [...this.sources.values()].map((s) => {
      try {
        const items = s.list(agent);
        return { kind: s.kind, label: s.label, status: 'available', count: items.length, items };
      } catch {
        return { kind: s.kind, label: s.label, status: 'unavailable', count: null, items: [] };
      }
    });
  }
}

type Roles = Partial<Record<'runtime' | 'tasks' | 'approvals' | 'clock', string>>;
/** Sources over today's public reports, after forOwner, atWorkFor AND asksFor. Counts are reported items only,
 * not a claim that a piece's bounded manifest inventories its entire store. No additional polling or commands.
 * The clock consumer must refresh the snapshot before observing and treat disappearance as membership change;
 * it must not interpret a missing row as completion (manifests can be bounded). */
export function builtinWatchRegistry(pieces: readonly PieceInfo[], roles: Roles): WatchRegistry {
  const registry = new WatchRegistry();
  const provider = (role: keyof Roles): PieceInfo => {
    const p = pieces.find((p) => p.piece === roles[role]);
    if (!p) throw new Error('Watch provider unavailable');
    return p;
  };
  const add = (kind: string, label: string, read: (agent: string) => WatchItem[]) => {
    const identity = (item: WatchItem) => JSON.stringify([kind, item.agent, item.id]);
    registry.register({ kind, label,
      list: (agent) => {
        const items = read(agent);
        const unique = new Map(items.map((i) => [identity(i), i]));
        return [...unique.values()].sort((a, b) => identity(a).localeCompare(identity(b)));
      }, identity,
      observe: (item) => {
        const current = read(item.agent).find((x) => identity(x) === identity(item));
        if (!current) throw new Error('Watch target absent from report; resolve membership before observing');
        // No text, relative ages, activity timestamps or progress prose in equality.
        return JSON.stringify([current.state, current.at ?? null, current.run ?? null]);
      },
    });
  };
  const jobs = (role: keyof Roles, agent: string): Job[] => {
    const report = provider(role).manifest.agents?.[agent];
    if (!report || report.state === 'broken' || report.state === 'unavailable' || !report.jobs) throw new Error('Watch jobs unavailable');
    return report.jobs;
  };
  const item = (role: keyof Roles, agent: string, j: Job): WatchItem => ({ id: j.id, agent, title: j.text, state: j.status,
    ...(j.href ? { href: j.href } : j.page !== undefined ? { href: pageHref(j.page, pieceSource(provider(role).piece)) } : {}),
    ...(j.at ? { at: j.at } : {}), ...(j.run ? { run: j.run } : {}) });
  add('runtime.lane', 'lanes running', (agent) => jobs('runtime', agent).filter((j) => j.kind === 'lane' && j.status === 'running').map((j) => item('runtime', agent, j)));
  add('tasks.task', 'tasks reported', (agent) => jobs('tasks', agent).map((j) => item('tasks', agent, j)));
  add('clock.deadline', 'deadlines reported', (agent) => jobs('clock', agent).filter((j) => j.status === 'scheduled' && j.at).map((j) => item('clock', agent, j)));
  add('approvals.pending', 'approvals waiting', (agent) => {
    const p = provider('approvals');
    return p.manifest.asks.filter((a) => a.agent === agent && a.attention !== false).map((a) => {
      const ids = [...new Set((a.actions ?? []).flatMap((b) => b.fields?.id ? [b.fields.id] : []))];
      if (ids.length !== 1) throw new Error('Approval lacks a stable identity');
      return { id: ids[0], agent, title: a.text, state: 'pending', ...(a.page !== undefined ? { href: pageHref(a.page, pieceSource(p.piece)) } : {}) };
    });
  });
  return registry;
}
