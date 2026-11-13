import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importApprovals } from '../pieces/approvals/importer.js';
import type { IOStreams } from './io.js';
export async function migrateApprovals(argv:string[],io:IOStreams):Promise<number>{
  let args;try{args=parseArgs({args:argv,options:{from:{type:'string'},home:{type:'string'},projects:{type:'string'}},strict:true});}catch(e){io.stderr(`${(e as Error).message}\n`);return 2;}
  if(!args.values.from){io.stderr('usage: loom migrate approvals --from <old-directory> [--home <stopped-home>] [--projects <approval-or-conversation-to-project.json>]\n');return 2;}
  const home=args.values.home??io.env.LOOM_HOME??join(homedir(),'.config','loom');let release:(()=>void)|undefined;
  try{release=acquireHttpLock(home);const projects=args.values.projects?JSON.parse(await readFile(args.values.projects,'utf8')):undefined;if(projects!==undefined&&(!projects||typeof projects!=='object'||Array.isArray(projects)))throw Error('Project map must be an object');const app=createFoundation({home});try{io.stdout(JSON.stringify(importApprovals(app.db,args.values.from,Date.now(),{projects}),null,2)+'\n');return 0;}finally{app.close();}}
  catch(e){io.stderr(`approvals import refused: ${(e as Error).message}\n`);return 1;}finally{release?.();}
}
