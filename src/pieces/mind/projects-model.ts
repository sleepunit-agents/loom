/** Portable projections; no store paths or legacy IO. */
export interface ProjectCard {slug:string;name:string;status:string;summary?:string;goal?:string;where:Record<string,{value:string;verified_at?:string;stale_after_days?:number;source?:string}>;links:{aliases?:string[];notes?:string[];epic?:string;repos?:string[];venues?:string[]}}
export interface ProjectItem {title:string;ref?:string;when?:string;changed?:string;status?:string;body?:string;href?:string;who?:string[];waiting?:boolean;new?:boolean}
export interface ProjectGroup {title:string;waiting?:boolean;items:ProjectItem[]}
export interface ProjectSection {key:string;label:string;available:boolean;error?:string;items?:ProjectItem[];groups?:ProjectGroup[];total?:number;counts?:Record<string,number>;activity?:string;expires?:number;conversationIds?:string[]}
export interface ProjectRecord {[key:string]:unknown;id:string;agent:string;agents:string[];now:number;slug:string;name:string;card:ProjectCard;updated:string;activity:string;archived:boolean;sections:ProjectSection[];waiting:ProjectItem[];unknown:boolean;lately:ProjectItem[];people:string[];spark:number[];changes?:{open:number;failing:number;running:number};fields:Array<{key:string;value:string;state:string}>}

export interface ProjectMemory {[key:string]:unknown;id:string;agent:string;ref:string;title:string;content:string;category:string;created:string;updated:string;expires?:number}
