/** In-process authority is object identity, never a credential or a service name. */
import type { Viewer } from '../policy.js';
import type { Operations } from './operations/index.js';

const callers = new WeakMap<Viewer, Operations>();
const closed = new WeakSet<Operations>();

export function internalCaller(operations: Operations, id: string): Viewer {
  const viewer: Viewer = Object.freeze({ kind: 'service', id });
  callers.set(viewer, operations);
  return viewer;
}

export function isInternalCaller(viewer: Viewer, operations?: Operations): boolean {
  const owner = callers.get(viewer);
  return !!owner && !closed.has(owner) && (!operations || owner === operations);
}

/** Even an ended capability must never fall back to a same-name outside grant. */
export function wasInternalCaller(viewer: Viewer): boolean { return callers.has(viewer); }
export function closeInternalCallers(operations: Operations): void { closed.add(operations); }
