/** Installed read service. Outside visibility comes from root's shared policy;
 * this module neither grants access nor invents a second authentication model. */
import { DAY_MS } from '../../core/day.js';
import { and, asc, eq, is, sql, SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../core/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming } from '../../core/data/schema.js';
const day = DAY_MS;
export interface BridgeActivityScope { connections: SQL; incoming: SQL }
export class BridgeQueries {
  constructor(readonly db: DataDatabase, readonly now: () => number) {}
  activity(scope: BridgeActivityScope) {
    if (!is(scope?.connections, SQL) || !is(scope?.incoming, SQL)) throw Error('SQL bridge visibility required');
    const at = new Date(this.now()).toISOString();
    return this.db.select({ id: bridgeConnections.id,
      received: sql<number>`count(${bridgeIncoming.id})`,
      delivered: sql<number>`coalesce(sum(case when ${bridgeIncoming.state} = 'delivered' then 1 else 0 end), 0)`,
      held: sql<number>`coalesce(sum(case when ${bridgeIncoming.state} = 'held' then 1 else 0 end), 0)`,
    }).from(bridgeConnections).leftJoin(bridgeIncoming, and(eq(bridgeIncoming.connection, bridgeConnections.id), scope.incoming,
      sql`julianday(${bridgeIncoming.receivedAt}) > julianday(${at}, '-1 day')`,
      sql`julianday(${bridgeIncoming.receivedAt}) <= julianday(${at})`))
      .where(scope.connections).groupBy(bridgeConnections.id).orderBy(asc(bridgeConnections.id)).all();
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
