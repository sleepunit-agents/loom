import {expect,it} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {conversationMail} from './rebuild-conversation-mail.mjs';
it('delivers the actual example producer batch before the browser-only question interaction',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'conversation-mail-')),home=join(parent,'home');let app;
 try{const webRoot=join(parent,'web');mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictional</main>');const example=await exampleHome(home),clock=new FakeClock(Date.parse(example.createdAt));let link;app=await startSharedHome({home,clock,port:0,webRoot,stdout:()=>{}});link=app.signinLink();
 const signin=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});expect(signin.status).toBe(303);const cookie=signin.headers.get('set-cookie').split(';',1)[0];
 app.writes.run(()=>app.services.comms.db.$client.prepare("INSERT INTO boxes(id,name,owner,same_machine_as_loom,hosts_any,report_only,always_on,enrolled_at,revoked_at) VALUES('000-revoked-fixture','Old fictional box','alex',0,0,0,0,?,?)").run(example.createdAt,example.createdAt));
 const page={evaluate:async(_fn,{name,input,id})=>{const response=await fetch(app.url+'/api/'+name.replace('.','/'),{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({input,id})});return {status:response.status,body:await response.json()};}};
 const result=await conversationMail({page,app,clock,example,out:parent,open:async()=>{throw Error('Browser interaction intentionally excluded');}});
 for(const name of ['privateConversationBatch','nativeHandoff','conversationInboxIngress','conversationTempoDelivery','conversationSingleJob'])expect(result[name],JSON.stringify(result)).toMatchObject({ok:true,cleanup:{jobsStopped:true,credentialsRevoked:true}});
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});
