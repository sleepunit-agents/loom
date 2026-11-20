/** Runtime inputs are explicit snapshot roots; never resolve an environment default. */
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { RuntimeImportSources } from '../pieces/runtime/import-source.js';
import { canonicalRuntimeSource } from '../pieces/runtime/import-source.js';
type HouseholdIdentity={agents:readonly string[];members:readonly unknown[]};
export function sameRuntimeHousehold(current:HouseholdIdentity|undefined|null,source:HouseholdIdentity):boolean {
  return !!current&&canonicalRuntimeSource({agents:current.agents,members:current.members})===canonicalRuntimeSource({agents:source.agents,members:source.members});
}
export function runtimeMigrationSources(paths: readonly string[]): RuntimeImportSources {
  const result: RuntimeImportSources = {};
  for (const path of paths) {
    const key = basename(path)==='runtime.db'?'store':basename(path)==='runtime'?'state':basename(path)==='runtime-data'?'data':basename(path)==='household.db'?'household':undefined;
    if (!key || result[key]) throw Error('Invalid or duplicate runtime snapshot input');
    result[key]=path;
  }
  return result;
}
/** A stopped destination must be checkpointed before opening its private buffer. */
export function assertRuntimeCheckpointed(path:string):void {
  for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size)throw Error('Runtime destination must be stopped and checkpointed');
}
