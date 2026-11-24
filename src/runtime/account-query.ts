/** Account column privacy at the shared GraphQL door. No credentials are read. */
import { GraphQLBoolean, GraphQLFloat, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType, type GraphQLFieldConfigMap, type GraphQLOutputType } from 'graphql/index.js';
import { sharedSharing } from '../shared-sharing.js';
import { SILENCE_MS } from './silence.js';
import { LOGIN_ENDING_MS, loginMachineReporting } from './account-logins.js';
import { holds, rules, type Viewer } from '../policy.js';
import type { DataDatabase } from '../core/data/database.js';
import { reportedAccountCapacity } from './account-windows.js';
import { allowedModelAccounts, modelAccountAuthority, readAccountCapacityRows, readModelAccounts } from '../core/data/model-account-read.js';

import {weeklyWindowEstimates} from './account-weekly-usage.js';
import {visibleWeeklyGroups, WeeklyVisibility} from './job-usage-queries.js';
import type {JobSummaries} from './job-summary.js';

const text = new GraphQLNonNull(GraphQLString);
const common = { label: { type: text }, level: { type: text } };
const account = new GraphQLInterfaceType({ name: 'RuntimeAccount', fields: common });
const summary = new GraphQLObjectType({ name: 'RuntimeAccountSummary', interfaces: [account], fields: common });
type PrivateColumn = 'id' | 'owner' | 'provider' | 'usage' | 'usageReadAt' | 'resetsAt' | 'hasRoom' | 'signedInOn' | 'logins' | 'windows' | 'pendingSignIns' | 'weeklyUsage';
const column = (name: PrivateColumn, type: GraphQLOutputType) => ({ type,
  resolve: (value: { read(name: PrivateColumn, viewer: Viewer): unknown }, _args: unknown, context: { viewer: Viewer }) => value.read(name, context.viewer),
});
const machine = new GraphQLObjectType({ name: 'RuntimeAccountBox', fields: { id: { type: text }, name: { type: text } } });
/** One sign-in of the account as loom last learned it (account-logins.ts). Usage is the account's, not a sign-in's. */
const login = new GraphQLObjectType({ name: 'RuntimeAccountLogin', fields: {
  box: { type: new GraphQLNonNull(machine) }, harness: { type: text }, place: { type: text }, state: { type: text },
  expired: { type: GraphQLBoolean }, reporting: { type: GraphQLBoolean }, needsSignIn: { type: GraphQLBoolean }, canRequest: { type: GraphQLBoolean },
  expiresAt: { type: GraphQLString }, checkedAt: { type: text }, since: { type: text }, learnedFrom: { type: text }, why: { type: GraphQLString },
} });
const windowReading = new GraphQLObjectType({ name: 'RuntimeAccountWindow', fields: {
  window: { type: text }, usage: { type: GraphQLFloat }, usageReadAt: { type: GraphQLString },
  resetsAt: { type: GraphQLString }, reserve: { type: GraphQLFloat },
} });
const weeklyGroup = new GraphQLObjectType({name:'WeeklyUsageGroup',fields:{
  key:{type:GraphQLString},title:{type:text},share:{type:new GraphQLNonNull(GraphQLFloat)},href:{type:GraphQLString},
}});
const groups = {type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(weeklyGroup)))};
const weeklyUsage = new GraphQLObjectType({name:'AccountWeeklyUsage',fields:{
  window:{type:text},usage:{type:GraphQLFloat},readAt:{type:text},resetsAt:{type:text},
  unattributed:{type:GraphQLFloat},agents:groups,triggers:groups,conversations:groups,
}});
const detail = new GraphQLObjectType({ name: 'RuntimeAccountDetail', interfaces: [account], fields: {
  weeklyUsage:column('weeklyUsage',new GraphQLList(new GraphQLNonNull(weeklyUsage))),
  ...common, id: column('id', text), owner: column('owner', text), provider: column('provider', text), usage: column('usage', GraphQLFloat),
  usageReadAt: column('usageReadAt', GraphQLString), resetsAt: column('resetsAt', GraphQLString),
  hasRoom: column('hasRoom', new GraphQLNonNull(GraphQLBoolean)),
  pendingSignIns: column('pendingSignIns',new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(machine)))),
  signedInOn: column('signedInOn', new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(machine)))),
  windows: column('windows', new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(windowReading)))),
  logins: column('logins', new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(login)))),
} });
// The union registers both concrete types with the generated schema. Their
// shared interface lets clients select label/level with one common fragment.
const view = new GraphQLUnionType({ name: 'RuntimeAccountView', types: [summary, detail] });

function subscriptionCapacity(row: ReturnType<typeof readAccountCapacityRows>[number], at: string) {
  const capacity = reportedAccountCapacity(row.hasRoom, row.modelAccountWindowsByAccount, at);
  return { label: row.label, level: capacity.hasRoom ? capacity.level : 'almost full', hasRoom: capacity.hasRoom };
}

type AccountWindows = ReturnType<typeof readAccountCapacityRows>[number]['modelAccountWindowsByAccount'];

function weeklyReportReader(db:DataDatabase, at:string, scope:()=>JobSummaries|undefined, witness:()=>WeeklyVisibility) {
  type Report = ReturnType<typeof visibleWeeklyGroups>[number] & {window:string;usage:number|null;readAt:string|null;resetsAt:string|null};
  type Read = {account:string;windows:AccountWindows;resolve:(value:Report[]|null)=>void;reject:(error:unknown)=>void};
  let reads:Read[] = [];
  function flush() {
    const batch = reads;
    reads = [];
    try {
      const current = scope();
      if (!current) { for (const read of batch) read.resolve(null); return; }
      const accounts = new Map(batch.map(read=>[read.account,read.windows]));
      const windows = [...accounts].flatMap(([account,windows])=>windows.map(row=>({account,
        window:{name:row.window,usage:row.usage,readAt:row.usageReadAt,resetsAt:row.resetsAt,durationMs:row.durationMs}})));
      const estimates = [...weeklyWindowEstimates(db,windows,at)];
      const projected = visibleWeeklyGroups(current,estimates.map(([,value])=>value),witness());
      const reports = new Map<string,Report[]>();
      estimates.forEach(([index],i)=>{
        const {account,window} = windows[index];
        const list = reports.get(account) ?? [];
        list.push({window:window.name,usage:window.usage,readAt:window.readAt,resetsAt:window.resetsAt,...projected[i]});
        reports.set(account,list);
      });
      for (const read of batch) read.resolve(reports.get(read.account) ?? []);
    } catch (error) { for (const read of batch) read.reject(error); }
  }
  return (account:string,windows:AccountWindows)=>new Promise<Report[]|null>((resolve,reject)=>{
    if (!reads.length) queueMicrotask(flush);
    reads.push({account,windows,resolve,reject});
  });
}

export function modelAccountQueries(db: DataDatabase, now: () => string, usageScope?: (viewer:Viewer)=>JobSummaries | undefined, jobScope?: (viewer:Viewer)=>JobSummaries, wakeForLogins?: (at:number)=>void) {
  // The same admitted Viewer object reaches GraphQL context and auth.valid().
  // Retain only the resource identifiers needed to recheck selected private fields.
  const witnesses = new WeakMap<Viewer, Set<string>>();
  const usageChecks = new WeakMap<Viewer,WeeklyVisibility>();
  function witness(viewer: Viewer, id: string) {
    let ids = witnesses.get(viewer);
    if (!ids) { ids = new Set(); witnesses.set(viewer, ids); }
    ids.add(id);
  }
  const fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = { modelAccounts: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(view))),
    args: { detailId: { type: GraphQLString } },
    resolve(_source, { detailId }, { viewer }) {
      const at = now();
      // Public order must not expose the ordering of hidden account identifiers.
      const selected = readModelAccounts(db, viewer, detailId ?? undefined);
      // Looking up even a public label by its private identifier is a private selection.
      if (detailId != null) {
        if (!selected.privateRows.has(detailId) || !selected.rows.length) return [];
        witness(viewer, detailId);
      }
      const current = modelAccountAuthority(db, viewer);
      const weekly = weeklyReportReader(db,at,()=>usageScope?.(viewer),()=>{
        let watched = usageChecks.get(viewer);
        if (!watched) { watched = new WeeklyVisibility(); usageChecks.set(viewer,watched); }
        return watched;
      });
      let sharing: ReturnType<typeof sharedSharing> | undefined;
      return selected.rows.map(row => {
        const {label, level, hasRoom} = subscriptionCapacity(row, at);
        const publicFields = { label, level };
        const privateRow = selected.privateRows.get(row.id);
        if (!privateRow) return { __typename: summary.name, ...publicFields };
        const nowMs=Date.parse(at);
        const logins=privateRow.logins.map(login=>{
          const reporting=!login.box.revokedAt&&loginMachineReporting(login.box.lastSeenAt,nowMs);
          const needsSignIn=reporting&&(login.state==='signed-out'||login.expiresAt!==null&&Date.parse(login.expiresAt)-nowMs<=LOGIN_ENDING_MS);
          const canRequest=needsSignIn&&viewer.kind==='member'&&holds(rules.asksSignIn,viewer,{accountOwner:privateRow.owner,boxOwner:login.box.owner},sharing??=sharedSharing(db));
          const expired=reporting&&login.state==='signed-in'&&login.expiresAt!==null&&Date.parse(login.expiresAt)<=nowMs;
          return {...login,reporting,needsSignIn,canRequest,expired};
        });
        const values = { ...privateRow, logins, hasRoom, windows: row.modelAccountWindowsByAccount };
        return { __typename: detail.name, ...publicFields, read(name: PrivateColumn, actor: Viewer) {
          if (actor !== viewer) throw new Error('Account access ended');
          // Unscoped public-only selections never acquire a private witness. Record an
          // actual private column access before checking its current authority.
          witness(viewer, row.id);
          return current(row.id).then<unknown>(() => {
            if (name === 'logins' && wakeForLogins) {
              // Only a selected, authorized list schedules a wake. A single coordinator
              // timer covers all readers and the next read discovers the next transition.
              for (const login of logins) {
                if (login.box.revokedAt || !login.box.lastSeenAt) continue;
                const seen = Date.parse(login.box.lastSeenAt);
                if (seen > nowMs) wakeForLogins(seen);
                if (!login.reporting) continue;
                wakeForLogins(seen + SILENCE_MS + 1);
                if (login.state === 'signed-in' && login.expiresAt) {
                  const end = Date.parse(login.expiresAt);
                  if (end > nowMs) wakeForLogins(end);
                  const warning = end - LOGIN_ENDING_MS;
                  if (warning > nowMs) wakeForLogins(warning);
                }
              }
            }
            if (name !== 'weeklyUsage') return values[name];
            return weekly(row.id,values.windows);
          });
        },
        };
      });
    },
  }, jobSubscription: {
    type: summary, args: { agent: {type:text}, job: {type:text} },
    resolve(_source, {agent, job}, {viewer}) {
      const account = jobScope?.(viewer).subscriptionAccount(agent, job);
      if (!account) return null;
      const [row] = readAccountCapacityRows(db, viewer, account);
      if (!row) return null;
      const {label, level} = subscriptionCapacity(row, now());
      return {label, level};
    },
  } };
  return {
    fields,
    /** Rechecked after public awaits and on socket refresh/delivery. Reject a
     * previously private selection if its CURRENT ownership no longer permits it. */
    valid(viewer: Viewer) {
      const ids = [...(witnesses.get(viewer) ?? [])];
      if (allowedModelAccounts(db, viewer, ids).size !== ids.length) return false;
      const watched = usageChecks.get(viewer);
      if (!watched) return true;
      const scope = usageScope?.(viewer);
      return !!scope && watched.valid(scope);
    },
  };
}
