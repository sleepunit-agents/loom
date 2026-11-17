/** The Discord resume cursor for one authenticated connection lifetime, kept in
 * the database so a restart resumes the session and Discord replays what was
 * posted while this program was down. The raw frame and the cursor commit in
 * one transaction before the cursor is exposed. The cursor row names only its
 * connection, not the credential it was made under: composition forgets it
 * when the connection's own secrets change (see SharedBridges.retire). */
import type { BridgeReceiver } from './receiver.js';
import type { DiscordCheckpoint } from './discord-gateway.js';
export function liveDiscordReceipts(receiver:Pick<BridgeReceiver,'discord'|'checkpoint'|'reset'>,connection:string,current:()=>boolean){
 const ended=()=>Error('Discord receipt lifetime ended');
 const stored=():DiscordCheckpoint|undefined=>{
  const row=receiver.checkpoint(connection);
  return row&&{session:row.session,url:row.resumeUrl,seq:row.sequence};
 };
 return {
  checkpoint(){if(!current())throw ended();return stored();},
  retain(raw:Buffer,next:DiscordCheckpoint){
   if(!current()||!next.session||!Number.isSafeInteger(next.seq)||next.seq<0||!next.url)throw ended();
   const saved=stored();
   // A new session, a new resume address or a rewind needs the gateway's reset first.
   if(saved&&(saved.session!==next.session||saved.url!==next.url||saved.seq>next.seq))throw ended();
   receiver.discord(connection,raw,{session:next.session,sequence:next.seq,resumeUrl:next.url});
   if(!current())throw ended();
  },
  /** Discord refused the session: forget the cursor so the next connect identifies afresh. */
  reset(){if(!current())throw ended();receiver.reset(connection);},
 };
}
