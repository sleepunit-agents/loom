import type { LiveRecord } from '../../data';
import type { Change, Rule } from '../../../../src/pieces/changes/model';
export type ChangeRecord = Change & LiveRecord & { group:string; words:string; tasks:{id:string;title:string}[]; conversation?:string; rule?:Rule };
