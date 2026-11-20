import Database from 'better-sqlite3';
import {it,expect} from 'vitest';
import {createDataSchema} from '../src/core/data/database.js';
import {members,tokens,signinLinks,projects,projectMembers} from '../src/core/data/schema.js';
import {accessAction,verifyAccessChange} from './rebuild-access-actions.mjs';
const at='2026-11-15T00:00:00.000Z';
async function fixture(title,mode){
 const client=new Database(':memory:'),db=createDataSchema(client,()=>at),a='a'.repeat(64),b='b'.repeat(64);
 try{
  for(const id of ['alex','robin'])db.insert(members).values({id,role:'member',joinedAt:at}).run();
  for(const [member,fingerprint]of [['alex',a],['robin',b]])db.insert(tokens).values({fingerprint,kind:'owner',member,label:member,createdAt:at}).run();
  if(title!=='Your account'){
   if(title==='Household setup'&&mode!=='missing-member')db.insert(members).values({id:'walkthrough-person',role:mode==='wrong-role'?'owner':'member',joinedAt:at}).run();
   else if(title==='Sharing'&&mode!=='missing-project'){
    db.insert(projects).values({id:'walkthrough-sharing',name:mode==='wrong-name'?'Wrong project':'Walkthrough sharing'}).run();
    if(mode!=='missing-membership')db.insert(projectMembers).values({project:'walkthrough-sharing',member:'alex'}).run();
    if(mode==='extra-membership')db.insert(projectMembers).values({project:'walkthrough-sharing',member:'robin'}).run();
   }
   try{verifyAccessChange(client,title);return {ok:true};}
   catch(error){return {ok:false,error:String(error)};}
  }
  let visible=false;
  const control={fill:async()=>{},check:async()=>{},waitFor:async()=>{},first:()=>control,isHidden:async()=>!visible,
   getByRole:(_role,options)=>button(options.name),getByLabel:()=>control};
  const button=name=>({...control,click:async()=>{
   if(name==='Make sign-in link'){
    visible=true;db.insert(signinLinks).values({id:'c'.repeat(64),token:mode==='wrong-link-member'?b:a,label:'Fixture',expiresAt:'2030-01-01T00:00:00.000Z'}).run();
   }else if(name==='Hide sign-in link'){if(mode!=='link-stays-visible')visible=false;}
  }});
  const tile={getByRole:(_role,options)=>button(options.name),getByText:()=>control,locator:()=>control};
  const page={waitForResponse:async()=>({ok:()=>true}),screenshot:async()=>{}};
  return await accessAction({page,tile,title,app:{services:{comms:{db:{$client:client}}}},out:'/unused'});
 }finally{client.close();}
}
it.each(['Your account','Household setup','Sharing'])('verifies successful persisted %s actions',async title=>{
 expect(await fixture(title,'valid')).toMatchObject({ok:true});
});
it.each([
 ['Your account','wrong-link-member','Link belongs to another member'],
 ['Your account','link-stays-visible','The delivered link stayed visible'],
 ['Household setup','missing-member','Member was not persisted'],
 ['Household setup','wrong-role','Member was not persisted'],
 ['Sharing','missing-project','Project was not persisted'],
 ['Sharing','wrong-name','Project was not persisted'],
 ['Sharing','missing-membership','Project membership was not persisted'],
 ['Sharing','extra-membership','Project membership was not persisted'],
])('refuses to count %s as success with %s',async(title,mode,error)=>{
 expect(await fixture(title,mode)).toMatchObject({ok:false,error:'Error: '+error});
});
