/** Daemon-owned job. Durable refresh requests; safe to repeat after a crash because every forge call is a read. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, mayAct, type Clock, type Sharing, type Viewer } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import { active, attribute, changeSchema, repoId, type Attribution, type Change } from './model.js';
import { projectFor } from './importer.js';
import { loadChanges, replaceChanges } from './store.js';
import type { Projects } from './roles.js';
export function startChangesJob(app:Foundation,options:{clock:Clock;sharing:()=>Sharing;viewer:Viewer;projects:Projects;attribution:()=>Attribution;read(repo:string,now:number):Promise<Change[]>;interval?:number;staging?:boolean}) {
 const {clock}=options;const interval=Math.max(60000,Math.min(3600000,options.interval??180000));let stopped=false,busy=false,cancel:(()=>void)|undefined;
 app.operations.register(operation({name:'changes.commit-sync',write:true,doors:['direct'],input:z.object({records:z.array(changeSchema.extend({project:z.string().optional(),agent:z.string().optional(),mine:z.boolean().optional(),syncError:z.string().optional()})),due:z.number(),error:z.boolean()}),output:z.null(),
  may:v=>mayAct(v,{type:'change'},options.sharing(),'household','changes.commit-sync'),
  run(ctx,input){
   // Only this job calls this operation; no external door offers a snapshot write.
   for(const id of replaceChanges(app.db,input.records as Change[])) ctx.changed('change',id);
   app.db.prepare('INSERT INTO changes_jobs VALUES(1,?,0) ON CONFLICT(id) DO UPDATE SET due=excluded.due,running=0').run(input.due);
   app.db.prepare("INSERT INTO changes_meta VALUES('sync-status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({at:ctx.now,error:input.error,held:!!options.staging}));
   ctx.changed('change-sync','status');return null;
  }
 }));
 app.db.prepare('INSERT OR IGNORE INTO changes_jobs(id,due) VALUES(1,?)').run(clock.now());
 const schedule=(wake=false)=>{cancel?.();if(!stopped) {const row=app.db.prepare('SELECT due FROM changes_jobs WHERE id=1').get() as {due:number};cancel=clock.at(wake?clock.now():Math.max(clock.now()+1,row.due),()=>{void tick();});}};
 const tick=async()=>{
  if(stopped||busy) return;
  const row=app.db.prepare('SELECT due FROM changes_jobs WHERE id=1').get() as {due:number};
  if(row.due>clock.now()){schedule();return;}
  busy=true;let error=false;
  try {
   const projects=options.projects.list(),repos=[...new Set(projects.flatMap(p=>p.repos.map(repoId)))],now=clock.now(),before=loadChanges(app.db),records:Change[]=[];
   for(const repo of repos) {
    const project=projectFor(repo,projects);
    try {
     const got=options.staging?before.filter(c=>c.repo===repo):await options.read(repo,now);
     if(stopped) return;
     if(got.some(c=>c.repo!==repo||c.id!==`${repo}#${c.number}`)) throw new Error('Wrong repository');
     for(const c of got.filter(c=>active(c,now))) {const value=attribute(c,options.attribution());delete value.project;delete value.syncError;if(project) value.project=project;records.push(value);}
    } catch {error=true;for(const c of before.filter(c=>c.repo===repo&&active(c,now))) {const value={...c,syncError:'GitHub read unavailable'};delete value.project;if(project) value.project=project;records.push(value);}}
   }
   if(!stopped){const answer=app.operations.call('direct',options.viewer,'changes.commit-sync',{records,due:clock.now()+interval,error},randomUUID());if(!answer.ok) error=true;}
  } catch {error=true;} finally {busy=false;schedule();}
 };
 schedule();
 return {run:tick,wake(){schedule(true);},close(){stopped=true;cancel?.();}};
}
