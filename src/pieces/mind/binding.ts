/** Source identity binding; no source content is read or copied here. */
import { existsSync } from 'node:fs';
import type { Change, Viewer } from '../../core/index.js';
import type { TouchSource } from '../../core/touched/index.js';
import type { MindSources } from './sources.js';

export function mindTouchSources(inventory: MindSources | undefined): TouchSource[] {
  if (!inventory) return [];
  const sources: TouchSource[] = [];
  const commonsTypes = new Set([
    ...(existsSync(inventory.commons.knowledge) ? ['knowledge'] : []),
    ...(existsSync(inventory.commons.people) ? ['person'] : []),
  ]);
  if (commonsTypes.size) sources.push({ directory: inventory.commons.directory,
    viewer: { kind: 'service', id: 'mind:commons' },
    resolve: change => commonsTypes.has(change.type) ? { type: change.type, id: change.type === 'knowledge' ? change.id : `commons:${change.id}` } : undefined,
  });
  for (const source of inventory.agents) if (existsSync(source.memories)) sources.push({
    directory: source.directory, viewer: { kind: 'agent', id: source.agent },
    resolve: change => ['memory', 'person', 'project'].includes(change.type) ? { type: change.type, id: `${source.agent}:${change.id}` } : undefined,
  });
  return sources;
}
/** Input is already canonical here; only the bound source's namespace is admitted. */
export function mindTouchResolver(sources: readonly TouchSource[]) {
  return (viewer: Viewer, change: Change): Change | undefined => {
    const source = sources.find(s => s.viewer.kind === viewer.kind && s.viewer.id === viewer.id);
    if (!source) return;
    const prefix = viewer.kind === 'agent' ? `${viewer.id}:` : change.type === 'person' ? 'commons:' : '';
    if (!change.id.startsWith(prefix) || change.id.length === prefix.length) return;
    const resolved = source.resolve({ type: change.type, id: change.id.slice(prefix.length) });
    return resolved?.id === change.id && resolved.type === change.type ? resolved : undefined;
  };
}
