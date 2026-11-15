/** Page controls against the normal disposable startup; SQL only verifies writes. */
import {join} from 'node:path';
export async function accessAction({page,tile,title,app,out}){
 const db=app.services.comms.db.$client;
 const screenshot=`action-${title==='Your account'?'account':title==='Household setup'?'household':'sharing'}.png`;
 const check=(value,message)=>{if(!value)throw Error(message);};
 const saved=async(path,click)=>{
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');void pending.catch(()=>{});
  await click();const response=await pending;check(response.ok(),'The visible control was refused');
 };
 try{
  if(title==='Your account'){
   const before=db.prepare('SELECT COUNT(*) AS n FROM signin_links').get().n;
   await saved('/api/signin/link',()=>tile.getByRole('button',{name:'Make sign-in link',exact:true}).click());
   await tile.locator('[data-signin-link]').waitFor();check(db.prepare('SELECT COUNT(*) AS n FROM signin_links').get().n===before+1,'No one-time sign-in link persisted');
   check(db.prepare('SELECT COUNT(*) AS n FROM signin_links l JOIN tokens t ON t.fingerprint=l.token WHERE t.member=?').get('alex').n===before+1,'Link belongs to another member');
   // Never put the delivered credential into evidence or screenshots.
   await tile.getByRole('button',{name:'Hide sign-in link',exact:true}).click();await tile.locator('[data-signin-link]').waitFor({state:'hidden'});
  }else if(title==='Household setup'){
   const form=tile.getByRole('form',{name:'Add member',exact:true});await form.getByRole('textbox',{name:'Member name',exact:true}).fill('walkthrough-person');
   await saved('/api/household/setMember',()=>form.getByRole('button',{name:'Add member',exact:true}).click());
   await tile.getByRole('form',{name:'Save member walkthrough-person',exact:true}).waitFor();
   check(db.prepare('SELECT role FROM members WHERE id=?').get('walkthrough-person')?.role==='member','Member was not persisted');
  }else if(title==='Project sharing'){
   await tile.getByRole('button',{name:'New project',exact:true}).click();
   const form=tile.getByRole('form',{name:'Create project',exact:true});await form.getByLabel('Slug',{exact:true}).fill('walkthrough-sharing');await form.getByLabel('Name',{exact:true}).fill('Walkthrough sharing');
   await form.getByRole('checkbox',{name:'alex',exact:true}).check();
   await saved('/api/household/setProject',()=>form.getByRole('button',{name:'Create project',exact:true}).click());
   await tile.getByText('Walkthrough sharing',{exact:true}).first().waitFor();
   check(db.prepare('SELECT name FROM projects WHERE id=?').get('walkthrough-sharing')?.name==='Walkthrough sharing','Project was not persisted');
   check(db.prepare('SELECT member FROM project_members WHERE project=?').all('walkthrough-sharing').some(row=>row.member==='alex'),'Project membership was not persisted');
  }else throw Error('Unknown access page');
  await page.screenshot({path:join(out,screenshot),fullPage:true});return {ok:true,screenshot};
 }catch(error){
  // The Account may still contain a delivered link after a failed hide.
  if(title!=='Your account')await page.screenshot({path:join(out,screenshot),fullPage:true}).catch(()=>{});
  return {ok:false,error:String(error),...(title==='Your account'?{}:{screenshot})};
 }
}
