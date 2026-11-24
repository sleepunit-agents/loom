import { defaultFieldResolver, type GraphQLFieldResolver, type GraphQLSchema } from 'graphql/index.js';
import { mapReadFields } from './query-fields.js';
import type { Viewer } from '../../policy.js';

type Tracked<T> = T extends { then: (...args: never[]) => unknown } ? Promise<Awaited<T>> : T;

/** Retain actual read promises even when GraphQL returns a sibling error early. */
export class ExecutionDrain {
  private active = 0;
  private waiters = new Set<() => void>();
  run<T>(operation: () => T): Tracked<T> {
    this.active++;
    const finish = () => {
      if (--this.active === 0) { for (const wake of this.waiters) wake(); this.waiters.clear(); }
    };
    try {
      const value = operation();
      if (value != null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
        // Assimilate once: query-builder thenables can execute IO on each then.
        return Promise.resolve(value).then(result => { finish(); return result; }, error => { finish(); throw error; }) as Tracked<T>;
      }
      finish(); return value as Tracked<T>;
    } catch (error) { finish(); throw error; }
  }
  async drain() { while (this.active) await new Promise<void>(resolve => this.waiters.add(resolve)); }

  schema(source: GraphQLSchema, admitted: () => boolean) {
    // The transport owns these resolver closures and their admission check. No ambient scopes or mutation of a retained schema.
    const track = (resolve: GraphQLFieldResolver<unknown, { viewer: Viewer }>): typeof resolve =>
      (...values) => {
        if (!admitted()) throw new Error('Data access ended');
        return this.run(() => resolve(...values));
      };
    // Most generated fields use the same resolver. Retain only the function
    // to call, so a live selection can release each intermediate field config.
    const readProperty = track(defaultFieldResolver);
    return mapReadFields(source, field => ({ ...field, resolve: field.resolve ? track(field.resolve) : readProperty }));
  }
}

/** A private projection owns every decrypt it starts, including failed batches. */
export async function readAll<T>(reads: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(reads);
  return results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
}
