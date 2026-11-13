import { z } from 'zod';
import { operation, OperationError, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { grantInput } from './grant-schema.js';
import type { RuntimeRecords } from './records.js';
import { runtimeStore } from './store.js';
type Grants = NonNullable<RuntimeRecords['settings']['grants']>;
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => map && Object.hasOwn(map, key) ? map[key] : undefined;
function configuration(input: z.infer<typeof grantInput>, before: Grants | undefined): Grants {
  const { logins, scopes: requestedScopes, steers: requestedSteers, ...capabilities } = input;
  // Empty objects are an untouched old form field, not an instruction to widen a restriction.
  const scopes = requestedScopes === 'none' ? {} : requestedScopes && Object.keys(requestedScopes).length ? requestedScopes : before?.scopes ?? {};
  const steers = requestedSteers === 'none' ? {} : requestedSteers && Object.keys(requestedSteers).length ? requestedSteers : before?.steers ?? {};
  for (const key of Object.keys(scopes)) {
    const present = key.startsWith('tailnet:') ? input.tailnets.some(item => `tailnet:${item.name}` === key) : Object.hasOwn(input.secrets, key);
    if (!present && !Object.hasOwn(before?.scopes ?? {}, key)) throw new OperationError('invalid', 'A new scope must name a granted secret alias or tailnet');
  }
  const scopeStores: Record<string, string> = {};
  for (const key of Object.keys(scopes)) {
    if (key.startsWith('tailnet:')) continue;
    const source = own(input.secrets, key) ?? own(before?.scopeStores, key) ?? own(before?.secrets, key);
    if (source !== undefined) scopeStores[key] = source;
  }
  const sources = [...Object.entries(input.secrets), ...Object.entries(scopeStores).filter(([key]) => !Object.hasOwn(input.secrets, key))];
  for (const [alias, source] of sources) {
    if (sources.some(([other, store]) => other !== alias && store === source && own(scopes, other) !== own(scopes, alias)))
      throw new OperationError('invalid', 'Aliases of the same stored secret must have identical scopes');
  }
  for (const item of input.tailnets) {
    if (input.tailnets.some(other => other.name !== item.name && other.socket === item.socket && own(scopes, `tailnet:${other.name}`) !== own(scopes, `tailnet:${item.name}`)))
      throw new OperationError('invalid', 'Aliases of the same tailnet socket must have identical scopes');
  }
  const keptLogins = logins === 'default' ? undefined : logins === undefined ? before?.logins : [...new Set(logins)];
  return { ...capabilities, ...(keptLogins === undefined ? {} : { logins: keptLogins }), scopes, scopeStores, steers };
}
export function installHouseGrants(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db);
  operations.register(operation({
    name: 'runtime.configureGrants', write: true,
    input: z.object({ agent: z.string().min(1).max(200), grants: grantInput }).strict(), output: z.object({ agent: z.string() }),
    may: (viewer, input) => mayAct(viewer, { type: 'runtime.settings', agent: input.agent }, sharing(), 'agent-setup'),
    run(ctx, input) {
      const existing = store.read('settings', input.agent);
      const grants = configuration(input.grants, existing?.grants);
      const { changedAt: _at, ...settings } = existing ?? { id: input.agent, agent: input.agent, boxes: [], changedAt: ctx.now };
      if (store.put('settings', { ...settings, grants }, ctx.now)) ctx.changed('runtime.settings', input.agent);
      return { agent: input.agent };
    },
  }));
}
