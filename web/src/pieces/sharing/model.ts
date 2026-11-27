/** What the Sharing app reads, with no component: its selection and the shape loom answers. The desktop's app
 * (./index.tsx) and the boards page's `sharing` brick share them. */
export interface SharedProject{id:string;name:string;goal?:string|null;members:string[];agents:string[];repositories:string[]}
export interface HouseholdSharing{members:string[];agents:string[];projects:SharedProject[]}
export const householdSharingQuery=`{ householdSharing { members agents projects { id name goal members agents repositories } } }`;
export const sharingCount=(project:SharedProject)=>`${project.members.length} members · ${project.agents.length} agents`;
