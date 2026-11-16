import {readBridgeActivity} from '../../core/data/bridge-activity-read.js';
/** Installed read service. Outside visibility comes from root's shared policy;
 * this module neither grants access nor invents a second authentication model. */
import { asc, sql, SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../core/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeIncoming } from '../../core/data/schema.js';
const day = 86400_000;
export interface BridgeActivityScope { connections: SQL; incoming: SQL }
export class BridgeQueries {
  constructor(readonly db: DataDatabase, readonly now: () => number) {}
  activity(scope: BridgeActivityScope) {
    return readBridgeActivity(this.db,scope,this.now());
  }
  /** Root includes this in its common read-deadline schedule and rechecks it
   * after committed incoming writes. It is internal, never a query field.
   * The window is (now - 24h, now]; future receipts enter at their own time. */
  nextDeadline(): number | undefined {
    const now = this.now(), at = new Date(now).toISOString();
    const row = this.db.select({ at: bridgeIncoming.receivedAt }).from(bridgeIncoming)
      .where(sql`julianday(${bridgeIncoming.receivedAt}, '+1 day') > julianday(${at})`)
      .orderBy(asc(sql`case when julianday(${bridgeIncoming.receivedAt}) > julianday(${at}) then julianday(${bridgeIncoming.receivedAt}) else julianday(${bridgeIncoming.receivedAt}, '+1 day') end`)).limit(1).get();
    if (!row) return;
    const received = Date.parse(row.at);
    return received > now ? received : received + day;
  }
}
/** Root MUST supply the same current connection and message-label visibility
 * used by its generated table reads. No permissive default is available. */
export function bridgeQueryFields(service: BridgeQueries, scope: (viewer: Viewer) => BridgeActivityScope, observed?: () => void): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const item = new GraphQLObjectType({ name: 'BridgeConnectionActivity', fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    received: { type: new GraphQLNonNull(GraphQLInt) }, delivered: { type: new GraphQLNonNull(GraphQLInt) }, held: { type: new GraphQLNonNull(GraphQLInt) },
  } });
  return { bridgeActivity: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(item))),
    resolve: (_source, _args, context) => { const rows = service.activity(scope(context.viewer)); observed?.(); return rows; } } };
}
