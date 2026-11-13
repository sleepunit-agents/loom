/** In-process built-ins only. Never populated from household data or a request. */
import type { Db } from './db/index.js';
import type { Operations } from './operations/index.js';
import type { Sharing, Viewer } from '../policy.js';

interface Service { types: readonly string[]; operations: Set<Operations>; namespace: string; calls: readonly string[] }
const installed = new WeakMap<Db, Map<string, Service>>();

/** Called by a built-in installer, with its own record types and operation namespace.
 * Cross-piece calls name exact operations, never an entire other namespace.
 * Only registered direct operations enter the snapshot.
 * No persistence: reopening a home only enables services installed in that daemon.
 * Permission decisions still belong to policy.ts and each operation's may check.
 */
export function registerBuiltinService(operations: Operations, id: string, types: readonly string[], namespace = id, calls: readonly string[] = []): Viewer {
  let services = installed.get(operations.db);
  if (!services) { services = new Map(); installed.set(operations.db, services); }
  const existing = services.get(id);
  if (existing) {
    if (JSON.stringify(existing.calls) !== JSON.stringify(calls) || existing.namespace !== namespace || JSON.stringify(existing.types) !== JSON.stringify(types)) throw new Error('conflicting built-in service');
    if (existing.operations.has(operations)) throw new Error('duplicate built-in service');
    existing.operations.add(operations);
  } else services.set(id, { types: [...types], operations: new Set([operations]), namespace, calls: [...calls] });
  return { kind: 'service', id };
}

export function builtinServices(db: Db): Sharing['services'] {
  const snapshot = Object.fromEntries([...(installed.get(db) ?? [])].map(([id, service]) => {
    const entry = {
      types: [...service.types],
      operations: [...new Set([...service.operations].flatMap(operations => operations.offered('direct').map(op => op.name).filter(name => name.startsWith(service.namespace + '.') || service.calls.includes(name))))],
    };
    Object.freeze(entry.types); Object.freeze(entry.operations); Object.freeze(entry);
    return [id, entry];
  }));
  return Object.freeze(snapshot);
}

/** Operations registries may lease the same DB; closing one removes only its installation. */
export function unregisterBuiltinServices(operations: Operations): void {
  const services = installed.get(operations.db);
  if (!services) return;
  for (const [id, service] of services) {
    service.operations.delete(operations);
    if (!service.operations.size) services.delete(id);
  }
  if (!services.size) installed.delete(operations.db);
}
