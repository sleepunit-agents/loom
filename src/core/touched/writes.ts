/** A small post-success hook for the existing store mutation boundaries. */
import { dirname } from 'node:path';
import { touched, hasTouchedListener } from './index.js';
type Mutation = (...args: any[]) => any; // heterogeneous existing backend signatures
/** Only named identity fields, never body text, can become notifications. */
export function identities(value: unknown, fields: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown, identity = false): void => {
    if (typeof v === 'string') { if (identity) ids.add(v); return; }
    if (Array.isArray(v)) { for (const item of v) walk(item, identity); return; }
    if (v && typeof v === 'object') for (const [key, item] of Object.entries(v)) {
      if (fields.has(key)) walk(item, true);
      else if (['pages', 'losers'].includes(key)) walk(item);
    }
  };
  walk(value); return [...ids];
}
export function notifyWrites<T extends object>(store: T, dbPath: string, type: string, methods: readonly (keyof T)[], fields: readonly string[]): void {
  const directory = dirname(dbPath), keys = new Set(fields);
  for (const method of methods) {
    const original = (store[method] as Mutation).bind(store);
    (store as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
      const done = (result: unknown) => {
        // No daemon means no traversal of the result, either. Failed mutations never reach here.
        if (hasTouchedListener(directory)) {
          const ids = method === 'addCitations' ? [args[0] as string] : identities(result, keys);
          if (!(method === 'prune' && (args[0] as { dryRun?: boolean } | undefined)?.dryRun))
            for (const id of ids) touched(directory, type, id);
        }
        return result;
      };
      const result = original(...args);
      return result instanceof Promise ? result.then(done) : done(result);
    };
  }
}
