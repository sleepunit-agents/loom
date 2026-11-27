/** Adding a passkey to the signed-in member's account: the part of Account that is not drawn. The desktop's Account
 * piece and the boards page's `account` brick both run this one ceremony against the sign-in door (`/passkeys/options`,
 * then `/passkeys`). No component and no stylesheet. Called from a person's submit and nowhere else: the device asks
 * for its lock. */
import { decode as dec } from './encoding';

const enc=(buf:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
/** One request to the sign-in door. Throws with the door's own short refusal. */
export async function post(path:string,input:unknown){const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(input),redirect:'error'});const value=await r.json();if(!r.ok)throw Error(value.error??'Sign-in request refused');return value;}
/** Asks the device for a new passkey and registers it under the name given. Throws with words a person can read. */
export async function addPasskey(label:string):Promise<void>{
  const o=await post('/passkeys/options',{});
  const c=await navigator.credentials.create({publicKey:{...o,user:{...o.user,id:dec(o.user.id)},challenge:dec(o.challenge),excludeCredentials:o.excludeCredentials.map((x:{id:string})=>({type:'public-key',id:dec(x.id)})),attestation:'none'}}) as PublicKeyCredential|null;
  if(!c)throw Error('Passkey creation cancelled');const r=c.response as AuthenticatorAttestationResponse;
  if(!r.getPublicKey||!r.getAuthenticatorData||!r.getPublicKey())throw Error('This browser cannot register a passkey here');
  await post('/passkeys',{label,id:enc(c.rawId),clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.getAuthenticatorData()),publicKey:enc(r.getPublicKey()!),publicKeyAlgorithm:r.getPublicKeyAlgorithm()});
}
/** What Account says above the form. */
export const PASSKEY_WORDS='Add a passkey within ten minutes of signing in. Your device asks for its lock.';
