import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome,runExampleHome} from './example-home.js';
import {startSharedHome} from './shared-startup.js';
it('builds fictitious data through services, then normal startup signs in and queries it',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-test-')),home=join(parent,'home');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const output:string[]=[],errors:string[]=[];
  expect(await runExampleHome([],text=>output.push(text),text=>errors.push(text))).toBe(2);
  expect(await runExampleHome([home],text=>output.push(text),text=>errors.push(text))).toBe(0);
  const manifest=JSON.parse(output[0]);
  expect(statSync(join(home,'comms.key')).mode & 0o077).toBe(0);
  expect(manifest.tasks).toHaveLength(4);expect(manifest.gaps.map((g:{page:string})=>g.page)).toEqual(['people','machines']);
  const before=readFileSync(join(home,'app.db'));
  await expect(exampleHome(home)).rejects.toThrow();expect(readFileSync(join(home,'app.db'))).toEqual(before);
  mkdirSync(join(parent,'public'));writeFileSync(join(parent,'public','next.html'),'<main>Example entry</main>');
  let link='';app=await startSharedHome({home,webRoot:join(parent,'public'),port:0,stdout:text=>{link=text.trim();}});
  const response=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});
  expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  const query=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id title status } approvals { id state } triggers { id } modelAccounts { ... on RuntimeAccountDetail { id label } } }'})});
  const result=await query.json();expect(result.errors).toBeUndefined();
  expect(result.data.tasks).toHaveLength(4);expect(result.data.tasks.map((t:{status:string})=>t.status)).toContain('in_progress');
  expect(result.data.approvals).toEqual([expect.objectContaining({state:'pending'})]);
  expect(result.data.modelAccounts).toEqual([expect.objectContaining({label:'Example model subscription'})]);
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});
