import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultFieldResolver, isObjectType, isInterfaceType, isUnionType, isScalarType, isEnumType, type GraphQLSchema } from 'graphql/index.js';

type Tracked<T> = T extends { then: (...args: never[]) => unknown } ? Promise<Awaited<T>> : T;
type Scope = { drain: ExecutionDrain; admitted(): boolean };
const scopes = new AsyncLocalStorage<readonly Scope[]>();
const wrappers = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>();

function invoke<T>(active: readonly Scope[], operation: () => T): Tracked<T> {
  let call: () => unknown = operation;
  for (const scope of [...active].reverse()) {
    const next = call;
    call = () => {
      if (!scope.admitted()) throw new Error('Data execution ended');
      return scope.drain.run(next);
    };
  }
  return call() as Tracked<T>;
}

/** Retain real callback work after an executor/response has returned early.
 * Admission is a pure lifecycle fence; authentication stays at the door. */
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
  scope<T>(admitted: () => boolean, operation: () => T): Tracked<T> {
    const active = [...(scopes.getStore() ?? []), { drain: this, admitted }];
    return scopes.run(active, () => invoke(active, operation));
  }
  /** The owner stops new admission before draining. */
  async drain() { while (this.active) await new Promise<void>(resolve => this.waiters.add(resolve)); }
}

function wrap(target: object, key: string, fallback?: typeof defaultFieldResolver) {
  const record = target as Record<string, unknown>, original = record[key] ?? fallback;
  if (typeof original !== 'function' || wrappers.get(target)?.get(key) === original) return;
  const wrapped = function(this: unknown, ...args: unknown[]) {
    const active = scopes.getStore();
    const call = () => Reflect.apply(original, this, args) as unknown;
    return active?.length ? invoke(active, call) : call();
  };
  record[key] = wrapped;
  let fields = wrappers.get(target);
  if (!fields) { fields = new Map(); wrappers.set(target, fields); }
  fields.set(key, wrapped);
}

/** Universal wrappers preserve type identities and use async-local scopes, so
 * retained schemas shared by concurrent callers never retain another's drain.
 * Unscoped installed callers keep the original behavior. */
export function instrumentExecution(schema: GraphQLSchema) {
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__')) continue;
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        wrap(field, 'resolve', defaultFieldResolver);
        wrap(field, 'subscribe');
      }
    }
    if (isObjectType(type)) wrap(type, 'isTypeOf');
    if (isInterfaceType(type) || isUnionType(type)) wrap(type, 'resolveType');
    if (isScalarType(type) || isEnumType(type)) {
      for (const key of ['serialize', 'parseValue', 'parseLiteral']) wrap(type, key);
    }
  }
}
