/** Account column privacy at the shared GraphQL door. No credentials are read. */
import { asc, eq } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLFloat, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType, type GraphQLFieldConfigMap, type GraphQLOutputType } from 'graphql/index.js';
import type { Viewer } from '../policy.js';
import type { DataDatabase } from '../core/data/database.js';
import { boxes, members, modelAccountBoxes, modelAccounts } from '../core/data/schema.js';
import { currentAccountCapacity } from './account-windows.js';

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
  const allowed = (viewer: Viewer, id: string) => {
    if (viewer.kind !== 'member') return false;
    const member = db.select({ role: members.role }).from(members).where(eq(members.id, viewer.id)).get();
    const row = db.select({ owner: modelAccounts.owner }).from(modelAccounts).where(eq(modelAccounts.id, id)).get();
    return !!member && !!row && (member.role === 'owner' || row.owner === viewer.id);
  };
  const fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = { modelAccounts: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(view))),
    resolve(_source, _args, { viewer }) {
      const at = now();
      // Public order must not expose the ordering of hidden account identifiers.
      return db.select().from(modelAccounts).orderBy(asc(modelAccounts.label)).all().map(row => {
        const capacity = currentAccountCapacity(db, row.id, at);
        const publicFields = { label: row.label, level: capacity.hasRoom ? capacity.level : 'almost full' };
        if (!allowed(viewer, row.id)) return { __typename: summary.name, ...publicFields };
        const values = { id: row.id, owner: row.owner, provider: row.provider, usage: row.usage,
          usageReadAt: row.usageReadAt, resetsAt: row.resetsAt, hasRoom: capacity.hasRoom };
        return { __typename: detail.name, ...publicFields, read(name: PrivateColumn, actor: Viewer) {
          if (actor !== viewer) throw new Error('Account access ended');
          // Public-only selections never acquire a private witness. Record an
          // actual private column access before checking its current authority.
          let selected = witnesses.get(viewer);
          if (!selected) { selected = new Set(); witnesses.set(viewer, selected); }
          selected.add(row.id);
          if (!allowed(viewer, row.id)) throw new Error('Account access ended');
          if (name !== 'signedInOn') return values[name];
          return db.select({ id: boxes.id, name: boxes.name }).from(modelAccountBoxes)
            .innerJoin(boxes, eq(modelAccountBoxes.box, boxes.id)).where(eq(modelAccountBoxes.account, row.id))
            .orderBy(asc(boxes.name), asc(boxes.id)).all();
        },
        };
      });
    },
  } };
  return {
    fields,
    /** Rechecked after public awaits and on socket refresh/delivery. Reject a
     * previously private selection if its CURRENT ownership no longer permits it. */
    valid(viewer: Viewer) { return [...(witnesses.get(viewer) ?? [])].every(id => allowed(viewer, id)); },
  };
}
