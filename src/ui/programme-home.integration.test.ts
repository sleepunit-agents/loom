/** Normal empty-home startup and real browser controls; CI alone launches Chrome. */
import {it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium,type Browser} from 'playwright-core';
import type {startSharedHome} from '../shared-startup.js';
import {maskCredentialScreenshots} from '../../scripts/rebuild-credential-evidence.mjs';
const enabled=process.env.LOOM_PROGRAM_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))||!existsSync(resolve('dist/shared-startup.js'))))throw Error('Programme evidence requires Chrome and the built app');
it.runIf(enabled)('normal-home owners create use edit clear and revoke a narrow programme through the real browser',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-programme-home-')),out=join(process.env.LOOM_TEST_SHOTS??resolve('artifacts'),'programme-access');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined,browser:Browser|undefined,link='';const errors:unknown[]=[],diagnostics:string[]=[],expiry=new Date(Date.now()+3600_000).toISOString();let failed=false;
 const safeError=(error:unknown)=>Error(String(error).replace(/loom_[A-Za-z0-9_-]+/g,'[token redacted]').replace(/\/login\/[^\s"'<>\)]+/g,'/login/[redacted]'));
 const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
 try{
  mkdirSync(out,{recursive:true});vi.stubEnv('LOOM_WORKER_SOCKET',undefined);vi.stubEnv('LOOM_PUBLIC_URL',undefined);
  // The production holder forks an adjacent .js entry with no loader flags.
  // Use the built backend so this proof exercises that actual child process.
  const {startSharedHome}=await import('../../dist/shared-startup.js');
  app=await startSharedHome({home,webRoot,host:'127.0.0.1',port:0,stdout:()=>{},reportError:error=>errors.push(error)});link=app.signinLink();
  const current=app,db=current.services.comms!.db.$client,owner=(db.prepare("SELECT id FROM members WHERE role='owner'").get() as {id:string}).id;
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===current.url?route.continue():route.abort('blockedbyclient'));
  await context.routeWebSocket(url=>new URL(url).origin!==current.url.replace(/^http/,'ws'),socket=>socket.close());
  const page=await context.newPage();maskCredentialScreenshots(page);page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error));page.on('console',message=>diagnostics.push(message.text()));
  await page.goto(link);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('.next-shell').waitFor();check((await context.request.post(link)).status()===401,'Startup sign-in link could be reused');await page.goto(current.url+'/p/setup-preview');
  const acceptedPost=async(path:string,click:()=>Promise<unknown>)=>{const pending=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST');void pending.catch(()=>{});await click();check((await pending).ok(),'Visible owner control was refused');};
  const form=page.getByRole('form',{name:'Create token',exact:true});await expect.poll(()=>form.locator('option[value="program"]').isDisabled()).toBe(false);await form.getByRole('combobox',{name:'Identity',exact:true}).selectOption('program');await form.getByRole('textbox',{name:'Token label',exact:true}).fill('Normal-home programme');await form.getByRole('combobox',{name:'Member',exact:true}).selectOption(owner);
  await form.getByRole('checkbox',{name:'tasks',exact:true}).check();await form.getByRole('checkbox',{name:'tasks.command',exact:true}).check();await form.getByRole('textbox',{name:'Expires (optional ISO time)',exact:true}).fill(expiry);
  await acceptedPost('/api/signin/program',()=>form.getByRole('button',{name:'Create token',exact:true}).click());const value=page.getByLabel('Token value',{exact:true});await value.waitFor();const raw=(await value.textContent())!;check(/^loom_[A-Za-z0-9_-]{43}$/.test(raw),'No valid one-time programme credential');await page.getByRole('button',{name:'Hide token',exact:true}).click();await value.waitFor({state:'hidden'});
  check(!(await page.evaluate(secret=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(secret),raw)),'Raw programme credential entered browser storage');
  const fingerprint=createHash('sha256').update(raw).digest('hex');check(current.services.programSetup!.list().some(token=>token.fingerprint===fingerprint&&token.member===owner&&token.expiresAt===expiry),'Programme identity or expiry was not persisted');
  const call=(path:string,input:unknown)=>fetch(current.url+path,{method:'POST',redirect:'error',cache:'no-store',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify(input)});
  const query=async(source:string)=>(await call('/graphql',{query:source})).json();check((await query('{ tasks { id } }')).data?.tasks?.length===0,'Allowed task records unavailable');check((await query('{ projects { id } }')).errors?.length,'Ungranted record type escaped');
  const command={id:randomUUID(),input:{action:'create',input:{title:'Programme-created task',goal:'Exercise the granted operation',why:'Fictional programme proof',owner:{kind:'member',id:owner}}}};
  const created=await call('/api/tasks/command',command),task=await created.json();check(created.ok&&task.ok===true&&task.value?.id,'Granted task operation failed');check((await query('{ tasks { title } }')).data?.tasks?.some((row:{title:string})=>row.title==='Programme-created task'),'Programme could not read its created task');
  check((await call('/api/program/setGrants',{id:randomUUID(),input:{fingerprint,records:['projects'],operations:[]}})).status===403,'Owner-subject programme administered grants');check((await call('/api/signin/program',{member:owner,label:'Forbidden self issue',records:[],operations:[]})).status===403,'Programme issued another credential');
  const grants=page.getByRole('form',{name:'Save grants for Normal-home programme',exact:true});await grants.getByRole('checkbox',{name:'tasks',exact:true}).uncheck();await grants.getByRole('checkbox',{name:'tasks.command',exact:true}).uncheck();await acceptedPost('/api/program/setGrants',()=>grants.getByRole('button',{name:'Save program grants',exact:true}).click());
  check((db.prepare('SELECT COUNT(*) AS n FROM program_tokens WHERE token=?').get(fingerprint) as {n:number}).n===1,'Clearing grants removed the restriction marker');check((await query('{ tasks { id } }')).errors?.length,'Cleared programme still read tasks');check((await call('/api/tasks/command',command)).status===403,'Cleared programme replayed a cached operation');
  await page.reload();await grants.getByRole('button',{name:'Save program grants',exact:true}).waitFor();check(!(await grants.getByRole('checkbox',{name:'tasks',exact:true}).isChecked()),'Cleared grants did not survive browser reload');
  await grants.getByRole('checkbox',{name:'tasks',exact:true}).check();await grants.getByRole('checkbox',{name:'tasks.command',exact:true}).check();await acceptedPost('/api/program/setGrants',()=>grants.getByRole('button',{name:'Save program grants',exact:true}).click());check((await query('{ tasks { id } }')).data?.tasks?.length===1,'Updated grants did not restore the selected access');
  const tokenRow=page.getByRole('heading',{name:'Normal-home programme',level:4,exact:true}).locator('..');await acceptedPost('/api/token/revoke',()=>tokenRow.getByRole('button',{name:'Revoke token',exact:true}).click());check((await call('/graphql',{query:'{ tasks { id } }'})).status===403,'Revoked programme retained access');check(!db.serialize().includes(Buffer.from(raw)),'Raw programme credential persisted in SQLite');
  check(!(await page.evaluate(secret=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(secret),raw)),'Raw programme credential persisted in browser storage');check(!diagnostics.some(message=>message.includes(raw)),'Raw programme credential entered browser diagnostics');
  await expect.poll(()=>grants.getByRole('button',{name:'Save program grants',exact:true}).isDisabled()).toBe(true);expect(await value.count()).toBe(0);expect(errors).toEqual([]);await page.screenshot({path:join(out,'programme-controls.png'),fullPage:true});
  writeFileSync(join(out,'proof.json'),JSON.stringify({normalEmptyHome:true,realSignin:true,createdInBrowser:true,restrictedReads:true,grantedOperation:true,selfAdministrationRefused:true,clearedMarkerRetained:true,editedAccessRestored:true,revoked:true,rawHidden:true,rawNeverPersisted:true,rawNeverStoredInBrowser:true,rawAbsentFromBrowserDiagnostics:true},null,2));
 }catch(error){failed=true;throw safeError(error);}
 finally{let cleanupError:unknown;for(const close of [()=>browser?.close(),()=>app?.close(),()=>rmSync(home,{recursive:true,force:true}),()=>vi.unstubAllEnvs()]){try{await close();}catch(error){cleanupError??=error;}}if(cleanupError&&!failed)throw safeError(cleanupError);}
});
