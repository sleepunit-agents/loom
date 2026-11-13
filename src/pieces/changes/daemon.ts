/** New-mode composition seam. The root owns close(), before closing the foundation. */
import type { Foundation } from '../../core/app.js';
import type { Clock, Sharing, Viewer } from '../../core/index.js';
import { HouseholdAccounts } from '../../core/household/accounts.js';
import { HouseholdDatabase } from '../../core/household/document.js';
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

/** Public account metadata is read afresh for every projection; no legacy identity guesses. */
export function householdAttribution(db: Foundation['db'], home: string): Attribution {
 const accounts=new HouseholdAccounts(db,home);
 const agents=new HouseholdDatabase(db).household(home)?.agents??[];
 return {agents:Object.fromEntries(agents.map(agent=>[agent,{logins:accounts.get(agent).github,branches:[]}])),ownerLogins:[]};
}

/** Secrets remain injected; installation never discovers credentials or old stores. */
export function installChangesDaemon(app: Foundation, options: {
 home: string; clock: Clock; sharing:()=>Sharing; viewer: Viewer;
 attribution:()=>Attribution; secrets: Secrets; approvals?: Approvals;
 staging?: boolean; interval?: number; request?: typeof fetch;
}) {
 const projects=householdProjects(new SharingDatabase(app.db,options.home));
 const knownAgents=()=>new HouseholdDatabase(app.db).household(options.home)?.agents??[];
 let job: ReturnType<typeof startChangesJob> | undefined;
 installChanges(app.db,app.operations,app.live,options.sharing,{
  attribution:options.attribution,knownAgents,projects,approvals:options.approvals,onRefresh:()=>job?.wake(),
 });
 job=startChangesJob(app,{
  ...options,projects,knownAgents,
  read:githubReader(options.secrets,options.request),
 });
 return job;
}
