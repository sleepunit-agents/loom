/** Explicit stopped-home metadata migration; no secret values are imported. */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalSnapshotPath } from './migration-snapshot.js';
import { parseArgs } from 'node:util';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importSecrets, SecretsImportRefusal } from '../pieces/secrets/importer.js';
import { assertSeparateSecretPaths, assertCopiedSecretSource, secretImportOptions } from '../pieces/secrets/import-source.js';
import type { IOStreams } from './io.js';
const usage='usage: loom migrate secrets --home <stopped-home> --from <secrets-directory> --identities <map.json>\n';
export async function migrateSecrets(argv:string[],io:IOStreams):Promise<number> {
  let args;
  try {args=parseArgs({args:argv,options:{home:{type:'string'},from:{type:'string'},identities:{type:'string'}},strict:true,allowPositionals:false});}
  catch {io.stderr(usage);return 2;}
  if(!args.values.home||!args.values.from||!args.values.identities){io.stderr(usage);return 2;}
  let release:(()=>void)|undefined;
  let check: 'destination-paths' | 'destination-lock' | 'destination-open' = 'destination-paths';
  try {
    let options;
    try {options=secretImportOptions.parse(JSON.parse(readFileSync(args.values.identities,'utf8')));}
    catch {throw new SecretsImportRefusal('identity-options');}
    let source;
    try {source=realpathSync(args.values.from);}
    catch {throw new SecretsImportRefusal('source-files');}
    const destination=canonicalSnapshotPath(resolve(args.values.home));
    assertSeparateSecretPaths(source,destination);
    try {assertCopiedSecretSource(source);}
    catch {throw new SecretsImportRefusal('copied-source');}
    check = 'destination-lock';
    release=acquireHttpLock(args.values.home);
    check = 'destination-open';
    const app=createFoundation({home:args.values.home});
    try {io.stdout(JSON.stringify(importSecrets(app.db,args.values.home,args.values.from,Date.now(),options))+'\n');return 0;}
    finally {app.close();}
  } catch (error) {if(error instanceof SecretsImportRefusal){io.stderr(error.message+'\n');return 1;}io.stderr(new SecretsImportRefusal(check).message+'\n');return 1;}
  finally {release?.();}
}
