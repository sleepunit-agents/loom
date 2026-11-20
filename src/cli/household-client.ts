/** Household commands share the same outside API as the main CLI and browser. */
import { runAccessClient } from './access-client.js';
import type { IOStreams } from './io.js';
import type { ClientRuntime } from './io.js';
export function runHouseholdClient(argv:string[],io:IOStreams,runtime?:ClientRuntime & {now?:()=>number}) {
  return runAccessClient('household',argv,io,runtime);
}
