/** One explicit piece import from a completed snapshot into a stopped household. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createFoundation } from '../core/app.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { parseHouseholdDocument } from '../household.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { readRuntimeImport } from '../pieces/runtime/import-source.js';
import { prepareMigrationPlan } from './migration-plan.js';
import { separateDestination } from './migration-all.js';
import { createMigrationRegistry, snapshotPath } from './migration-registry.js';
import { runtimeMigrationSources, assertRuntimeCheckpointed, sameRuntimeHousehold } from './migration-runtime.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import type { IOStreams } from './io.js';
const usage='usage: loom migrate runtime --home <stopped-new-home> --from <completed-snapshot> --mapping <runtime-mapping.json>\n';
export async function migrateRuntime(argv:string[],io:IOStreams):Promise<number> {
  let args;
  try {args=parseArgs({args:argv,options:{home:{type:'string'},from:{type:'string'},mapping:{type:'string'}},strict:true,allowPositionals:false});}
  catch {io.stderr(usage);return 2;}
  if(!args.values.home||!args.values.from||!args.values.mapping){io.stderr(usage);return 2;}
  let release:(()=>void)|undefined;
  try {
    const prepared=prepareMigrationPlan(args.values.from),input=prepared.plan.importers.runtime;
    if(!input)throw Error('Runtime input required');
    input.options=JSON.parse(readFileSync(args.values.mapping,'utf8'));
    const context={snapshot:{root:prepared.root,manifest:prepared.manifest}};
    const sourceHome=snapshotPath(context,'home');
    const h=parseHouseholdDocument(sourceHome,JSON.parse(readFileSync(join(sourceHome,'household.json'),'utf8')));
    separateDestination(prepared.root,args.values.home,prepared.plan);
    release=acquireHttpLock(args.values.home);
    const path=join(args.values.home,'loom.db');assertRuntimeCheckpointed(path);
    const destination=openSnapshotSqlite(path);
    try {
      const current=new HouseholdDatabase(destination).household(args.values.home);
      if(!sameRuntimeHousehold(current,h))throw Error('Destination household differs from snapshot');
      const identities={agents:h.agents,members:h.members.map(m=>m.person),projects:new SharingDatabase(destination,args.values.home).projectIds()};
      readRuntimeImport(runtimeMigrationSources(input.paths.map(p=>snapshotPath(context,p))),input.options,identities,openSnapshotSqlite);
    } finally {destination.close();}
    const app=createFoundation({home:args.values.home});
    try {
      const current=new HouseholdDatabase(app.db).household(args.values.home);
      if(!sameRuntimeHousehold(current,h))throw Error('Destination household differs from snapshot');
      const entry=createMigrationRegistry().order(['runtime']).importers.find(i=>i.name==='runtime')!;
      io.stdout(JSON.stringify(await entry.run({...context,db:app.db,home:args.values.home,now:Date.now()},input))+'\n');return 0;
    } finally {app.close();}
  } catch {io.stderr('Runtime migration refused; check the copied source, explicit mappings and stopped destination.\n');return 1;}
  finally {release?.();}
}
