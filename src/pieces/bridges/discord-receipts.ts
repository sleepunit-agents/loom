/** Resume only inside one authenticated connection lifetime. A process restart
 * starts a fresh Identify; no cursor can silently acquire another credential's
 * authority. Raw frames commit before the in-memory cursor advances. */
import type { BridgeReceiver } from './receiver.js';
import type { DiscordCheckpoint } from './discord-gateway.js';
export function liveDiscordReceipts(receiver:Pick<BridgeReceiver,'discord'>,connection:string,current:()=>boolean){
 let saved:DiscordCheckpoint|undefined;
 return {
  checkpoint(){if(!current())throw Error('Discord receipt lifetime ended');return saved&&{...saved};},
  retain(raw:Buffer,next:DiscordCheckpoint){
   if(!current()||!next.session||!Number.isSafeInteger(next.seq)||next.seq<0||!next.url
    ||saved&&(saved.session!==next.session||saved.url!==next.url||saved.seq>next.seq))throw Error('Discord receipt lifetime ended');
   receiver.discord(connection,raw,{session:next.session,sequence:next.seq,resumeUrl:next.url},false);
   if(!current())throw Error('Discord receipt lifetime ended');
   saved={...next};
  },
  reset(){saved=undefined;},
 };
}
