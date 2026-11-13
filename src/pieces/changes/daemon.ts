/** New-mode composition seam. The root owns close(), before closing the foundation. */
import type { Foundation } from '../../core/app.js';
import type { Clock, Sharing, Viewer } from '../../core/index.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { installChanges } from './index.js';
import { startChangesJob } from './jobs.js';
import { githubReader } from './github.js';
import type { Attribution } from './model.js';
import type { Approvals, Projects, Secrets } from './roles.js';

export function householdProjects(store: SharingDatabase): Projects {
 return {list:()=>store.projectIds().map(id=>{
  const project=store.project(id)!;
  return {slug:project.slug,name:project.name,repos:project.repositories};
 })};
}

/** Secrets remain injected; installation never discovers credentials or old stores. */
export function installChangesDaemon(app: Foundation, options: {
 home: string; clock: Clock; sharing:()=>Sharing; viewer: Viewer;
 attribution:()=>Attribution; secrets: Secrets; approvals?: Approvals;
 staging?: boolean; interval?: number; request?: typeof fetch;
}) {
 let job: ReturnType<typeof startChangesJob> | undefined;
 installChanges(app.db,app.operations,app.live,options.sharing,{
  attribution:options.attribution,approvals:options.approvals,onRefresh:()=>job?.wake(),
 });
 job=startChangesJob(app,{
  ...options,projects:householdProjects(new SharingDatabase(app.db,options.home)),
  read:githubReader(options.secrets,options.request),
 });
 return job;
}
