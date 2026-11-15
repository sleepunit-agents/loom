/** Actual TCP + real enrolled child acceptance, using fictitious data only.
 * This proves the receiving Comms pipeline; production worker bootstrap is
 * independently owned by t-2241 and is not substituted by this test launcher. */
import {afterEach,expect,it} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {getRequestListener} from '@hono/node-server';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
it('delivers private Comms mail to an enrolled native child, accepts its reply/digest and returns the person answer through one Inbox',async()=>{
 const f=await bodyFixture(clean,{initialTime:Date.now(),modelRoles:()=>[{model:'requested-model',provider:'provider',harness:'fixture',series:'series'}]});
 f.root.writes.run(()=>{
  f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.update(s.conversations).set({job:null}).run();f.db.delete(s.jobs).run();
  f.db.insert(s.boxAgents).values({box:'box',agent:'art',lent:false}).run();f.db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();f.db.insert(s.agentModels).values({agent:'art',model:'requested-model',position:0}).run();
  f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
  f.db.insert(s.modelAccounts).values({id:'account',owner:'alice',provider:'provider',label:'Fixture account',hasRoom:true}).run();
  f.db.insert(s.modelAccountBoxes).values({account:'account',box:'box'}).run();f.db.insert(s.modelAccountWindows).values({account:'account',window:'week',usage:0.1,usageReadAt:new Date(f.clock.now()).toISOString(),resetsAt:new Date(f.clock.now()+7*86400000).toISOString(),durationMs:7*86400000}).run();
  f.db.insert(s.tempoSettings).values({whoKind:'agent',who:'art',settleSeconds:0}).run();
 });
 expect(f.db.select().from(s.tokens).all().filter(row=>row.job)).toEqual([]);
 const server=createServer(getRequestListener(f.root.http.fetch));await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));clean.push(async()=>{server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));});
 const address=server.address();if(!address||typeof address==='string')throw Error('No fixture listener');const url='http://127.0.0.1:'+address.port;
 const bearer=(name:string,input:unknown,token=raw.runner)=>fetch(url+'/api/'+name.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id:randomUUID()})});
 const member=(name:string,input:unknown)=>fetch(url+'/api/'+name.replace('.','/'),{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input,id:randomUUID()})});
 const input='PRIVATE NATIVE INPUT',reply='PRIVATE NATIVE REPLY t-4242',card='PRIVATE NATIVE CARD',question='PRIVATE NATIVE QUESTION';
 expect((await member('comms.send',{thread:f.thread.id,words:input,clientId:'native-input'})).status).toBe(200);
 const claim=await bearer('runtime.next',{});expect(claim.status).toBe(200);const job=(await claim.json()).value as {id:string;conversation:string;brief:string;model:string};expect(job).toMatchObject({conversation:f.thread.conversation,brief:'',model:'requested-model'});
 const token='body_'+randomBytes(32).toString('hex');expect((await bearer('conversation.status',{state:'working',work:''},token)).status).toBe(401);
 const enrolled=await bearer('runtime.enrollBody',{job:job.id,fingerprint:hash(token)});expect(await enrolled.json()).toEqual({ok:true,value:{registered:true}});
 expect((await bearer('conversation.status',{state:'working',work:''},token)).status).toBe(403);
 const childArgs=['--import','tsx',join('test','fixtures','conversation-native-child.mjs')];
 const child=spawn(process.execPath,childArgs,{cwd:resolve(import.meta.dirname,'..'),env:{PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe','ipc']});
 const {stdin,stdout,stderr}=child;if(!stdin||!stdout||!stderr){child.kill('SIGKILL');throw Error('No private child pipes');}
 const output:string[]=[],errors:string[]=[];stderr.on('data',chunk=>errors.push(String(chunk)));
 let asking!:(id:string)=>void,rejectAsk!:(error:Error)=>void;const asked=new Promise<string>((yes,no)=>{asking=yes;rejectAsk=no;});stdin.on('error',()=>rejectAsk(Error('Private child input closed')));const lines=createInterface({input:stdout});
 lines.on('line',line=>{output.push(line);try{const value=JSON.parse(line);if(Object.hasOwn(value,'ask')){if(typeof value.ask!=='string')throw Error('Missing ask');asking(value.ask);}}catch{rejectAsk(Error('Bad child metadata'));}});
 const exited=new Promise<number|null>((yes,no)=>{child.once('error',error=>{rejectAsk(error);no(error);});child.once('close',code=>{rejectAsk(Error('Child ended before asking'));yes(code);});});void exited.catch(()=>{});void asked.catch(()=>{});
 clean.push(async()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await exited.catch(()=>{});lines.close();});
 expect((await bearer('runtime.started',{job:job.id,build:'fictitious-image'})).status).toBe(200);
 stdin.end(JSON.stringify({url,token,job:job.id,conversation:job.conversation,inputHash:createHash('sha256').update(input).digest('hex'),reply,card,question}));
 const ask=await asked;
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.source,'thread')).all().some(row=>row.toKind==='agent'&&row.state==='done')).toBe(true);
 expect((await member('inbox.read',{item:ask})).status).toBe(200);expect((await member('comms.change',{thread:f.thread.id,change:'stop'})).status).toBe(200);
 expect((await member('inbox.answer',{item:ask,answer:'yes'})).status).toBe(200);child.send({continue:true});
 expect(await exited,errors.join('')).toBe(0);expect(JSON.parse(output.at(-1)!)).toEqual({accepted:2,reply:3,revision:2});
 expect(f.db.select().from(s.inbox).all().map(row=>[row.toKind,row.source,row.state])).toEqual([['agent','thread','done'],['person','thread','answered'],['agent','answer','done']]);expect(f.db.select().from(s.inboxReads).all()).toHaveLength(1);
 expect(f.db.select().from(s.turns).all()).toHaveLength(6);expect(f.db.select().from(s.turns).all().filter(row=>row.fromKind==='agent').every(row=>row.run===job.id)).toBe(true);expect(f.db.select().from(s.turns).all().some(row=>row.model==='requested-model')).toBe(false);
 expect(f.db.select().from(s.conversationPeople).all().map(row=>row.who).sort()).toEqual(['alice','art']);expect(f.db.select().from(s.digests).get()).toMatchObject({run:job.id,revision:2,summary:'Fictitious work complete',inboxItem:null});
 expect(f.db.select().from(s.threadRefs).get()?.ref).toBe('t-4242');expect(f.db.select().from(s.threads).get()).toMatchObject({working:false,stopRequested:false});
 expect((await bearer('runtime.finish',{job:job.id,exitCode:0,logTail:reply})).status).toBe(200);expect(f.db.select().from(s.jobs).get()).toMatchObject({state:'done',brief:'',logTail:null});expect((await bearer('conversation.status',{state:'working',work:''},token)).status).toBe(401);
 const read=await fetch(url+'/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{recentConversations(agent:"art",limit:1,answeredOnly:true){lastAnswer{words}}}'})});const selected=await read.json();expect(selected.errors).toBeUndefined();expect(selected.data.recentConversations[0].lastAnswer.words).toBe(reply);
 const durable=f.db.$client.serialize();for(const words of [input,reply,card,question,token]){expect(durable.includes(Buffer.from(words))).toBe(false);expect(output.join('')+errors.join('')).not.toContain(words);expect(childArgs.join(' ')).not.toContain(words);}
 expect(f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,hash(token))).get()).toMatchObject({job:job.id,madeFrom:hash(raw.runner)});
},20000);
