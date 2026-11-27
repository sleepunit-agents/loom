import type { CommsMessage } from '../pieces/comms-view/model';

export type EventMessage = CommsMessage & { run?: string };
export interface WorkNode {
  events: EventMessage[];
  children: WorkNode[];
}

/** New bodies identify calls and parents. For older rows, only join an unambiguous
 * open call within one run and one stretch of consecutive work events. */
export function workTree(rows: EventMessage[]): WorkNode[] {
  const roots: WorkNode[] = [];
  let run: string | undefined;
  const calls = new Map<string, WorkNode>(),
    pending = new Map<string, WorkNode[]>();
  for (const row of rows) {
    const node: WorkNode = { events: [row], children: [] };
    if (!row.run || run !== row.run || row.kind !== 'card') {
      calls.clear();
      pending.clear();
    }
    run = row.run;
    if (row.kind !== 'card' || !run) {
      roots.push(node);
      continue;
    }
    const ids = /(?:^|:)pair\.([a-f0-9]{24})\.([a-f0-9]{24}|-)\.[\w-]+$/.exec(row.clientId || '');
    const label = row.tool || 'Work step';
    const open = pending.get(label) || [];
    const existing = ids
      ? calls.get(ids[1])
      : row.cardState !== 'running' && open.length === 1
        ? open[0]
        : undefined;
    if (existing) existing.events.push(row);
    else {
      const lineage = label.split(' → ').slice(0, -1).join(' → ');
      const candidates = pending.get(lineage) || [];
      const parent = ids ? calls.get(ids[2]) : candidates.length === 1 ? candidates[0] : undefined;
      (parent?.children || roots).push(node);
      if (ids) calls.set(ids[1], node);
    }
    if (!ids) {
      if (row.cardState === 'running') pending.set(label, [...open, node]);
      else if (existing) pending.delete(label);
      else if (open.length > 1) pending.delete(label);
    }
  }
  return roots;
}
