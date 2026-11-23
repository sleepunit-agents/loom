import {and,asc,eq,isNull} from 'drizzle-orm';
import type {DataDatabase} from './database.js';

/** One snapshot of the active machine and the roster and facts its owner manages. */
export const readMachineSettings=(db:DataDatabase,id:string)=>db.query.boxes.findFirst({
  where:f=>and(eq(f.id,id),isNull(f.revokedAt)),
  columns:{id:true,owner:true,readers:true,name:true,hostsAny:true,reportOnly:true,alwaysOn:true},
  with:{
   boxAgentsByBox:{columns:{agent:true,lent:true},orderBy:f=>asc(f.agent)},
   boxFactsByBox:{columns:{fact:true},where:f=>eq(f.fromOwner,true),orderBy:f=>asc(f.fact)},
  },
 }).sync();
