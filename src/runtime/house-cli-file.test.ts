import {afterEach,expect,it} from 'vitest';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareHouseCli} from './house-cli-file.js';
import {BODY_PROGRAM_TARGET,HOUSE_CLI_FILE,houseCliSource,bodyMounts} from './worker-mounts.js';

const roots:string[]=[];
function stateDir() {
  const state=mkdtempSync(join(realpathSync(tmpdir()),'loom-cli-state-'));
  roots.push(state);
  return state;
}
afterEach(()=>{for(const state of roots.splice(0))rmSync(state,{recursive:true,force:true});});

it('publishes only the fixed launcher bytes in private worker state, including on a second start',()=>{
  const state=stateDir();
  for(let run=0;run<2;run++){
    prepareHouseCli(state);
    const path=houseCliSource(state);
    expect(readFileSync(path,'utf8')).toBe(`#!/bin/sh\nexec ${BODY_PROGRAM_TARGET}/${HOUSE_CLI_FILE} "$@"\n`);
    expect(statSync(path).mode & 0o777).toBe(0o555);
    expect(readdirSync(state)).toHaveLength(1);
  }
});

it('refuses a shared state directory before creating a launcher',()=>{
  const state=stateDir();
  chmodSync(state,0o750);
  expect(()=>prepareHouseCli(state)).toThrow();
  expect(readdirSync(state)).toEqual([]);
});

it('preserves any existing file at the reserved name and refuses a configured credential there',()=>{
  const state=stateDir(),path=houseCliSource(state);
  writeFileSync(path,'existing fixture',{mode:0o600});
  expect(()=>prepareHouseCli(state)).toThrow();
  expect(readFileSync(path,'utf8')).toBe('existing fixture');
  const program=stateDir();
  expect(()=>bodyMounts({program,state,tokenFile:path})).toThrow();
  expect(()=>bodyMounts({program,state,configFile:path})).toThrow();
});

it('refuses private state under a writable non-sticky parent before publishing a file',()=>{
  const parent=stateDir(),state=join(parent,'worker');
  mkdirSync(state,{mode:0o700});chmodSync(parent,0o777);
  expect(()=>prepareHouseCli(state)).toThrow();
  expect(readdirSync(state)).toEqual([]);
});
