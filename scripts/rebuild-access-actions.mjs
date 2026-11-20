/** Page controls against the normal disposable startup; SQL only verifies writes. */
import {join} from 'node:path';
const check=(value,message)=>{if(!value)throw Error(message);};
const activate=async button=>{await button.focus();await button.press('Enter');};

export function verifyAccessChange(db,title){
 if(title==='Household setup'){
  check(db.prepare('SELECT role FROM members WHERE id=?').get('walkthrough-person')?.role==='member','Member was not persisted');
 }else{
  check(db.prepare('SELECT name FROM projects WHERE id=?').get('walkthrough-sharing')?.name==='Walkthrough sharing','Project was not persisted');
  check(db.prepare('SELECT member FROM project_members WHERE project=?').all('walkthrough-sharing').map(row=>row.member).sort().join(',')==='alex','Project membership was not persisted');
 }
}

// Play the fictional agent in the disposable home. The owner sends the request
// and answers the resulting card in the actual signed-in browser.
async function approveRequestedChange({page,app,composer,change,input,expectedWords}){
 const db=app.services.comms.db.$client;
 const words=await composer.getByRole('textbox',{name:/^Message\b/}).inputValue();
 check(expectedWords(words),'The prepared message differs from the requested change');
 const sent=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/comms/send'&&r.request().method()==='POST',{timeout:6000});
 void sent.catch(()=>{});
 await activate(composer.getByRole('button',{name:'Send',exact:true}));
 const response=await sent,body=await response.json();
 check(response.ok()&&body.ok,'Request was not delivered');
 const {thread,seq}=body.value;
 await page.getByRole('region',{name:'Comms tile',exact:true}).getByText(words,{exact:true}).waitFor();
 const deliveries=db.prepare("SELECT i.[to] agent,i.conversation,c.member FROM inbox i JOIN conversations c ON c.id=i.conversation WHERE i.thread=? AND i.message_seq=? AND i.to_kind='agent'").all(thread,seq);
 check(deliveries.length===1&&deliveries[0].member==='alex','Expected one private delivery from the example owner');
 const {agent,conversation,member}=deliveries[0];
 const card=app.writes.run(()=>app.services.setup.propose(agent,{change,input,why:'Fictional request from the example owner.'},{conversation,member,project:null})).value;
 check(card.state==='pending','The fictional setting did not wait for approval');
 const exists=change==='project'?'SELECT id FROM projects WHERE id=?':'SELECT id FROM members WHERE id=?';
 check(!db.prepare(exists).get(input.id),'The change took effect before approval');
 await page.goto(new URL('/p/approvals-preview/approval/'+encodeURIComponent(card.id),app.url).href);
 const answer=page.getByRole('region',{name:'Approvals tile',exact:true}).getByRole('group',{name:'Answer approval',exact:true});
 const receipt=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals/answer'&&r.request().method()==='POST',{timeout:6000});
 void receipt.catch(()=>{});
 await activate(answer.getByRole('button',{name:'Allow',exact:true}));
 const result=await receipt;
 check(result.ok()&&(await result.json()).ok&&app.services.approvals.get(card.id).state==='used','Approval did not apply the setting');
}

export async function accessAction({page,tile,title,app,out}){
 const db=app.services.comms.db.$client;
 const screenshot=`action-${title==='Your account'?'account':title==='Household setup'?'household':'sharing'}.png`;
 const saved=async(path,click)=>{
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');void pending.catch(()=>{});
  await click();const response=await pending;check(response.ok(),'The visible control was refused');
 };
 try{
  if(title==='Your account'){
   const before=db.prepare('SELECT COUNT(*) AS n FROM signin_links').get().n;
   const ownBefore=db.prepare('SELECT COUNT(*) AS n FROM signin_links l JOIN tokens t ON t.fingerprint=l.token WHERE t.member=?').get('alex').n;
   await saved('/api/signin/link',()=>tile.getByRole('button',{name:'Make sign-in link',exact:true}).click());
   await tile.locator('[data-signin-link]').waitFor();check(db.prepare('SELECT COUNT(*) AS n FROM signin_links').get().n===before+1,'No one-time sign-in link persisted');
   check(db.prepare('SELECT COUNT(*) AS n FROM signin_links l JOIN tokens t ON t.fingerprint=l.token WHERE t.member=?').get('alex').n===ownBefore+1,'Link belongs to another member');
   // Never put the delivered credential into evidence or screenshots.
   await tile.getByRole('button',{name:'Hide sign-in link',exact:true}).click();await tile.locator('[data-signin-link]').waitFor({state:'hidden'});
   check(await tile.locator('[data-signin-link]').isHidden(),'The delivered link stayed visible');
  }else if(title==='Household setup'){
   const originalUrl=page.url();
   const form=tile.getByRole('form',{name:'Add member',exact:true});await form.getByRole('textbox',{name:'Member name',exact:true}).fill('walkthrough-person');
   await activate(form.getByRole('button',{name:'Request new member',exact:true}));
   await approveRequestedChange({page,app,composer:form.locator('..'),change:'member',input:{id:'walkthrough-person',role:'member',fullOwner:false,agents:[]},
    expectedWords:words=>words==='Please propose adding household member walkthrough-person with the member role. Own every agent: no. Assigned agents: none.'});
   verifyAccessChange(db,title);
   await page.goto(originalUrl);
   await tile.getByRole('form',{name:'Save member walkthrough-person',exact:true}).waitFor();
  }else if(title==='Sharing'){
   await tile.getByRole('button',{name:'New project',exact:true}).click();
   const form=tile.getByRole('form',{name:'Create project',exact:true});await form.getByLabel('Slug',{exact:true}).fill('walkthrough-sharing');await form.getByLabel('Name',{exact:true}).fill('Walkthrough sharing');
   await form.getByRole('checkbox',{name:'alex',exact:true}).check();
   const originalUrl=page.url(),input={id:'walkthrough-sharing',name:'Walkthrough sharing',members:['alex'],agents:[],repositories:[]};
   await activate(form.getByRole('button',{name:'Review new project',exact:true}));
   await approveRequestedChange({page,app,composer:tile.getByRole('region',{name:'Project change request'}),change:'project',input,
    expectedWords:words=>words.startsWith('Please propose creating')&&JSON.stringify(JSON.parse(words.slice(words.indexOf('{'))))===JSON.stringify(input)});
   verifyAccessChange(db,title);
   await page.goto(originalUrl);
   await tile.getByText('Walkthrough sharing',{exact:true}).first().waitFor();
  }else throw Error('Unknown access page');
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {ok:true,screenshot};
 }catch(error){
  // The Account may still contain a delivered link after a failed hide.
  if(title!=='Your account')await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,error:String(error),...(title==='Your account'?{}:{screenshot})};
 }
}
