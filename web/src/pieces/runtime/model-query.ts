import {liveAgents} from '../../data/live-agents';
/** The worker breaks equal preference positions by the model identifier. */
export const agentModelsSelection='agentModels(orderBy:{agent:{direction:asc,priority:2},position:{direction:asc,priority:1},model:{direction:asc,priority:0}}){agent model position}';
export const runtimeAccountsQuery=`query RuntimeModelAccounts {
 deskTime { timezone }
 agents { id removedAt }
 ${agentModelsSelection}
 modelAccounts {
  __typename
  ... on RuntimeAccount { label level }
  ... on RuntimeAccountDetail { id owner provider usage usageReadAt resetsAt hasRoom signedInOn { id name } pendingSignIns { id name } windows { window usage usageReadAt resetsAt reserve } logins { box { id name } harness place state expiresAt checkedAt reporting expired needsSignIn canRequest } }
 }
}`;

/** What the Subscriptions app reads and says about a model account, as types and plain functions with no
 * component: the desktop's cards (./model-accounts.tsx) and the boards page's `subscriptions` brick share them. */
export type RuntimeAccountSummary={__typename:'RuntimeAccountSummary';label:string;level:string};
export type UsageWindow={window:string;usage:number|null;usageReadAt:string|null;resetsAt:string|null;reserve:number|null};
export type AccountLogin={reporting:boolean;expired:boolean;needsSignIn:boolean;canRequest:boolean;box:{id:string;name:string};place:'host'|'containers';harness:string;state:'signed-in'|'signed-out';expiresAt:string|null;checkedAt:string};
export type RuntimeAccountDetail={__typename:'RuntimeAccountDetail';label:string;level:string;id:string;owner:string;provider:string;usage:number|null;usageReadAt:string|null;resetsAt:string|null;hasRoom:boolean;pendingSignIns:{id:string;name:string}[];windows:UsageWindow[];logins:AccountLogin[];signedInOn:{id:string;name:string}[]};
export type RuntimeAccount=RuntimeAccountSummary|RuntimeAccountDetail;
export type AgentModel={agent:string;model:string;position:number};
export type RuntimeAccountsData={modelAccounts:RuntimeAccount[];agentModels:AgentModel[];agents?:{id:string;removedAt:string|null}[]|null;deskTime:{timezone:string}|null};
export const usagePercent=(n:number)=>Math.round(n*100)+'%';
export const windowName=(name:string)=>({session:'Session',week:'Week',weekly:'Week','five-hour':'Five hours','5h':'Five hours'}[name]??name);
/** How an account's sign-ins stand: signed in and reporting, needing attention, and known only from before. */
export function loginCounts(account:RuntimeAccountDetail) {
 const logins=account.logins ?? [];
 return {signedIn:logins.filter(login=>login.reporting && !login.expired && login.state==='signed-in').length,
  attention:logins.filter(login=>login.reporting && login.needsSignIn).length,
  lastKnown:logins.filter(login=>!login.reporting).length};
}
/** One account's heading in one line: its label, owner and level, then how its sign-ins stand. */
export function accountLine(account:RuntimeAccountDetail):string {
 const logins=account.logins ?? [],{signedIn,attention,lastKnown}=loginCounts(account);
 return `${account.label} · ${account.owner} · ${account.level} · ${logins.length ? `${signedIn} signed in` : 'No sign-ins reported'}`
  +(attention>0 ? ` · ${attention} ${attention===1?'needs':'need'} attention` : '')
  +(lastKnown>0 ? ` · ${lastKnown} last known` : '')
  +(account.pendingSignIns?.length ? ' · Sign-in requested' : '');
}
export const loginLine=(login:AccountLogin)=>`${login.harness} · ${login.place==='host'?'On the machine':'In houses'}`;
export const loginState=(login:AccountLogin)=>(login.reporting?'':'Last known: ')+(login.expired?'Expired':login.state==='signed-in'?'Signed in':'Signed out');
/** The accounts that match what was typed and the "needs attention" choice, by service. Accounts shown only as
 * a summary have no service and are grouped under null. */
export function accountServices(rows:readonly RuntimeAccount[],search:string,attentionOnly:boolean):Map<string|null,RuntimeAccount[]> {
 const services=new Map<string|null,RuntimeAccount[]>();
 const needle=search.trim().toLowerCase();
 for(const account of rows){
  const provider=account.__typename==='RuntimeAccountDetail'?account.provider:null;
  const searchable=[account.label];
  if(account.__typename==='RuntimeAccountDetail'){
   searchable.push(account.provider,account.owner,...account.signedInOn.map(box=>box.name),
    ...(account.logins??[]).map(login=>login.box.name),...(account.pendingSignIns??[]).map(box=>box.name));
  }
  if(!searchable.some(value=>value.toLowerCase().includes(needle)))continue;
  if(attentionOnly && account.level!=='almost full' &&
    !(account.__typename==='RuntimeAccountDetail' && account.logins?.some(login=>login.needsSignIn)))continue;
  const group=services.get(provider)??[];
  group.push(account);
  services.set(provider,group);
 }
 return services;
}
/** The fullest level among a service's accounts, and whether any of them needs a sign-in. */
export const serviceLevel=(accounts:readonly RuntimeAccount[])=>accounts.some(a=>a.level==='almost full')?'almost full':accounts.some(a=>a.level==='getting full')?'getting full':accounts[0].level;
export const serviceNeedsSignIn=(accounts:readonly RuntimeAccount[])=>accounts.some(a=>a.__typename==='RuntimeAccountDetail'&&a.logins?.some(l=>l.needsSignIn));
export const serviceLine=(provider:string|null,accounts:readonly RuntimeAccount[])=>
 `${provider??'Shared summaries'} · ${accounts.length} · ${serviceLevel(accounts)}`+(serviceNeedsSignIn(accounts)?' · Sign-in needed':'');
/** Each agent's models in preference order, for agents in use; a removed agent keeps its rows for a restore. */
export function modelGroups(data:RuntimeAccountsData|undefined):Map<string,AgentModel[]> {
 const groups=new Map<string,AgentModel[]>(),roster=data?.agents;
 const inUse=roster ? new Set(liveAgents(roster).map(agent=>agent.id)) : undefined;
 for(const row of data?.agentModels??[])if(!inUse||inUse.has(row.agent))groups.set(row.agent,[...(groups.get(row.agent)??[]),row]);
 return groups;
}

/** Weekly usage by agent, trigger and conversation (./weekly-usage.tsx). */
export type WeeklyGroup = {key:string|null;title:string;share:number;href:string|null};
export type WeeklyWeek = {window:string;resetsAt:string;usage:number;unattributed:number;agents:WeeklyGroup[];triggers:WeeklyGroup[];conversations:WeeklyGroup[]};
export type WeeklyAccount = {id?:string;label?:string;weeklyUsage?:WeeklyWeek[]|null};
export type WeeklyDimension = 'agents'|'triggers'|'conversations';
export const weeklyUsageQuery = `query WeeklySubscriptions($detailId:String) {
  modelAccounts(detailId:$detailId) { ... on RuntimeAccountDetail { id label weeklyUsage {
    window resetsAt usage unattributed agents {key title share href} triggers {key title share href} conversations {key title share href}
  } } }
}`;
export const weeklyNote='Each percentage is a share of that subscription’s weekly allowance. Loom estimates shares from changes in provider readings and token counts for overlapping jobs.';

/** What a member may add a subscription with (../subscriptions/create.tsx). */
export type SubscriptionSetup={member:string;providers:string[];machines:{id:string;name:string}[]};
export const subscriptionSetupQuery='{ subscriptionSetup { member providers machines { id name } } }';
/** What adding a subscription and asking for a sign-in say when they end. */
export const subscriptionWords={
 noLabel:'Give the subscription a label.',
 added:(machines:number)=>machines?'Subscription added. Each selected machine has a sign-in request. Watch Inbox for the provider’s instructions.':'Subscription added.',
 notConfirmed:'Could not confirm creation. Check the list or retry with the same settings.',
 signInSent:'Sign-in requested. The subscription owner will receive the provider’s instructions in Inbox.',
 signInFailed:'Could not confirm the request. Check Inbox or retry.',
 stale:' · Stale reading (over an hour old)',
};
/** A usage reading over an hour old is said to be stale. */
export const usageReadStale=(read:number,now:number)=>now-read>3_600_000;
