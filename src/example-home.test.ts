import Database from 'better-sqlite3';
import * as roots from './shared-root.js';
import {Operations} from './core/operations/index.js';
import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome,runExampleHome} from './example-home.js';
import {startSharedHome} from './shared-startup.js';
afterEach(()=>vi.restoreAllMocks());
it('builds fictitious data through services, then normal startup signs in and queries it',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-test-')),home=join(parent,'home');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const made:ReturnType<typeof roots.sharedRoot>[]=[],make=roots.sharedRoot;
  vi.spyOn(roots,'sharedRoot').mockImplementation(options=>{const root=make(options);vi.spyOn(root.http,'request');made.push(root);return root;});
  const output:string[]=[],errors:string[]=[];
  expect(await runExampleHome([],text=>output.push(text),text=>errors.push(text))).toBe(2);
  expect(await runExampleHome([home],text=>output.push(text),text=>errors.push(text))).toBe(0);
  expect(errors.join(' ')).not.toContain('loom_');
  const manifest=JSON.parse(output[0]);
  expect(made.some(root=>vi.mocked(root.http.request).mock.calls.some(([path,init])=>path==='http://example/api/runtime/accountCreate'&&init?.method==='POST'&&JSON.parse(String(init.body)).id==='example-account'))).toBe(true);
  expect(statSync(join(home,'comms.key')).mode & 0o077).toBe(0);
  const database=new Database(join(home,'app.db'),{readonly:true});
  try{expect(database.prepare("select member,revoked_at,expires_at,created_at from tokens where label='Example setup'").get()).toEqual({member:'alex',revoked_at:expect.any(String),expires_at:expect.any(String),created_at:expect.any(String)});
  const setup=database.prepare("select created_at,expires_at from tokens where label='Example setup'").get() as {created_at:string;expires_at:string};expect(Date.parse(setup.expires_at)-Date.parse(setup.created_at)).toBe(60_000);
  expect(database.prepare('select id,owner from model_accounts').all()).toEqual([{id:manifest.account.id,owner:'alex'}]);
  expect(database.prepare("select operation,id from operation_results where id='example-account'").get()).toEqual({operation:'runtime.accountCreate',id:'example-account'});}finally{database.close();}
  expect(readFileSync(join(home,'program.json'),'utf8')).not.toContain('loom_');expect(JSON.stringify(manifest)).not.toContain('loom_');expect(readFileSync(join(home,'example.json'),'utf8')).not.toContain('loom_');
  expect(manifest.tasks).toHaveLength(4);expect(manifest.gaps.map((g:{page:string})=>g.page)).toEqual(['machines']);
  const before=readFileSync(join(home,'app.db'));
  await expect(exampleHome(home)).rejects.toThrow();expect(readFileSync(join(home,'app.db'))).toEqual(before);
  mkdirSync(join(parent,'public'));writeFileSync(join(parent,'public','next.html'),'<main>Example entry</main>');
  let link='';app=await startSharedHome({home,webRoot:join(parent,'public'),port:0,stdout:text=>{link=text.trim();}});
  const response=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});
  expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  const query=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id title status } approvals { id state } changes { id project agent } triggers { id } modelAccounts { ... on RuntimeAccountDetail { id label } } }'})});
  const result=await query.json();expect(result.errors).toBeUndefined();
  expect(result.data.tasks).toHaveLength(4);expect(result.data.tasks.map((t:{status:string})=>t.status)).toContain('in_progress');
  expect(result.data.approvals).toEqual([expect.objectContaining({state:'pending'})]);
  expect(result.data.changes).toEqual([{id:manifest.change,project:'garden',agent:'fern'}]);
  const token=app.writes.run(()=>app!.services.signin.issue({kind:'owner',member:'robin',label:'Fictitious sharing proof'})).value;
  try{
   const read=async()=>{const response=await app!.http.request(app!.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token.token,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id } changes { id project agent } approvals { id } }'})});return response.json();};
   expect(await read()).toEqual({data:{tasks:manifest.tasks.map((id:string)=>({id})),changes:[{id:manifest.change,project:'garden',agent:'fern'}],approvals:[]}});
   app.writes.run(()=>app!.services.household.setProject({id:'garden',name:'Example garden',members:['alex'],agents:['fern','moss'],repositories:['example-house/garden']}));
   expect(await read()).toEqual({data:{tasks:[],changes:[],approvals:[]}});
  }finally{app.writes.run(()=>app!.services.signin.revoke(token.fingerprint));}
  expect(result.data.modelAccounts).toEqual([expect.objectContaining({label:'Example model subscription'})]);
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});

it('revokes the temporary setup credential when the outside operation fails',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-failed-')),home=join(parent,'home');
 vi.spyOn(Operations.prototype,'callAsync').mockResolvedValue({ok:false,code:'denied',message:'Fixture refusal'});
 try{
  await expect(exampleHome(home)).rejects.toThrow('Example account could not be created through its API');
  const database=new Database(join(home,'app.db'),{readonly:true});
  try{expect(database.prepare("select revoked_at,expires_at from tokens where label='Example setup'").get()).toEqual({revoked_at:expect.any(String),expires_at:expect.any(String)});expect(database.prepare('select count(*) as n from model_accounts').get()).toEqual({n:0});}finally{database.close();}
 }finally{rmSync(parent,{recursive:true,force:true});}
});
