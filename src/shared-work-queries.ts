/** Presentation metadata on the same query door; commands recheck authority. */
import { conversationWorkFields } from './shared-conversation-work.js';
import { GraphQLBoolean, GraphQLNonNull, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { workAnswersAllowed } from './shared-work-access.js';
import { and, eq, getTableColumns, inArray } from 'drizzle-orm';
import { approvals } from './core/data/schema.js';
import { workVisibility } from './core/data/work-visibility.js';
import { proposalCard, storedProposal, type CardNames } from './proposal-words.js';

const titleRow = new GraphQLObjectType({ name: 'InboxProposalTitle', fields: {
  approval: { type: GraphQLString }, title: { type: GraphQLString },
} });
export function workQueryFields(db: DataDatabase, refreshConfigured: boolean, names: (viewer: Viewer) => CardNames) {
  return { ...conversationWorkFields(db), inboxProposalTitles: {
    type: new GraphQLList(titleRow),
    args: { ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) } },
    resolve(_source: unknown, {ids}: {ids: string[]}, {viewer}: {viewer: Viewer}) {
      // One page plus its separately opened item. Resolve owner-readable names only for visible cards.
      if (!ids.length || !workAnswersAllowed(db,viewer)) return [];
      if (ids.length > 100) throw Error('Too many approval titles requested');
      const rows = db.select({id: approvals.id, operation: approvals.operation, details: approvals.details})
        .from(approvals).where(and(inArray(approvals.id, ids), eq(approvals.operation,'household.change'),
          workVisibility(viewer).approvals!(getTableColumns(approvals)))).all();
      const context = { names: names(viewer) };
      return rows.flatMap(row => {
        const input = storedProposal(row);
        const card = input && proposalCard(input.change, input.input, context);
        return card ? [{approval: row.id, title: card.title}] : [];
      });
    },
  }, workAnswerOwner: { type:new GraphQLNonNull(GraphQLBoolean),
    resolve: (_source: unknown, _args: unknown, context: {viewer:Viewer}) => workAnswersAllowed(db,context.viewer),
  }, workChangesRefresh: { type:new GraphQLNonNull(GraphQLBoolean),
    resolve: (_source:unknown,_args:unknown,context:{viewer:Viewer}) => refreshConfigured && workAnswersAllowed(db,context.viewer),
  } };
}
