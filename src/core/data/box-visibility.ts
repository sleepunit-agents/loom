import { sql, getTableColumns } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { boxFacts } from './schema.js';
import type { DataDatabase } from './database.js';
import { readMachineReports, reportPrefix } from '../../runtime/machines.js';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';

/** Read filters for the machines registry. The rules are stated in policy.ts.
 * Installed runtime services continue to use the shared database directly. */
export function boxVisibility(viewer: Viewer): QueryVisibility {
  const filters = sqlVisibility(viewer, ['boxes', 'boxAgents', 'boxFacts']);
  return { ...filters, boxFacts: fields => sql`(${filters.boxFacts(fields)}) and substr(${fields.fact}, 1, ${reportPrefix.length}) <> ${reportPrefix}` };
}

const string = new GraphQLNonNull(GraphQLString);
const report = new GraphQLObjectType({name:'MachineBodyReport',fields:{
  machine:{type:string},enabled:{type:new GraphQLNonNull(GraphQLBoolean)},user:{type:string},cwd:{type:string},
  agents:{type:new GraphQLNonNull(new GraphQLList(string))},
}});
export function machineReportFields(db: DataDatabase, viewer: Viewer) {
  return { machineBodyReports: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(report))),
    resolve: () => readMachineReports(db, sqlVisibility(viewer, ['boxFacts']).boxFacts(getTableColumns(boxFacts))),
  }};
}
