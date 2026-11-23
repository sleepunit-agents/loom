import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

export async function inboxSecretRequest({app,page,tile,out}) {
  const name='walkthrough-irrigation', id=randomUUID(), why='Read the fictional irrigation schedule.';
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
    return {ok:true,screenshot,reason:'A pending request arrived once for Alex, displayed its reason, and opened the matching Settings request. Denying it there resolved the original Inbox item.'};
  } finally {
    app.writes.run(()=>app.services.signin.revoke(credential.fingerprint));
  }
}
