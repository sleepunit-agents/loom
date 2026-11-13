/** Portable read model, shared by the record reader and screen. */
export type CardValue=string|number|boolean|string[];
export interface PersonCard {slug:string;name:string;summary?:string;where:Record<string,{value:CardValue;label?:string;source?:string;verified_at?:string;stale_after_days?:number}>;how:Record<string,CardValue>;may:Array<{text:string;source:string}>}
export interface PersonEvidence {created:string;category:string;title:string;content:string}
export interface PersonRecord {
  [key:string]: unknown;
  id: string; slug: string; agent?: string; name: string; card: PersonCard; updated: string; synthesizedAt: string | null;
  kind: 'person' | 'agent'; evidence: PersonEvidence[]; newer: number;
  fields: Array<{ key: string; value: string; source?: string; verifiedAt?: string; state: 'fresh' | 'stale' | 'unverified' }>;
  ownership?: {owner:boolean;agents:string[]};
  projects:Array<{agent:string;slug:string;name:string;status:string}>;
  mergedFrom?: string;
}
