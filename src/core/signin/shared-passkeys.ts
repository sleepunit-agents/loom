import { activeMemberToken } from './shared-tokens.js';
import { credentialKey } from './credential-key.js';
/** WebAuthn ceremonies at the shared identity door. Challenges are short-lived,
 * bounded, and single use; registration is bound to a freshly proved browser. */
import { randomBytes } from 'node:crypto';
import { AGENT_SESSION_MS, PERSON_SESSION_MS, credentialFingerprint as hash, currentSession, freshProof, isAgentBrowser } from '../data/authentication.js';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import type { Clock } from '../clock.js';
import { tokens, sessions, passkeys } from '../data/schema.js';
import { verifyRegistration, verifyAssertion, ALGS } from './webauthn.js';
export function sharedPasskeys(db:DataDatabase,clock:Clock,rp:{origin:string;rpId:string}) {
  const challenges=new Map<string,{expires:number;session?:string;token?:string}>();
  const currentToken=(id:string)=>activeMemberToken(db,clock,id);
  const fresh=(cookie:string)=>{
    const found=currentSession(db,hash(cookie),clock.now());
    if(!found||found.viewer.kind!=='member'||!freshProof(found.session,clock.now()))throw Error('Sign in again before adding a passkey');
    return {session:found.session,token:found.token};
  };
  const challenge=(binding:{session?:string;token?:string}={})=>{
    for(const [key,value]of challenges)if(value.expires<=clock.now())challenges.delete(key);
    if(challenges.size>=1024)throw Error('Try again shortly');
    const value=randomBytes(32).toString('base64url');challenges.set(value,{expires:clock.now()+300000,...binding});return value;
  };
  const spend=(value:string)=>{const found=challenges.get(value);challenges.delete(value);if(!found||found.expires<=clock.now())throw Error('Challenge expired');return found;};
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
      if(issued.session||issued.token||verified.id!==key.id||verified.counter<=key.counter)throw Error('Passkey sign-in refused');
      const cookie=randomBytes(32).toString('hex'),at=new Date(clock.now()).toISOString(),isAgent=isAgentBrowser(userAgent);
      db.update(passkeys).set({counter:verified.counter,lastUsedAt:at}).where(eq(passkeys.id,key.id)).run();
      db.insert(sessions).values({id:hash(cookie),token:token.fingerprint,device:isAgent?'HeadlessChrome':'Browser',via:'passkey',isAgent,issuedAt:at,seenAt:at,provedAt:at}).run();
      const maxAge=Math.floor((Math.min(clock.now()+(isAgent?AGENT_SESSION_MS:PERSON_SESSION_MS),token.expiresAt?Date.parse(token.expiresAt):Infinity)-clock.now())/1000);
      return {cookie,maxAge};
    },
    close(){challenges.clear();},
  };
}
