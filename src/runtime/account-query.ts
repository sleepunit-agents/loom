/** Account column privacy at the shared GraphQL door. No credentials are read. */
import { GraphQLBoolean, GraphQLFloat, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType, type GraphQLFieldConfigMap, type GraphQLOutputType } from 'graphql/index.js';
import type { Viewer } from '../policy.js';
import type { DataDatabase } from '../core/data/database.js';
import { accountCapacity } from './quota.js';
import { allowedModelAccounts, modelAccountAuthority, readModelAccounts } from '../core/data/model-account-read.js';

const text = new GraphQLNonNull(GraphQLString);
const common = { label: { type: text }, level: { type: text } };
const account = new GraphQLInterfaceType({ name: 'RuntimeAccount', fields: common });
const summary = new GraphQLObjectType({ name: 'RuntimeAccountSummary', interfaces: [account], fields: common });
type PrivateColumn = 'id' | 'owner' | 'provider' | 'usage' | 'usageReadAt' | 'resetsAt' | 'hasRoom' | 'signedInOn';
const column = (name: PrivateColumn, type: GraphQLOutputType) => ({ type,
  resolve: (value: { read(name: PrivateColumn, viewer: Viewer): unknown }, _args: unknown, context: { viewer: Viewer }) => value.read(name, context.viewer),
});
const detail = new GraphQLObjectType({ name: 'RuntimeAccountDetail', interfaces: [account], fields: {
  ...common, id: column('id', text), owner: column('owner', text), provider: column('provider', text), usage: column('usage', GraphQLFloat),
  usageReadAt: column('usageReadAt', GraphQLString), resetsAt: column('resetsAt', GraphQLString),
  hasRoom: column('hasRoom', new GraphQLNonNull(GraphQLBoolean)),
  signedInOn: column('signedInOn', new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(new GraphQLObjectType({ name: 'RuntimeAccountBox', fields: {
    id: { type: text }, name: { type: text },
  } }))))),
} });
// The union registers both concrete types with the generated schema. Their
// shared interface lets clients select label/level with one common fragment.
const view = new GraphQLUnionType({ name: 'RuntimeAccountView', types: [summary, detail] });

export function modelAccountQueries(db: DataDatabase, now: () => string) {
  // The same admitted Viewer object reaches GraphQL context and auth.valid().
  // Retain only selected account IDs, never usage/provider/location values or a credential.
  const witnesses = new WeakMap<Viewer, Set<string>>();
  const fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = { modelAccounts: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(view))),
    resolve(_source, _args, { viewer }) {
      const at = now();
      // Public order must not expose the ordering of hidden account identifiers.
      const selected = readModelAccounts(db, viewer);
      const current = modelAccountAuthority(db, viewer);
      return selected.rows.map(row => {
        let capacity;
        try { capacity = accountCapacity(row.modelAccountWindowsByAccount.map(window => ({ name: window.window, usage: window.usage, readAt: window.usageReadAt, resetsAt: window.resetsAt, durationMs: window.durationMs, reserve: window.reserve })), at); }
        catch { capacity = accountCapacity([], at); }
        capacity.hasRoom = row.hasRoom && capacity.hasRoom;
        const publicFields = { label: row.label, level: capacity.hasRoom ? capacity.level : 'almost full' };
        const privateRow = selected.privateRows.get(row.id);
        if (!privateRow) return { __typename: summary.name, ...publicFields };
        const values = { ...privateRow, hasRoom: capacity.hasRoom };
        return { __typename: detail.name, ...publicFields, read(name: PrivateColumn, actor: Viewer) {
          if (actor !== viewer) throw new Error('Account access ended');
          // Public-only selections never acquire a private witness. Record an
          // actual private column access before checking its current authority.
          let selected = witnesses.get(viewer);
          if (!selected) { selected = new Set(); witnesses.set(viewer, selected); }
          selected.add(row.id);
          return current(row.id).then(() => values[name]);
        },
        };
      });
    },
  } };
  return {
    fields,
    /** Rechecked after public awaits and on socket refresh/delivery. Reject a
     * previously private selection if its CURRENT ownership no longer permits it. */
    valid(viewer: Viewer) { const ids = [...(witnesses.get(viewer) ?? [])]; return allowedModelAccounts(db, viewer, ids).size === ids.length; },
  };
}
