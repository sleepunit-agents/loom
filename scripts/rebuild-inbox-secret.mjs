import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const irrigation = 'walkthrough-irrigation';

export async function inboxSecretRequest({app,page,tile,out,clock}) {
  const name=irrigation, id=randomUUID(), why='Read the fictional irrigation schedule.';
  const db=app.services.comms.db.$client;
  // Only catalog metadata is needed to test the pending request and its denial.
  const credential=app.writes.run(()=>{
    const at=new Date().toISOString();
    db.prepare('INSERT INTO secrets(name,description,changed_at,changed_by) VALUES(?,?,?,?)').run(name,'Fictional irrigation controller',at,'alex');
    db.prepare('INSERT INTO secret_changes(id,secret,action,by,at) VALUES(?,?,?,?,?)').run(randomUUID(),name,'add','alex',at);
    app.services.secrets.requests.setRule({secret:name,answer:'ask',minutes:7,agents:[{agent:'fern',when:'on_request'}]});
    return app.services.signin.issue({kind:'agent',agent:'fern',label:'Fictional irrigation request'});
  }).value;
  try {
    const response=await fetch(new URL('/api/secrets/request',app.url),{method:'POST',
      headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},
      body:JSON.stringify({id:randomUUID(),input:{id,secret:name,why,minutes:7,scope:'agent'}})});
    assert.equal(response.status,200);
    const items=db.prepare('SELECT id,state FROM inbox WHERE source=? AND source_id=? AND to_kind=? AND "to"=?').all('secret-request',id,'person','alex');
    assert.equal(items.length,1);
    assert.equal(items[0].state,'waiting');
    const instructions='Continue the fictional irrigation check.';
    const trigger=app.writes.run(()=>app.services.tempo.triggers.set({
      ownerKind:'agent',owner:'fern',sourceKind:'answer',watches:'secret-request:'+id,
      lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fern',instructions,note:'Wait for the irrigation request.',
    })).value;
    const resumes=()=>db.prepare("SELECT i.id,i.[to] recipient FROM inbox i JOIN inbox_refs r ON r.item=i.id WHERE i.source='trigger' AND r.ref=?").all(trigger.id);
    clock.advance(0);
    assert.deepEqual(resumes(),[]);
    const back=tile.locator('.loom-split__back:visible');
    if(await back.count())await back.click();
    await tile.getByRole('button',{name:/^Needs you(?:\s|$)/}).first().click();
    await tile.getByLabel('Search asks',{exact:true}).fill('');
    await tile.locator('[data-split-row]:visible').filter({hasText:name}).click();
    await tile.getByText(why,{exact:true}).first().waitFor();
    const screenshot='action-inboxSecretRequest.png';
    await page.screenshot({path:join(out,screenshot),fullPage:true});
    await tile.getByRole('button',{name:'Open in Secrets',exact:true}).first().click();
    const settings=page.getByRole('region',{name:'Settings tile',exact:true});
    const deny=settings.getByRole('button',{name:'Deny',exact:true});
    await deny.waitFor();
    assert.equal(new URL(page.url()).pathname,'/p/settings-preview/requests/'+id);
    const [answered]=await Promise.all([
      page.waitForResponse(r=>new URL(r.url()).pathname==='/api/secrets/command'&&r.request().method()==='POST'),
      deny.click(),
    ]);
    assert.equal(answered.status(),200);
    assert.deepEqual(db.prepare('SELECT state,answered_by FROM secret_requests WHERE id=?').get(id),{state:'denied',answered_by:'alex'});
    assert.equal(db.prepare('SELECT state FROM inbox WHERE id=?').get(items[0].id).state,'resolved');
    clock.advance(0);
    const delivered=resumes();
    assert.equal(delivered.length,1);
    assert.equal(delivered[0].recipient,'fern');
    assert.equal(app.services.conversations.item(delivered[0].id).words,instructions);
    clock.advance(1);
    app.services.tempo.triggers.tick();
    assert.deepEqual(resumes(),delivered);
    return {ok:true,screenshot,reason:'A pending request arrived once for Alex, displayed its reason, and opened the matching Settings request. Denying it there resolved the original Inbox item and delivered one continuation to Fern.'};
  } finally {
    app.writes.run(()=>app.services.signin.revoke(credential.fingerprint));
  }
}

// The preceding Inbox exercise leaves the irrigation catalog entry and its Ask rule in place.
export async function settingsGrant({app,page}) {
  const id=randomUUID(), why='Review the fictional morning schedule.';
  app.writes.run(()=>app.services.secrets.requests.request({id,secret:irrigation,agent:'fern',why,minutes:7}));
  await page.goto(new URL('/p/settings-preview/',app.url).href);
  const settings=page.getByRole('region',{name:'Settings tile',exact:true});
  await settings.getByText(irrigation,{exact:true}).first().waitFor();
  await settings.getByRole('button',{name:/^Requests/}).click();
  await settings.locator('[data-split-row]').filter({hasText:why}).click();
  await settings.getByText(why,{exact:true}).first().waitFor();
  await settings.getByRole('button',{name:'Allow',exact:true}).click();
  await settings.getByText('allowed · 7 minutes',{exact:true}).waitFor();
  const grant=()=>app.services.secrets.requests.grantFor(irrigation,'fern',undefined,id);
  assert.equal(grant()?.grantedBy,'alex');
  await settings.getByRole('button',{name:/^Grants/}).click();
  await settings.getByText('fern: '+irrigation,{exact:true}).click();
  const revoke=settings.getByRole('button',{name:'Revoke grant',exact:true});
  await revoke.waitFor();
  const grantUrl=page.url();
  assert.equal(decodeURIComponent(new URL(grantUrl).pathname.split('/').at(-1)),grant().id);
  await page.reload();
  await revoke.waitFor();
  assert.equal(page.url(),grantUrl);
  const [receipt]=await Promise.all([
    page.waitForResponse(r=>new URL(r.url()).pathname==='/api/secrets/command'&&r.request().method()==='POST'),
    revoke.click(),
  ]);
  assert.equal((await receipt.json()).ok,true);
  assert.equal(grant(),undefined);
  return {ok:true,reason:'The owner found the catalog entry and opened the pending request in Settings, allowed it, found the resulting agent-wide grant, reloaded it and revoked it.'};
}
