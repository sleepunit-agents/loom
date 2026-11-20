/** Roll up visible receipts inside SQLite so JavaScript receives one row per visible connection. */
import {asc,is,sql,SQL} from 'drizzle-orm';
import {bridgeConnections,bridgeIncoming} from './schema.js';
import type {DataDatabase} from './database.js';

export function readBridgeActivity(db:DataDatabase,scope:{connections:SQL;incoming:SQL},now:number){
 if(!is(scope?.connections,SQL)||!is(scope?.incoming,SQL))throw Error('SQL bridge visibility required');
 const at=new Date(now).toISOString();
 const rows=db.query.bridgeConnections.findMany({
  columns:{id:true},
  where:f=>sql`${{getSQL:()=>sql`exists(select 1 from ${bridgeConnections} where ${bridgeConnections.id}=${f.id} and ${scope.connections})`}}`,
  extras:f=>({
   counts:sql<string>`${{getSQL:()=>sql`coalesce((
    with totals as materialized (
     select ${bridgeIncoming.connection} as connection,
      json_array(count(*),count(*) filter(where ${bridgeIncoming.state}='delivered'),count(*) filter(where ${bridgeIncoming.state}='held')) as counts
     from ${bridgeIncoming} where ${scope.incoming}
      and julianday(${bridgeIncoming.receivedAt})>julianday(${at},'-1 day') and julianday(${bridgeIncoming.receivedAt})<=julianday(${at})
     group by ${bridgeIncoming.connection}
    ) select totals.counts from totals where totals.connection=${f.id}
   ),'[0,0,0]')`}}`.as('activity_counts'),
  }),
  orderBy:f=>asc(f.id),
 }).sync();
 return rows.map(({id,counts})=>{
  const [received,delivered,held]:[number,number,number]=JSON.parse(counts);
  return {id,received,delivered,held};
 });
}
