import { parseArgs } from 'node:util';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { importComms } from '../pieces/comms/importer.js';
import { loadKey } from '../pieces/comms/crypto.js';
import type { IOStreams } from './io.js';
export async function migrateComms(argv:string[],io:IOStreams):Promise<number>{
 let args;try{args=parseArgs({args:argv,options:{from:{type:'string'},home:{type:'string'}},strict:true});}catch{io.stderr('usage: loom migrate comms --home <stopped-new-home> --from <old-home>\n');return 2;}
 if(!args.values.from||!args.values.home){io.stderr('usage: loom migrate comms --home <stopped-new-home> --from <old-home>\n');return 2;}
 let release:(()=>void)|undefined;
 try{release=acquireHttpLock(args.values.home);await loadKey(args.values.home);const app=createFoundation({home:args.values.home});try{io.stdout(JSON.stringify(await importComms(app.db,args.values.from,args.values.home))+'\n');return 0;}finally{app.close();}}
 catch{io.stderr('Comms import refused; source or destination did not satisfy the import contract\n');return 1;}finally{release?.();}
}
