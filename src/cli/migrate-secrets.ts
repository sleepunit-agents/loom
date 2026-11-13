/** Explicit stopped-home metadata migration; no secret values are imported. */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { canonicalSnapshotPath } from './migration-snapshot.js';
import { parseArgs } from 'node:util';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importSecrets } from '../pieces/secrets/importer.js';
import { secretImportOptions } from '../pieces/secrets/import-source.js';
import type { IOStreams } from './io.js';
const usage='usage: loom migrate secrets --home <stopped-home> --from <secrets-directory> --identities <map.json>\n';
export async function migrateSecrets(argv:string[],io:IOStreams):Promise<number> {
  let args;
  try {args=parseArgs({args:argv,options:{home:{type:'string'},from:{type:'string'},identities:{type:'string'}},strict:true,allowPositionals:false});}
  catch {io.stderr(usage);return 2;}
  if(!args.values.home||!args.values.from||!args.values.identities){io.stderr(usage);return 2;}
  let release:(()=>void)|undefined;
  try {
    const options=secretImportOptions.parse(JSON.parse(readFileSync(args.values.identities,'utf8')));
    const source=realpathSync(args.values.from), destination=canonicalSnapshotPath(resolve(args.values.home));
    if(source===destination || source.startsWith(destination+sep) || destination.startsWith(source+sep))throw Error();
    release=acquireHttpLock(args.values.home);
    const app=createFoundation({home:args.values.home});
    try {io.stdout(JSON.stringify(importSecrets(app.db,args.values.home,args.values.from,Date.now(),options))+'\n');return 0;}
    finally {app.close();}
  } catch {io.stderr('Secrets import refused; check source, identities and imported household, and stop the destination daemon.\n');return 1;}
  finally {release?.();}
}
