/** Current reader metadata for the two registered apps, resolved only from the
 * authenticated executor. No Comms encryption or independent identity door. */
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../core/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { household } from '../../core/data/schema.js';
import { householdOwner, sharedSharing } from '../../shared-sharing.js';
export function bridgeSecretsReaderFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  // A current member of the household; a removed member reads nothing here.
  const reader = (viewer: Viewer) => viewer.kind === 'member' && Object.hasOwn(sharedSharing(db).members, viewer.id) ? viewer : undefined;
  return {
    bridgeReader: { type: new GraphQLObjectType({ name: 'BridgeReader', fields: {
      id: { type: new GraphQLNonNull(GraphQLString) }, manage: { type: new GraphQLNonNull(GraphQLBoolean) },
    } }), resolve: (_source, _args, { viewer }) => { const member = reader(viewer); return member ? { id: member.id, manage: householdOwner(db, viewer) } : null; } },
    secretsReader: { type: new GraphQLObjectType({ name: 'SecretsReader', fields: {
      id: { type: new GraphQLNonNull(GraphQLString) }, defaultAnswer: { type: new GraphQLNonNull(GraphQLString) },
    } }), resolve: (_source, _args, { viewer }) => { const member = reader(viewer); return member && householdOwner(db, viewer) ? { id: member.id, defaultAnswer: db.select({ answer: household.secretsDefault }).from(household).get()?.answer ?? 'ask' } : null; } },
  };
}
