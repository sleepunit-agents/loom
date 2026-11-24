/** Presentation metadata on the same query door; commands recheck authority. */
import { conversationWorkFields } from './shared-conversation-work.js';
import { GraphQLBoolean, GraphQLNonNull, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { workAnswersAllowed } from './shared-work-access.js';
import { and, eq, getTableColumns, inArray } from 'drizzle-orm';
import { approvals } from './core/data/schema.js';
import { workVisibility } from './core/data/work-visibility.js';
import { type InboxCardNames } from './proposal-words.js';

const titleRow = new GraphQLObjectType({ name: 'InboxProposalTitle', fields: {
  approval: { type: GraphQLString }, title: { type: GraphQLString },
} });
/** The Inbox and its search use the same current, viewer-visible card wording. */
export function inboxProposalTitles(db:DataDatabase,names:(viewer:Viewer)=>InboxCardNames,titlesOf:(rows:(typeof approvals.$inferSelect)[],names:InboxCardNames)=>Map<string,string>) {
  return (viewer:Viewer, ids:string[]) => {
    const titles=new Map<string,string>();
    if (!ids.length || !workAnswersAllowed(db,viewer)) return titles;
    const visibleNames=names(viewer);
    const visible=workVisibility(viewer).approvals!(getTableColumns(approvals));
    for(let offset=0;offset<ids.length;offset+=100){
      const rows=db.select().from(approvals).where(and(inArray(approvals.id,ids.slice(offset,offset+100)),
        eq(approvals.operation,'household.change'),visible)).all();
      const batch=titlesOf(rows,visibleNames);
      for(const row of rows){
        const title=batch.get(row.id);
        if(title)titles.set(row.id,title);
      }
    }
    return titles;
  };
}

export function workQueryFields(db: DataDatabase, refreshConfigured: boolean, titles: ReturnType<typeof inboxProposalTitles>) {
  return { ...conversationWorkFields(db), inboxProposalTitles: {
    type: new GraphQLList(titleRow),
    args: { ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) } },
    resolve(_source: unknown, {ids}: {ids: string[]}, {viewer}: {viewer: Viewer}) {
      if (ids.length > 100) {
        if (!workAnswersAllowed(db,viewer)) return [];
        throw Error('Too many approval titles requested');
      }
      return Array.from(titles(viewer,ids),([approval,title])=>({approval,title}));
    },
  }, workAnswerOwner: { type:new GraphQLNonNull(GraphQLBoolean),
    resolve: (_source: unknown, _args: unknown, context: {viewer:Viewer}) => workAnswersAllowed(db,context.viewer),
  }, workChangesRefresh: { type:new GraphQLNonNull(GraphQLBoolean),
    resolve: (_source:unknown,_args:unknown,context:{viewer:Viewer}) => refreshConfigured && workAnswersAllowed(db,context.viewer),
  } };
}
