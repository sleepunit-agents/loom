/** Owning offline transaction. No daemon, adapters or credentials are started. */
import { migrate,type Db } from '../../core/index.js';
import { schema } from './schema/001.js';
import { schema as retry } from './schema/002.js';
import { schema as slack } from './schema/003.js';
import { schema as discord } from './schema/004.js';
import { readBridgeImport,type BridgeImportSources } from './import-plan.js';
import type Database from 'better-sqlite3';
import { bridgeImportTables } from './import-projection.js';
export function importBridges(db:Db,sources:BridgeImportSources,options:unknown,household:{agents:string[];members:string[]},open:(path:string)=>Database.Database,hooks:{interrupt?:()=>void}={}){
  const source=readBridgeImport(sources,options,household,open),expected=bridgeImportTables(source);
  return db.transaction(()=>{
    migrate(db,'bridges',[...schema,...retry,...slack,...discord]);
    const old=db.prepare("SELECT value FROM bridges_meta WHERE key='source-checksum'").get() as {value:string}|undefined;
    if(old){if(old.value!==source.checksum)throw Error('A different Bridges source was already imported');return {ok:true,imported:false,checksum:source.checksum};}
    for(const table of Object.keys(expected))if(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())throw Error('Bridges destination must be empty before import');
    for(const [table,rows]of Object.entries(expected))for(const row of rows){const columns=Object.keys(row);db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));}
    hooks.interrupt?.();
    for(const [table,rows]of Object.entries(expected)){
      const order=(rs:unknown[])=>JSON.stringify(rs.map(r=>JSON.stringify(r)).sort());
      if(order(db.prepare(`SELECT * FROM ${table}`).all())!==order(rows))throw Error('Bridges import comparison failed: ids, counts or content differ');
    }
    return {ok:true,imported:true,checksum:source.checksum};
  })();
}
