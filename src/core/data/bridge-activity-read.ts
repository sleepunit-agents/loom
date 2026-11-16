/** Two generated metadata batches for the visible rolling receipt window. */
import {and,asc,inArray,is,sql,SQL} from 'drizzle-orm';
import {bridgeConnections,bridgeIncoming} from './schema.js';
import type {DataDatabase} from './database.js';
export function readBridgeActivity(db:DataDatabase,scope:{connections:SQL;incoming:SQL},now:number){
 if(!is(scope?.connections,SQL)||!is(scope?.incoming,SQL))throw Error('SQL bridge visibility required');
 const connections=db.query.bridgeConnections.findMany({columns:{id:true},where:f=>sql`${{getSQL:()=>sql`exists(select 1 from ${bridgeConnections} where ${bridgeConnections.id}=${f.id} and ${scope.connections})`}}`,orderBy:f=>asc(f.id)}).sync();
 const at=new Date(now).toISOString();
 const incoming=db.query.bridgeIncoming.findMany({columns:{connection:true,state:true},where:f=>and(sql`${{getSQL:()=>sql`exists(select 1 from ${bridgeIncoming} where ${bridgeIncoming.id}=${f.id} and ${scope.incoming})`}}`,inArray(f.connection,connections.map(row=>row.id)),sql`julianday(${f.receivedAt}) > julianday(${at}, '-1 day')`,sql`julianday(${f.receivedAt}) <= julianday(${at})`)}).sync();
 const rows=connections.map(row=>({id:row.id,received:0,delivered:0,held:0})),byId=new Map(rows.map(row=>[row.id,row]));
 for(const receipt of incoming){const row=byId.get(receipt.connection)!;row.received++;if(receipt.state==='delivered')row.delivered++;if(receipt.state==='held')row.held++;}
 return rows;
}
