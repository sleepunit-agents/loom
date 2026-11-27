import { newId } from '../../data/id';
/** One Bridges command through loom's door: true only when loom says it saved. No component; the desktop's
 * controls (./controls.tsx) and the boards page's `bridges` brick both send it. */
export async function bridgeCommand(input:object,request:typeof fetch=fetch){
 try{
  const response=await request('/api/bridges/command',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id:newId(),input})});
  if(!response.ok)return false;
  const result:unknown=await response.json();return !!result&&typeof result==='object'&&'ok' in result&&result.ok===true&&'value' in result&&!!result.value&&typeof result.value==='object'&&'saved' in result.value&&result.value.saved===true;
 }catch{return false;}
}
/** What a command says when it ends. */
export const commandWords={saved:'Saved.',notConfirmed:'Change not confirmed. Check the current item before starting a new change.'};
