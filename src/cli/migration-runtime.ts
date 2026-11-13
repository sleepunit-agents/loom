/** Runtime inputs are explicit snapshot roots; never resolve an environment default. */
import { basename } from 'node:path';
import type { RuntimeImportSources } from '../pieces/runtime/import-source.js';
export function runtimeMigrationSources(paths: readonly string[]): RuntimeImportSources {
  const result: RuntimeImportSources = {};
  for (const path of paths) {
    const key = basename(path)==='runtime.db'?'store':basename(path)==='runtime'?'state':basename(path)==='runtime-data'?'data':undefined;
    if (!key || result[key]) throw Error('Invalid or duplicate runtime snapshot input');
    result[key]=path;
  }
  return result;
}
