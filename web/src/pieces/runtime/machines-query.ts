/** The reads of the desktop's "Machines and jobs" app, as strings and types with no component: its inventory
 * (../machines/index.tsx), "Your machines" (./machines.tsx), and what `machine.history` and `machine.readerCards`
 * answer. The boards page's `machines` brick reads the same. */
import {machineHostingFields, type MachineHosting} from './machine-hosting-model';
import type {Reading} from './machine-readings';

export const machinesInventoryQuery=`{ account { member } agents { id removedAt } boxes { id name ${machineHostingFields} } modelAccounts { ... on RuntimeAccountDetail { logins { box { id } needsSignIn } } } }`;
export type MachinesInventory={
 modelAccounts?:{logins?:{box:{id:string};needsSignIn:boolean}[]}[];
 account:{member:string}|null;
 agents:{id:string;removedAt:string|null}[];
 boxes:(MachineHosting & {id:string;name:string})[];
};
/** The machines on which some model account's sign-in needs attention. */
export const signInWarnings=(inventory:MachinesInventory|undefined)=>new Set(inventory?.modelAccounts?.flatMap(account=>
 account.logins?.filter(login=>login.needsSignIn).map(login=>login.box.id)??[]));

export type Machine = MachineHosting & {id:string; name:string; readers:string[]|null; readingsLeftOut:number};
export type MachineReadEntry = {id:string; agent:string; job:string; conversation:string|null; word:string; person:string|null; read:string; args:string; askedAt:string; bytes:number; outcome:string};
export type ReaderCard = {id:string; ask:string;review?:string};
export type OwnerMachinesData = {boxes:Machine[]; boxReadings?:Reading[]; agents:{id:string}[]};
export const ownerMachinesQuery = `query OwnerMachines { boxes { id name ${machineHostingFields} readers readingsLeftOut } boxReadings { box kind thing usedPercent sizeMib freeMib engineStatus level readAt unknownSince stale } agents { id } }`;
