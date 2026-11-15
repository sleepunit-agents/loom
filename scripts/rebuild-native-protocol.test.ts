import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {prepareAcceptanceHome} from './rebuild-acceptance-adapter.mjs';
import {nativeProtocolSmoke} from './rebuild-native-protocol.mjs';
it('claims and runs the real queued private and public jobs through normal worker/body factories',{timeout:20_000},async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-native-protocol-')),home=join(parent,'home');let app;const errors:string[]=[];
 try{
  const example=await exampleHome(home);await prepareAcceptanceHome(home);const clock=new FakeClock(Date.parse(example.createdAt));
  app=await startSharedHome({home,port:0,clock,stdout:()=>{},reportError:error=>errors.push(String(error).replace(/(?:body|loom)_[a-zA-Z0-9_-]{32,}/g,'[credential]'))});
  let result;try{result=await nativeProtocolSmoke({app,example,clock,home});}catch(error){throw Error(String(error)+' Root diagnostics: '+JSON.stringify(errors));}expect(result.runs).toHaveLength(2);
  expect(result.runs.every(row=>row.running&&row.hadInput&&row.state==='done'&&row.bootstrapErased)).toBe(true);
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});
