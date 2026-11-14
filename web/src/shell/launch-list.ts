import type { RegisteredApp } from './index';
const sections = ['Work','People & agents','Library','System','Look & feel','Pieces'] as const;
type Section = typeof sections[number];
const group:Readonly<Record<string,Section>> = {comms:'People & agents',people:'People & agents',knowledge:'Library',bridges:'System',clock:'System',setup:'System',settings:'System',account:'System',staging:'System'};
const keywords:Readonly<Record<string,readonly string[]>> = {account:['profile','account','passkey','passkeys','sign out','log out'],setup:['household','members','agents']};
/** The registrations remain the only app inventory; unknown apps keep a place in Work. */
export function launcherSections(apps:readonly RegisteredApp[],query:string) {
 const q=query.trim().toLowerCase();
 return sections.map(name=>({name,apps:apps.filter(app=>(group[app.id]??'Work')===name&&(!q||app.title.toLowerCase().includes(q)||name.toLowerCase().includes(q)||(keywords[app.id]??[]).some(k=>k.includes(q))))})).filter(section=>section.apps.length);
}
export function launcherFirst(apps:readonly RegisteredApp[],query:string) {
 const q=query.trim().toLowerCase();
 return apps.find(app=>app.title.toLowerCase().startsWith(q))??apps.find(app=>(keywords[app.id]??[]).some(k=>k.startsWith(q)))??apps[0];
}
