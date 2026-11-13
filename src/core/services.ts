/** In-process built-ins only. Never populated from household data or a request. */
import type { Db } from './db/index.js';
import type { Operations } from './operations/index.js';
import type { Sharing, Viewer } from '../policy.js';

interface Service { types: readonly string[]; operations: Operations; namespace: string }
const installed = new WeakMap<Db, Map<string, Service>>();

/** Called by a built-in installer, with its own record types and operation namespace.
 * No persistence: reopening a home only enables services installed in that daemon.
 * Permission decisions still belong to policy.ts and each operation's may check.
 */
export function registerBuiltinService(operations: Operations, id: string, types: readonly string[], namespace = id): Viewer {
  let services = installed.get(operations.db);
  if (!services) { services = new Map(); installed.set(operations.db, services); }
  if (services.has(id)) throw new Error('duplicate built-in service');
  services.set(id, { types: [...types], operations, namespace });
  return { kind: 'service', id };
}

export function builtinServices(db: Db): Sharing['services'] {
  const snapshot = Object.fromEntries([...(installed.get(db) ?? [])].map(([id, service]) => {
    const entry = {
      types: [...service.types],
      operations: service.operations.offered('direct').map(op => op.name).filter(name => name.startsWith(service.namespace + '.')),
    };
    Object.freeze(entry.types); Object.freeze(entry.operations); Object.freeze(entry);
    return [id, entry];
  }));
  return Object.freeze(snapshot);
}
