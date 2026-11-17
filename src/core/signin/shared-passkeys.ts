import { activeMemberToken } from './shared-tokens.js';
import { credentialKey } from './credential-key.js';
/** WebAuthn ceremonies at the shared identity door. Challenges are short-lived,
 * bounded, and single use; registration is bound to a freshly proved browser.
 *
 * Challenges are kept in memory, in two sets. Anyone may ask for a sign-in challenge, so that set never
 * refuses: when it is full the oldest one is dropped. Somebody flooding it can no longer shut everyone out
 * for five minutes; they would have to push a thousand requests into the seconds one person's sign-in
 * takes. Challenges for adding a passkey come only from a freshly proved browser and have their own set,
 * which a stranger cannot touch. What is left is in docs/accepted-tradeoffs.md. */
import { randomBytes } from 'node:crypto';
import { credentialFingerprint as hash, currentSession, freshProof } from '../data/authentication.js';
import { startBrowser } from './shared-browser.js';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import type { Clock } from '../clock.js';
import { tokens, passkeys } from '../data/schema.js';
import { verifyRegistration, verifyAssertion, ALGS } from './webauthn.js';
export function sharedPasskeys(db:DataDatabase,clock:Clock,rp:{origin:string;rpId:string}) {
  type Issued={expires:number;session?:string;token?:string};
  const CAP=1024,signIns=new Map<string,Issued>(),additions=new Map<string,Issued>();
  const currentToken=(id:string)=>activeMemberToken(db,clock,id);
  const fresh=(cookie:string)=>{
    const found=currentSession(db,hash(cookie),clock.now());
    if(!found||found.viewer.kind!=='member'||!freshProof(found.session,clock.now()))throw Error('Sign in again before adding a passkey');
    return {session:found.session,token:found.token};
  };
  const challenge=(binding:{session?:string;token?:string}={})=>{
    const set=binding.session?additions:signIns;
    for(const [key,value]of set)if(value.expires<=clock.now())set.delete(key);
    // A Map keeps the order things were added in, so its first key is the oldest challenge.
    while(set.size>=CAP)set.delete(set.keys().next().value!);
    const value=randomBytes(32).toString('base64url');set.set(value,{expires:clock.now()+300000,...binding});return value;
  };
  const spend=(value:string)=>{const found=signIns.get(value)??additions.get(value);signIns.delete(value);additions.delete(value);if(!found||found.expires<=clock.now())throw Error('Challenge expired');return found;};
  return {
    loginOptions(){return {challenge:challenge(),rpId:rp.rpId,timeout:300000,userVerification:'required'};},
    registrationOptions(cookie:string){
      const {session,token}=fresh(cookie);
      return {challenge:challenge({session:session.id,token:token.fingerprint}),rp:{id:rp.rpId,name:'Loom'},user:{id:Buffer.from(token.member!).toString('base64url'),name:token.member!,displayName:token.member!},pubKeyCredParams:ALGS.map(alg=>({type:'public-key',alg})),timeout:300000,authenticatorSelection:{residentKey:'required',userVerification:'required'},attestation:'none',excludeCredentials:db.select().from(passkeys).all().filter(k=>{const t=db.select().from(tokens).where(eq(tokens.fingerprint,k.token)).get();return t?.member===token.member;}).map(k=>({type:'public-key',id:k.id}))};
    },
    register(cookie:string,body:Record<string,unknown>){
      const {session,token}=fresh(cookie), verified=verifyRegistration(body,rp), issued=spend(verified.challenge);
      if(issued.session!==session.id||issued.token!==token.fingerprint)throw Error('Challenge belongs to another browser');
      if(credentialKey(Buffer.from(String(body.authenticatorData),'base64url'),verified.publicKey)!==verified.alg)throw Error('Credential algorithm mismatch');
      const label=typeof body.label==='string'?body.label.trim():'';
      if(!label||label.length>60||/[\p{Cc}\p{Cf}]/u.test(label))throw Error('Name the passkey');
      db.insert(passkeys).values({id:verified.id,token:token.fingerprint,label,publicKey:JSON.stringify({publicKey:verified.publicKey,alg:verified.alg}),counter:verified.counter,createdAt:new Date(clock.now()).toISOString()}).run();
      return {ok:true};
    },
    login(body:Record<string,unknown>,userAgent:string){
      if(typeof body.id!=='string')throw Error('Passkey required');
      const key=db.select().from(passkeys).where(eq(passkeys.id,body.id)).get();if(!key)throw Error('Passkey unknown');
      const token=currentToken(key.token), verified=verifyAssertion(body,JSON.parse(key.publicKey),rp), issued=spend(verified.challenge);
      if(issued.session||issued.token||verified.id!==key.id)throw Error('Passkey sign-in refused');
      // A counter that went back or stood still means a copied authenticator. One that is always 0 is an
      // authenticator that keeps none, which is what a synced passkey reports: there is nothing to compare.
      if((verified.counter!==0||key.counter!==0)&&verified.counter<=key.counter)throw Error('Passkey sign-in refused');
      db.update(passkeys).set({counter:verified.counter,lastUsedAt:new Date(clock.now()).toISOString()}).where(eq(passkeys.id,key.id)).run();
      return startBrowser(db,clock.now(),{token,userAgent,via:'passkey',passkey:key.id});
    },
    close(){signIns.clear();additions.clear();},
  };
}
