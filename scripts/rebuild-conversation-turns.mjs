import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {messages, turns} from '../dist/core/data/schema.js';
import {bodyProgram} from '../dist/runtime/body-program.js';
import {BODY_EXIT} from '../dist/runtime/job-exit.js';

/** In the fictional walkthrough home only, give the native runtime a synthetic
 * protected input, then have its model return that input as the proposed answer.
 * All Comms delivery, history, runtime reporting and refusal checks are real. */
async function withholdReply({app,clock,parent,cv,thread,box,question}) {
 const marker='private-fixture-'+randomUUID(),env={};
 const job={id:parent.id,box,agent:cv.agent,member:cv.member,venue:'loom',conversation:cv.id,thread,model:'fixture',
  account:'fixture',harness:'claude',brief:'',house:{repository:'fictional',file:'Housefile',branch:'next'},
  run:{nestedContainers:false,gpu:false,ports:[],policy:{people:[{kind:'person',person:cv.member,tier:null}],deniedTools:[],word:'owners'}}};
 const input=Buffer.from(JSON.stringify({job,build:'fixture',bootstrap:{origin:app.url,job:job.id,token:parent.token}}));
 let evaluated=false;
 const code=await bodyProgram({args:['fixture'],read:async()=>JSON.stringify({command:'/fictional/model',cwd:'/fictional'}),
  stdin:async()=>input,env,signal:new AbortController().signal,clock,loadMemory:async()=>null,error(){},
  fetch:async(url,init)=>{
   const target=new URL(url);assert.equal(target.origin,app.url);
   switch(target.pathname){
    case '/api/secrets/private/startup':return Response.json({aliases:[{alias:'FIXTURE_INPUT'}]});
    case '/api/secrets/private/read':return new Response(marker,{headers:{'content-type':'application/octet-stream','x-loom-secret-use':'use-input-'+'a'.repeat(64)}});
    case '/api/secrets/private/confirm':return Response.json({confirmed:true});
    default:return fetch(url,init);
   }
  },
  native:async(_job,context)=>{
   assert.ok(context.includes(question));assert.equal(env.FIXTURE_INPUT,marker);
   evaluated=true;return {text:marker,model:'fixture',actions:[]};
  },
 });
 assert.equal(evaluated,true,'The fixture body exited before producing its proposed reply (stage '+code+').');
 assert.equal(code,BODY_EXIT.harness);
 assert.equal(env.FIXTURE_INPUT,undefined);
 assert.ok(input.every(byte=>byte===0));
}

export async function conversationTurns({app,clock,parent,cv,thread,box,owner,wake}) {
 const db=app.services.comms.db;
 const now=()=>new Date(clock.now()).toISOString();
 const read=id=>db.select().from(turns).where(eq(turns.conversation,id)).orderBy(turns.seq).all();
 const original=read(cv.id).length,expected=[];
 async function act(kind,fromKind,fromId,run,model,outcome,write) {
  clock.advance(1);
  expected.push({conversation:cv.id,seq:original+expected.length+1,at:now(),kind,fromKind,fromId,run,model,outcome,latencyMs:null});
  await write();
 }
 const report=(kind,words,more={})=>parent.call('conversation.message',{kind,clientId:randomUUID(),words,model:'fixture',...more});
 const send=(words)=>owner('comms.send',{thread,clientId:randomUUID(),words});
 await act('message','person',cv.member,null,null,null,()=>send('Describe the garden check.'));
 const mail=await parent.client.takeAndAccept(async item=>assert.equal(item.words,'Describe the garden check.'));
 assert.equal(mail.accepted,1);
 await act('note','agent',cv.agent,parent.id,'fixture','progressed',()=>report('progress','Checking the garden.',{outcome:'progressed'}));
 await act('action','agent',cv.agent,parent.id,'fixture','progressed',()=>report('card','Inspected the garden.',{cardState:'done',tool:'garden-check',outcome:'progressed'}));
 await act('reply','agent',cv.agent,parent.id,'fixture','answered',()=>report('reply','The garden check is complete.',{outcome:'answered'}));
 await parent.client.settle();
 const question='Verify the protected fixture input.';
 await act('message','person',cv.member,null,null,null,()=>send(question));
 const messageRows=()=>db.select({seq:messages.seq}).from(messages).where(eq(messages.thread,thread)).all();
 const before=messageRows();
 await act('refused','agent',cv.agent,parent.id,null,'failed',()=>withholdReply({app,clock,parent,cv,thread,box,question}));
 assert.deepEqual(messageRows(),before);
 // Check the entire stored row, including its shape: text is never part of a turn.
 assert.deepEqual(read(cv.id).slice(original),expected);
 assert.deepEqual(read(wake.conversation),[{conversation:wake.conversation,seq:1,at:wake.at,kind:'wake',fromKind:'schedule',
  fromId:null,run:null,model:null,outcome:null,latencyMs:null}]);
 return {ok:true,reason:'Comms recorded the member message, a progress note, a tool card and the final reply. A timed household trigger recorded a wake. When a fixture model repeated a protected input, the body recorded a refusal and delivered no message. Every turn had the expected author, time, sequence and outcome, with no content fields.'};
}
