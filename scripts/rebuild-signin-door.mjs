/** Owned Signing in API producer. Every credential is for this new memory DB.
 * No browser, child, network, persistent home or shared walkthrough fixture. */
import Database from 'better-sqlite3';
import {FakeClock} from '../dist/core/clock.js';
import {createDataSchema} from '../dist/core/data/database.js';
import {members,agents,boxes,tokens,sessions,signinLinks,passkeys,notificationDevices} from '../dist/core/data/schema.js';
import {sharedRoot} from '../dist/shared-root.js';
const origin='https://signin-proof.invalid';
const hash=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',Buffer.from(value))).toString('hex');
export async function signinDoorEvidence(){
 const client=new Database(':memory:');let root,result,phase='fresh schema';
 const secrets=[],check=(value,label)=>{phase=label;if(!value)throw Error(label);};
 try{
  const clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
  db.insert(members).values([{id:'owner',role:'owner',fullOwner:true,joinedAt:now()},{id:'sam',role:'member',joinedAt:now()}]).run();
  db.insert(agents).values({id:'art',about:'Fictional agent',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(boxes).values({id:'worker',name:'Fictional worker',owner:'owner',sameMachineAsLoom:false,hostsAny:true,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
  const errors=[];let unexpectedPushes=0;root=sharedRoot({db,clock,publicOrigin:origin,originAllowed:()=>true,notifications:{vapid:{publicKey:'metadata-public-key-not-used-for-sending',privateKey:'metadata-private-key-not-used-for-sending'},send:async()=>{unexpectedPushes++;}},reportError:()=>errors.push(true)});await root.ready;
  const request=(path,input,headers={})=>{phase='outside request';return root.http.request(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(input)});};
  const query=(source,headers={})=>request('/graphql',{query:source},headers);
  const bearer=value=>({authorization:'Bearer '+value});
  const bootstrap=root.writes.run(()=>root.services.signin.issue({kind:'owner',member:'owner',label:'Bootstrap owner'})).value;secrets.push(bootstrap.token);
  check(bootstrap.fingerprint===await hash(bootstrap.token)&&db.select().from(tokens).all().some(row=>row.fingerprint===bootstrap.fingerprint),'bootstrap token fingerprint row');
  check((await query('{ tasks { id } }')).status===401,'unauthenticated request refused');
  const link=async token=>{
   const response=await request('/api/signin/link',{},bearer(token));check(response.status===200,'member link issued at HTTP door');
   const value=await response.json(),path=value.value?.path;check(typeof path==='string'&&path.startsWith('/login/'),'link response shape');
   const code=path.split('/').at(-1);secrets.push(code);
   const fingerprint=await hash(code);check(db.select().from(signinLinks).all().some(row=>row.id===fingerprint),'link code fingerprint only');return path;
  };
  const redeem=async(path,userAgent)=>{
   const response=await root.http.request(origin+path,{method:'POST',headers:{origin,'user-agent':userAgent}});
   check(response.status===303,'one-time link redeemed');
   const cookie=response.headers.get('set-cookie')?.split(';')[0];check(cookie?.startsWith('loom_ui='),'browser cookie delivered');
   const raw=cookie.slice('loom_ui='.length);secrets.push(raw);const fingerprint=await hash(raw);check(db.select().from(sessions).all().some(row=>row.id===fingerprint),'browser cookie fingerprint only');
   return cookie;
  };
  const ownerLink=await link(bootstrap.token),ownerCookie=await redeem(ownerLink,'Mozilla/5.0 Safari/537.36'),ownerHeaders={cookie:ownerCookie};
  check((await root.http.request(origin+ownerLink,{method:'POST',headers:{origin}})).status===401,'used link refused');
  const issue=async input=>{
   const response=await request('/api/signin/token',input,ownerHeaders);check(response.status===200,'owner creates caller at HTTP door');
   const value=(await response.json()).value;check(typeof value?.token==='string'&&typeof value?.fingerprint==='string','issued caller shape');
   secrets.push(value.token);check(value.fingerprint===await hash(value.token)&&db.select().from(tokens).all().some(row=>row.fingerprint===value.fingerprint&&row.kind===input.kind),'issued token fingerprint row');return value;
  };
  const sam=await issue({kind:'owner',member:'sam',label:'Sam credential'}),agent=await issue({kind:'agent',agent:'art',label:'Agent credential'}),runner=await issue({kind:'runner',box:'worker',label:'Machine credential'});
  for(const [issued,kind,id,selection] of [[sam,'member','sam','{ tasks { id } }'],[agent,'agent','art','{ tasks { id } }'],[runner,'runner','worker',undefined]]){
   const auth=root.credentials.authenticate(new Request(origin+'/graphql',{headers:bearer(issued.token)}));
   check(auth?.valid()&&auth.viewer.kind===kind&&auth.viewer.id===id,'actual caller identity resolved');
   const response=kind==='runner'?await request('/api/runtime/health',{id:crypto.randomUUID(),input:{}},bearer(issued.token)):await query(selection,bearer(issued.token)),data=await response.json();check(response.status===200&&(kind==='runner'?data.ok===true:!data.errors&&!!data.data),kind+' caller reaches authenticated API');
  }
  for(const issued of [sam,agent,runner])check((await request('/api/signin/token',{kind:'owner',member:'owner',label:'Forbidden'},bearer(issued.token))).status===403,'nonowner cannot issue credentials');
  const person=await redeem(await link(sam.token),'Mozilla/5.0 Safari/537.36'),automated=await redeem(await link(sam.token),'HeadlessChrome/140.0'),personHeaders={cookie:person},automatedHeaders={cookie:automated};
  // Nonempty data for both members makes an overbroad personal projection fail.
  // These public halves/subscription keys are metadata fixtures, never used to sign or send.
  db.insert(passkeys).values([{id:'owner-metadata-key',token:bootstrap.fingerprint,label:'Owner private passkey',publicKey:'fixture-public-half',counter:0,createdAt:now()},{id:'sam-metadata-key',token:sam.fingerprint,label:'Sam private passkey',publicKey:'fixture-public-half',counter:0,createdAt:now()}]).run();
  const ownerSession=await hash(ownerCookie.slice('loom_ui='.length)),samSession=await hash(person.slice('loom_ui='.length));
  db.insert(notificationDevices).values([{endpoint:'https://fcm.googleapis.com/owner-metadata-only',member:'owner',session:ownerSession,keys:JSON.stringify({p256dh:'p'.repeat(87),auth:'a'.repeat(22)}),device:'Owner private phone',createdAt:now(),seenAt:now()},{endpoint:'https://fcm.googleapis.com/sam-metadata-only',member:'sam',session:samSession,keys:JSON.stringify({p256dh:'s'.repeat(87),auth:'b'.repeat(22)}),device:'Sam private phone',createdAt:now(),seenAt:now()}]).run();
  const accountQuery='{ account { member sessions { ref device } passkeys { ref label } notifications { devices { ref device } } } householdSetup { tokens { fingerprint label } sessions { ref tokenLabel isAgent } } }';
  const ownerData=await(await query(accountQuery,ownerHeaders)).json(),samData=await(await query(accountQuery,personHeaders)).json();
  check(!ownerData.errors&&!samData.errors,'account projection available');
  check(ownerData.data.account.member==='owner'&&samData.data.account.member==='sam','person token names member');
  check(samData.data.householdSetup===null&&samData.data.account.sessions.length===2,'member sees personal account only');
  check(ownerData.data.account.sessions.length===1,'owner personal browser present');
  const trusted=root.services.account.read('owner');check(trusted.sessions.length===1&&trusted.sessions[0].ref===ownerData.data.account.sessions[0].ref,'trusted credential service reads browser metadata without caller token');
  const ownerRefs=new Set(ownerData.data.account.sessions.map(row=>row.ref));
  check(samData.data.account.sessions.every(row=>!ownerRefs.has(row.ref)),'other member browsers withheld');
  check(ownerData.data.account.passkeys.length===1&&ownerData.data.account.passkeys[0].label==='Owner private passkey'&&samData.data.account.passkeys.length===1&&samData.data.account.passkeys[0].label==='Sam private passkey','nonempty passkeys are personal');
  check(ownerData.data.account.notifications.devices.length===1&&ownerData.data.account.notifications.devices[0].device==='Owner private phone'&&samData.data.account.notifications.devices.length===1&&samData.data.account.notifications.devices[0].device==='Sam private phone','nonempty notification devices are personal');
  const privateRefs=new Set([ownerData.data.account.passkeys[0].ref,ownerData.data.account.notifications.devices[0].ref]);check(!privateRefs.has(samData.data.account.passkeys[0].ref)&&!privateRefs.has(samData.data.account.notifications.devices[0].ref),'other member credential references withheld');
  check((await request('/api/account/removePasskey',{id:crypto.randomUUID(),input:{ref:ownerData.data.account.passkeys[0].ref}},personHeaders)).status===404,'other member passkey removal refused');
  check((await request('/api/notifications/removeDevice',{id:crypto.randomUUID(),input:{ref:ownerData.data.account.notifications.devices[0].ref}},personHeaders)).status===404,'other member device removal refused');
  check((await request('/api/account/removePasskey',{id:crypto.randomUUID(),input:{ref:samData.data.account.passkeys[0].ref}},personHeaders)).status===200,'own passkey removed through door');
  check(root.services.account.read('sam').passkeys.length===0&&root.services.account.read('owner').passkeys.length===1,'passkey removal remains personal');
  check(ownerData.data.householdSetup.tokens.length===4&&ownerData.data.householdSetup.sessions.length===3,'owner sees household credentials');
  const listed=ownerData.data.householdSetup.tokens;
  for(const [issued,label] of [[bootstrap,'Bootstrap owner'],[sam,'Sam credential'],[agent,'Agent credential'],[runner,'Machine credential']])check(listed.some(row=>row.fingerprint===issued.fingerprint&&row.label===label),'owner list exposes the exact safe credential references');
  const listedMachine=listed.find(row=>row.label==='Machine credential');check(listedMachine?.fingerprint===runner.fingerprint,'machine chosen from owner list');
  const agentSetup=await(await query('{ householdSetup { tokens { fingerprint } } }',bearer(agent.token))).json();
  check(!agentSetup.errors&&agentSetup.data.householdSetup===null,'agent cannot read household credentials');
  check((await query('{ householdSetup { tokens { fingerprint } } }',bearer(runner.token))).status===403,'machine cannot read household credentials');
  const staleLink=await link(sam.token);
  clock.advance(6*3600_000-1);
  check((await query('{ tasks { id } }',automatedHeaders)).status===200,'automated session valid before six hours');
  check((await root.http.request(origin+staleLink,{method:'POST',headers:{origin}})).status===401,'expired link refused');
  clock.advance(1);
  check((await query('{ tasks { id } }',automatedHeaders)).status===401,'automated session ends at six hours');
  const stillPerson=await(await root.http.request(origin+'/auth/session',{headers:personHeaders})).json();
  check(stillPerson.viewer?.id==='sam','person session outlasts automated one');
  const survivor=await redeem(await link(sam.token),'Mozilla/5.0 Safari/537.36');
  check((await query('{ tasks { id } }',personHeaders)).status===200,'selected person browser valid before revocation');
  const target=ownerData.data.householdSetup.sessions.find(row=>row.tokenLabel==='Sam credential'&&!row.isAgent);
  check(!!target,'selected other browser found');
  check((await request('/api/sessions/revoke',{id:crypto.randomUUID(),input:{ref:target.ref}},ownerHeaders)).status===200,'owner ends selected household browser');
  check((await query('{ tasks { id } }',personHeaders)).status===401,'ended browser denied immediately');
  check(root.services.notifications.read('sam').devices.length===0&&root.services.notifications.read('owner').devices.length===1,'browser revocation ends its devices only');
  check((await query('{ tasks { id } }',{cookie:survivor})).status===200,'other person browser retained');
  check((await request('/api/runtime/health',{id:crypto.randomUUID(),input:{}},bearer(runner.token))).status===200,'machine valid before revocation');
  check((await request('/api/token/revoke',{id:crypto.randomUUID(),input:{fingerprint:listedMachine.fingerprint}},ownerHeaders)).status===200,'owner revokes machine credential');
  check((await request('/api/runtime/health',{id:crypto.randomUUID(),input:{}},bearer(runner.token))).status===401,'revoked token denied immediately');
  check((await query('{ tasks { id } }',bearer(sam.token))).status===200&&(await query('{ tasks { id } }',bearer(agent.token))).status===200,'other member and agent tokens retained');
  const image=client.serialize();check(secrets.every(secret=>!image.includes(Buffer.from(secret))),'raw credentials absent from SQLite image');
  check(errors.length===0,'no internal errors');check(unexpectedPushes===0,'metadata fixture sends no pushes');
  result={ok:true,checks:{trustedServiceWithoutToken:true,unauthenticatedDenied:true,memberAgentMachineAuthenticated:true,memberIdentityBound:true,nonownerIssuanceDenied:true,oneUseLink:true,expiredLinkDenied:true,sixHourAutomatedSession:true,personSessionRetained:true,personalMetadataOnly:true,ownerHouseholdList:true,ownerSessionRevocation:true,ownerTokenRevocation:true,tokenCookieLinkFingerprints:true,rawSecretsNeverPersisted:true}};
 }catch{result={ok:false,error:'Sign-in door evidence failed: '+phase};}
 finally{
  let closed=true;try{await root?.close();}catch{closed=false;}try{client.close();}catch{closed=false;}
  if(!closed)result={ok:false,error:'Sign-in door evidence cleanup failed'};
 }
 if(result.ok)result.checks.closed=true;
 return result;
}
