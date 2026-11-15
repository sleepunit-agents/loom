/** Current reader metadata for the two registered apps, resolved only from the
 * authenticated executor. No Comms encryption or independent identity door. */
import { eq } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../../core/data/database.js';
import { household, members } from '../../core/data/schema.js';
export function bridgeSecretsReaderFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const reader = (viewer: Viewer) => viewer.kind === 'member' ? db.select().from(members).where(eq(members.id, viewer.id)).get() : undefined;
  return {
    bridgeReader: { type: new GraphQLObjectType({ name: 'BridgeReader', fields: {
      id: { type: new GraphQLNonNull(GraphQLString) }, manage: { type: new GraphQLNonNull(GraphQLBoolean) },
    } }), resolve: (_source, _args, { viewer }) => { const member = reader(viewer); return member ? { id: member.id, manage: member.role === 'owner' } : null; } },
    secretsReader: { type: new GraphQLObjectType({ name: 'SecretsReader', fields: {
      id: { type: new GraphQLNonNull(GraphQLString) }, defaultAnswer: { type: new GraphQLNonNull(GraphQLString) },
    } }), resolve: (_source, _args, { viewer }) => { const member = reader(viewer); return member?.role === 'owner' ? { id: member.id, defaultAnswer: db.select({ answer: household.secretsDefault }).from(household).get()?.answer ?? 'ask' } : null; } },
  };
}
