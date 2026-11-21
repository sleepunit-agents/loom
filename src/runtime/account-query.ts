/** Account column privacy at the shared GraphQL door. No credentials are read. */
import { GraphQLBoolean, GraphQLFloat, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType, type GraphQLFieldConfigMap, type GraphQLOutputType } from 'graphql/index.js';
import { sharedSharing } from '../shared-sharing.js';
import { LOGIN_ENDING_MS, loginMachineReporting } from './account-logins.js';
import { holds, rules, type Viewer } from '../policy.js';
import type { DataDatabase } from '../core/data/database.js';
import { accountCapacity } from './quota.js';
import { allowedModelAccounts, modelAccountAuthority, readModelAccounts } from '../core/data/model-account-read.js';

import {accountWeeklyUsage} from './account-weekly-usage.js';
import {visibleWeeklyGroups} from './job-usage-queries.js';
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
  reporting: { type: GraphQLBoolean }, needsSignIn: { type: GraphQLBoolean }, canRequest: { type: GraphQLBoolean },
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

export function modelAccountQueries(db: DataDatabase, now: () => string, usageScope?: (viewer:Viewer)=>JobSummaries | undefined) {
  // The same admitted Viewer object reaches GraphQL context and auth.valid().
  // Retain only selected account IDs, never usage/provider/location values or a credential.
  const witnesses = new WeakMap<Viewer, Set<string>>();
  const usageChecks = new WeakMap<Viewer,Map<string,()=>boolean>>();
  const fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = { modelAccounts: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(view))),
    resolve(_source, _args, { viewer }) {
      const at = now();
      // Public order must not expose the ordering of hidden account identifiers.
      const selected = readModelAccounts(db, viewer);
      const current = modelAccountAuthority(db, viewer);
      let sharing: ReturnType<typeof sharedSharing> | undefined;
      return selected.rows.map(row => {
        let capacity;
        try { capacity = accountCapacity(row.modelAccountWindowsByAccount.map(window => ({ name: window.window, usage: window.usage, readAt: window.usageReadAt, resetsAt: window.resetsAt, durationMs: window.durationMs, reserve: window.reserve })), at); }
        catch { capacity = accountCapacity([], at); }
        capacity.hasRoom = row.hasRoom && capacity.hasRoom;
        const publicFields = { label: row.label, level: capacity.hasRoom ? capacity.level : 'almost full' };
        const privateRow = selected.privateRows.get(row.id);
        if (!privateRow) return { __typename: summary.name, ...publicFields };
        const nowMs=Date.parse(at);
        const logins=privateRow.logins.map(login=>{
          const reporting=!login.box.revokedAt&&loginMachineReporting(login.box.lastSeenAt,nowMs);
          const needsSignIn=reporting&&(login.state==='signed-out'||login.expiresAt!==null&&Date.parse(login.expiresAt)-nowMs<=LOGIN_ENDING_MS);
          const canRequest=needsSignIn&&viewer.kind==='member'&&holds(rules.asksSignIn,viewer,{accountOwner:privateRow.owner,boxOwner:login.box.owner},sharing??=sharedSharing(db));
          return {...login,reporting,needsSignIn,canRequest};
        });
        const values = { ...privateRow, logins, hasRoom: capacity.hasRoom, windows: row.modelAccountWindowsByAccount };
        return { __typename: detail.name, ...publicFields, read(name: PrivateColumn, actor: Viewer) {
          if (actor !== viewer) throw new Error('Account access ended');
          // Public-only selections never acquire a private witness. Record an
          // actual private column access before checking its current authority.
          let selected = witnesses.get(viewer);
          if (!selected) { selected = new Set(); witnesses.set(viewer, selected); }
          selected.add(row.id);
          return current(row.id).then(() => {
            if (name !== 'weeklyUsage') return values[name];
            const scope = usageScope?.(viewer);
            if (!scope) return null;
            const reports = [], checks:Array<()=>boolean> = [];
            for (const window of values.windows) {
              const estimate = accountWeeklyUsage(db,row.id,{name:window.window,usage:window.usage,readAt:window.usageReadAt,
                resetsAt:window.resetsAt,durationMs:window.durationMs,reserve:window.reserve},at);
              if (!estimate) continue;
              const projected = visibleWeeklyGroups(scope,estimate);
              const snapshot = JSON.stringify(projected);
              checks.push(()=>JSON.stringify(visibleWeeklyGroups(scope,estimate)) === snapshot);
              reports.push({window:window.window,usage:window.usage,readAt:window.usageReadAt,resetsAt:window.resetsAt,...projected});
            }
            let watched = usageChecks.get(viewer);
            if (!watched) { watched = new Map(); usageChecks.set(viewer,watched); }
            watched.set(row.id,()=>Boolean(usageScope?.(viewer)) && checks.every(check=>check()));
            return reports;
          });
        },
        };
      });
    },
  } };
  return {
    fields,
    /** Rechecked after public awaits and on socket refresh/delivery. Reject a
     * previously private selection if its CURRENT ownership no longer permits it. */
    valid(viewer: Viewer) { const ids = [...(witnesses.get(viewer) ?? [])]; return allowedModelAccounts(db, viewer, ids).size === ids.length && [...(usageChecks.get(viewer)?.values() ?? [])].every(check=>check()); },
  };
}
