/** History is a nonpersistent read; Runtime alone issues caller authority. */
import { z } from 'zod';
import type { Foundation } from '../../core/app.js';
import { OperationError, type Viewer } from '../../core/index.js';
import { operation } from './commands.js';
import { discordHistoryQuery, discordHistoryResult, type DiscordHistoryPermit } from './discord-history.js';
import { all, setupRevision } from './store.js';
import type { Venue } from './model.js';
export const discordHistoryInput = discordHistoryQuery.extend({ venue: z.string().min(1).max(200) }).strict();
export interface HistoryAccess {
  permit(viewer: Viewer, place: {workspace:string;channel:string;kind:'channel'|'thread'}): DiscordHistoryPermit | undefined;
  read(venue: Venue, query: z.infer<typeof discordHistoryQuery>, permit: DiscordHistoryPermit): Promise<{value:unknown;current():boolean}>;
}
export function installDiscordHistory(app: Foundation, access: HistoryAccess) {
  const resolve=(viewer:Viewer,input:z.infer<typeof discordHistoryInput>)=>{
    const venue=all(app.db,'venues').find(v=>v.id===input.venue&&v.enabled&&v.platform==='discord');
    if(!venue)return;
    const permit=access.permit(viewer,{workspace:venue.workspace,channel:input.channel,kind:input.kind});
    if(!permit||permit.agent!==venue.agent||!permit.current())return;
    const revision=setupRevision(app.db);
    return {venue,permit:Object.freeze({...permit,current:()=>setupRevision(app.db)===revision&&permit.current()})};
  };
  app.operations.register(operation({name:'bridges.discordHistory',input:discordHistoryInput,output:discordHistoryResult,
    may:(viewer,input)=>!!resolve(viewer,input),
    async prepare(input,{viewer}) {
      const scope=resolve(viewer,input);if(!scope)throw new OperationError('denied','History unavailable');
      const {venue:_,...query}=input;
      const result=await access.read(scope.venue,query,scope.permit);
      if(!scope.permit.current())throw new OperationError('denied','History unavailable');
      const parsed=discordHistoryResult.safeParse(result.value);
      if(!parsed.success)throw new OperationError('unavailable','History unavailable');
      return {value:parsed.data,current:()=>scope.permit.current()&&result.current()};
    },
    run(_ctx,_input,prepared) {
      const p=prepared as {value:unknown;current():boolean}|undefined;
      if(!p?.current())throw new OperationError('denied','History unavailable');
      return p.value;
    },
  }));
}
