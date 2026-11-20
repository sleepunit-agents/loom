/** Current reader metadata for the two registered apps, resolved only from the
 * authenticated executor. No Comms encryption or independent identity door. */
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../core/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { readSecretsDefault } from '../../core/data/household-settings.js';
import { readAppMember } from '../../core/data/app-reader-metadata.js';
export function bridgeSecretsReaderFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  // A current member of the household; a removed member reads nothing here.
  const reader = (viewer: Viewer) => readAppMember(db,viewer);
  return {
    bridgeReader: { type: new GraphQLObjectType({ name: 'BridgeReader', fields: {
      id: { type: new GraphQLNonNull(GraphQLString) }, manage: { type: new GraphQLNonNull(GraphQLBoolean) },
    } }), resolve: (_source, _args, { viewer }) => reader(viewer)??null },
    secretsReader: { type: new GraphQLObjectType({ name: 'SecretsReader', fields: {
      id: { type: new GraphQLNonNull(GraphQLString) }, defaultAnswer: { type: new GraphQLNonNull(GraphQLString) },
    } }), resolve: (_source, _args, { viewer }) => { const member = reader(viewer); return member?.manage ? { id: member.id, defaultAnswer: readSecretsDefault(db) } : null; } },
  };
}
