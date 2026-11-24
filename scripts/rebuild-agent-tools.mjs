import assert from 'node:assert/strict';
import {namedMemoryLifecycle} from './rebuild-named-memory.mjs';
import {withNamedTools} from './rebuild-named-tool-client.mjs';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export async function agentToolsEvidence(){
 return withFictionalMemoryHome(async ({connectAgent,issue,post,command})=>{
  return withNamedTools(connectAgent(),async call=>{
   const actions={};
   try{actions.namedMemoryLifecycle=await namedMemoryLifecycle({call,post});}
   catch(error){actions.namedMemoryLifecycle={ok:false,error:String(error)};}
   try{
    const path='orchard/shift',body='Water the fictional orchard after sunset.';
    await call('note_write',{path,body,lifespan:'short'});
    await call('note_write',{path:'workshop/shift',body:'Sort the example screws.',lifespan:'short'});
    assert.ok((await call('note_read',{path})).endsWith(body));
    const listed=await call('note_list',{prefix:'orchard/'});
    assert.match(listed,/orchard\/shift /);
    assert.doesNotMatch(listed,/workshop\/shift/);
    actions.namedNotes={ok:true,reason:'The agent wrote notes under two paths, read the exact body back, and listed only the note under the requested prefix.'};
   }catch(error){actions.namedNotes={ok:false,error:String(error)};}
   try{
    const title='Fictional orchard calibration',body='The fictional orchard uses a violet tensiometer.';
    const answer=await call('knowledge_write',{title,domain:'fixture',body});
    const slug=/^Wrote knowledge page (\S+)$/.exec(answer)?.[1];assert.ok(slug);
    await call('knowledge_write',{title:'Fictional workshop supplies',domain:'fixture',body:'The shelf holds screws.'});
    const found=await call('knowledge_recall',{query:'violet tensiometer',domain:'fixture'});
    assert.ok(found.includes(slug)&&found.includes(body));
    assert.doesNotMatch(found,/workshop supplies/);
    const page=await call('knowledge_read',{slug});assert.ok(page.includes(title)&&page.includes(body));
    actions.namedKnowledge={ok:true,reason:'The agent created two distinct pages, found the matching page by its text, and read its title and body by slug.'};
   }catch(error){actions.namedKnowledge={ok:false,error:String(error)};}
   try{
    const title='Fictional irrigation threshold', original='Water at 30 kPa.', edited='Water at 45 kPa.';
    const answer=await call('knowledge_write',{title,domain:'fixture',body:original,source:'https://example.invalid/irrigation'});
    const slug=/^Wrote knowledge page (\S+)$/.exec(answer)?.[1];assert.ok(slug);
    const read=async ()=>(await post('/graphql',{query:'query($slug:String!){memoryKnowledgePage(slug:$slug){body fresh checked{outcome} checkRevision history{id op}}}',variables:{slug}})).data.memoryKnowledgePage;
    await call('knowledge_edit',{slug,body:edited});
    const changed=await read();assert.equal(changed.body,edited);
    const earlier=changed.history.find(row=>row.op==='edit');assert.ok(earlier);
    await call('knowledge_check',{slug,outcome:'still-true',expectedRevision:changed.checkRevision});
    const verified=await read();assert.equal(verified.checked.outcome,'confirmed');assert.equal(verified.fresh,'fresh');
    await call('knowledge_check',{slug,outcome:'due-a-check',expectedRevision:verified.checkRevision});
    const due=await read();assert.equal(due.checked.outcome,'stale');assert.equal(due.fresh,'due');
    await call('knowledge_restore',{slug,revision:earlier.id});
    assert.equal((await read()).body,original);
    actions.namedKnowledgeHistory={ok:true,reason:'The agent edited a sourced page, confirmed its revision, marked it due for a check, and restored the original text. A separate read verified each change.'};
   }catch(error){actions.namedKnowledgeHistory={ok:false,error:String(error)};}
   try{
    const owner=issue({kind:'owner',member:'alex',label:'Fictional Knowledge owner'});
    const member=issue({kind:'owner',member:'robin',label:'Fictional non-owner Knowledge reader'});
    const agent=issue({kind:'agent',agent:'moss',label:'Fictional second terminal'});
    const title='Fictional shared seed inventory',domain='fixture',body='Six seed packets.';
    const {slug}=await command('mind/knowledgeAdd',{title,domain,body,source:''},owner);
    const read=async token=>(await post('/graphql',{query:'query($slug:String!){memoryKnowledgePage(slug:$slug){body}}',variables:{slug}},200,token)).data.memoryKnowledgePage;
    assert.deepEqual(await read(agent),{body});
    const finding='One more seed packet.';
    const revised=body+'\n\n'+finding;
    await command('mind/knowledgeAppend',{slug,body:finding},agent);
    assert.deepEqual(await read(owner),{body:revised});
    assert.ok((await call('knowledge_read',{slug})).includes(revised));
    assert.equal(await read(member),null);
    const refused=await post('/api/mind/knowledgeAppend',{id:crypto.randomUUID(),input:{slug,body:'Fictional refused edit'}},403,member);
    assert.equal(refused.ok,false);
    assert.deepEqual(await read(owner),{body:revised});
    actions.sharedKnowledgeAudience={ok:true,reason:'A household owner created the page, an agent terminal read it and appended a finding, and a second terminal and the owner read the revision. A non-owner member could neither read nor edit it.'};
   }catch(error){actions.sharedKnowledgeAudience={ok:false,error:String(error)};}
   return actions;
  });
 });
}
